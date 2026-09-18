import { exec } from 'child_process';
import net from 'net';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import log from './logger.js';
import config from '../config/config.js';

class WarpManager {
  constructor() {
    this.lastRestartTime = 0;
    this.cooldownMs = 60 * 1000; // 60秒冷却时间，防止频繁重启
    this.isRestarting = false;

    // 代理健康检查（定期探测 40000 端口连通性）
    this.healthTimer = null;
    this.healthFailureCount = 0;

    // 后台任务网络失败上报（滑动窗口计数，快速自愈）
    this.failureWindowStart = 0;
    this.failureWindowCount = 0;
  }

  /**
   * 当前是否通过 WARP 的本地 SOCKS5 代理出口（127.0.0.1:40000）
   * 只有这种配置下，WARP 自愈动作才有意义
   * @returns {boolean}
   */
  isWarpProxyConfigured() {
    const proxy = typeof config.proxy === 'string' ? config.proxy.trim().toLowerCase() : '';
    return proxy === 'socks5://127.0.0.1:40000'
      || proxy === 'socks5h://127.0.0.1:40000'
      || proxy === 'socks5://localhost:40000';
  }

  /**
   * 自动重启开关（后台「网络异常自动重启换 IP」开关，默认开启）
   * @returns {boolean}
   */
  isAutoRestartEnabled() {
    return config.warp?.autoRestart !== false;
  }

  /**
   * 等待端口进入监听状态
   * @param {number} port
   * @param {number} timeoutMs
   * @param {number} intervalMs
   * @returns {Promise<boolean>}
   */
  async waitForPort(port = 40000, timeoutMs = 15000, intervalMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.checkPort(port, '127.0.0.1')) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  /**
   * 给 Promise 加超时保护，超时返回兜底值（避免启动流程被卡死）
   * @param {Promise} promise
   * @param {number} timeoutMs
   * @param {*} fallback
   * @returns {Promise<*>}
   */
  _withTimeout(promise, timeoutMs, fallback) {
    return Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise(resolve => setTimeout(() => resolve(fallback), timeoutMs))
    ]);
  }

  /**
   * 服务启动自愈：面板/服务每次重启后，主动执行一次 WARP 重启换 IP。
   * 目的：避免服务启动时 WARP 已掉线，导致 Token 刷新 / 积分同步 / 额度同步 / 遥测请求全部失败，
   *      必须人工打开面板点“重启”才能恢复。
   * 可用 config.json 中 warp.restartOnStartup = false 关闭。
   * @returns {Promise<boolean>} 启动自愈后代理端口是否就绪
   */
  async restartOnStartup() {
    if (!this.isWarpProxyConfigured()) {
      log.info('[WARP] 未配置 WARP SOCKS5 代理 (127.0.0.1:40000)，跳过启动自愈');
      return false;
    }
    if (!this.isAutoRestartEnabled()) {
      log.info('[WARP] 网络异常自动重启已关闭，跳过启动自愈');
      return false;
    }
    if (config.warp?.restartOnStartup === false) {
      log.info('[WARP] 启动自愈已在配置中关闭 (warp.restartOnStartup = false)');
      return false;
    }

    log.info('[WARP] 服务启动自愈：主动执行一次 WARP 重启换 IP ...');
    try {
      // 等待预算：超过则由后台继续接管，避免服务启动被长时间阻塞
      const restartPromise = this.restartWarp('服务启动自愈（面板重启后主动换 IP）');
      const restarted = await this._withTimeout(restartPromise, 25000, false);

      if (!restarted) {
        log.warn('[WARP] 启动自愈耗时超过 25 秒，服务先继续启动；后台将继续等待重启完成并校验代理端口 ...');
        // 后台接管：等待重启真正结束并确认端口就绪（不阻塞服务启动）
        restartPromise
          .then(async (ok) => {
            if (!ok) {
              log.warn('[WARP] 启动自愈（后台补完）重启命令执行失败，健康检查任务将持续监控');
              return;
            }
            const recovered = await this.waitForPort(40000, 30000);
            log.info(recovered
              ? '[WARP] ✓ 启动自愈（后台补完）完成，SOCKS5 代理 (40000) 已就绪'
              : '[WARP] ⚠ 启动自愈（后台补完）后代理端口仍未就绪，健康检查任务将持续监控');
          })
          .catch(() => {});
        return false;
      }

      const recovered = await this.waitForPort(40000, 15000);
      if (recovered) {
        log.info('[WARP] ✓ 启动自愈完成，SOCKS5 代理 (40000) 已就绪');
      } else {
        log.warn('[WARP] ⚠ 启动自愈后 SOCKS5 代理 (40000) 尚未就绪，健康检查任务将持续监控');
      }
      return recovered;
    } catch (error) {
      log.warn(`[WARP] 启动自愈异常: ${error.message}（服务继续启动）`);
      return false;
    }
  }

  /**
   * 启动代理健康检查定时任务
   * 定期探测 40000 端口，连续 N 次不可达时自动重启 WARP 换 IP
   * @returns {NodeJS.Timeout|null}
   */
  startHealthMonitor() {
    if (this.healthTimer) return this.healthTimer;

    if (!this.isWarpProxyConfigured()) {
      log.info('[WARP] 未配置 WARP SOCKS5 代理，跳过代理健康检查任务');
      return null;
    }
    if (!this.isAutoRestartEnabled()) {
      log.info('[WARP] 网络异常自动重启已关闭，跳过代理健康检查任务');
      return null;
    }

    const intervalMs = Number(config.warp?.healthCheckIntervalMs) > 0
      ? Number(config.warp.healthCheckIntervalMs)
      : 2 * 60 * 1000;
    const failureThreshold = Number(config.warp?.healthCheckFailures) > 0
      ? Number(config.warp.healthCheckFailures)
      : 3;

    this.healthFailureCount = 0;
    this.healthTimer = setInterval(() => {
      this._runHealthCheck(failureThreshold).catch(() => {});
    }, intervalMs);
    if (typeof this.healthTimer.unref === 'function') this.healthTimer.unref();

    log.info(`[WARP] 代理健康检查已启动（间隔 ${Math.round(intervalMs / 60000)} 分钟，连续 ${failureThreshold} 次不可达自动重启）`);
    return this.healthTimer;
  }

  /**
   * 停止代理健康检查定时任务
   */
  stopHealthMonitor() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
      log.info('[WARP] 代理健康检查已停止');
    }
  }

  /**
   * 执行一次健康检查
   * @param {number} failureThreshold - 连续失败阈值
   * @private
   */
  async _runHealthCheck(failureThreshold) {
    if (this.isRestarting) return;

    const portOpen = await this.checkPort(40000, '127.0.0.1');
    if (portOpen) {
      if (this.healthFailureCount > 0) {
        log.info(`[WARP] 代理端口 40000 已恢复可达（此前连续失败 ${this.healthFailureCount} 次）`);
      }
      this.healthFailureCount = 0;
      return;
    }

    this.healthFailureCount++;
    log.warn(`[WARP] 健康检查: 代理端口 40000 不可达（连续 ${this.healthFailureCount}/${failureThreshold} 次）`);

    if (this.healthFailureCount >= failureThreshold) {
      this.healthFailureCount = 0;
      const restarted = await this.restartWarp(`代理端口 40000 连续 ${failureThreshold} 次不可达，自动重启换 IP`);
      if (restarted) {
        const recovered = await this.waitForPort(40000, 20000);
        log.info(recovered
          ? '[WARP] ✓ 健康检查自愈完成，代理端口已恢复监听'
          : '[WARP] ⚠ 健康检查自愈后代理端口仍未恢复，等待下一轮检查');
      }
    }
  }

  /**
   * 后台任务上报一次代理/网络请求失败（用于快速触发自愈）
   * 在滑动窗口内累计达到阈值即触发一次 WARP 重启（受冷却与并发保护，不会造成重启风暴）
   * @param {string} reason - 失败原因（用于日志）
   */
  reportNetworkFailure(reason = '后台请求失败') {
    if (!this.isWarpProxyConfigured() || !this.isAutoRestartEnabled()) return;

    const now = Date.now();
    const windowMs = 5 * 60 * 1000;
    if (!this.failureWindowStart || now - this.failureWindowStart > windowMs) {
      this.failureWindowStart = now;
      this.failureWindowCount = 0;
    }
    this.failureWindowCount++;

    const threshold = Number(config.warp?.failureReportThreshold) > 0
      ? Number(config.warp.failureReportThreshold)
      : 5;

    if (this.failureWindowCount >= threshold) {
      this.failureWindowCount = 0;
      this.failureWindowStart = now;
      this.restartWarp(`执行窗口内连续 ${threshold} 次代理请求失败（${reason}）`).catch(() => {});
    }
  }

  /**
   * 检查本地端口（默认 40000）是否处于监听状态
   * @param {number} port
   * @param {string} host
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  checkPort(port = 40000, host = '127.0.0.1', timeoutMs = 1500) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, host);
    });
  }

  /**
   * 获取 WARP 状态与出口 IP 详细信息
   * @returns {Promise<Object>}
   */
  async getStatus() {
    return new Promise((resolve) => {
      // 1. 先检测 warp-cli status 或 warp status
      exec('warp-cli --accept-tos status 2>/dev/null || warp-cli status 2>/dev/null || warp status 2>/dev/null', async (cliErr, cliStdout) => {
        const rawStatus = (cliStdout || '').trim();
        const isInstalled = !cliErr || rawStatus.length > 0;
        const isConnected = rawStatus.toLowerCase().includes('connected') || rawStatus.includes('Success');

        // 2. 检测 40000 端口连通性
        const portOpen = await this.checkPort(40000, '127.0.0.1');

        // 3. 检测系统是否开启了全局透明代理 / iptables 劫持（红灯告警，防止冲突）
        let transparentProxyActive = false;
        let transparentProxyDetails = '';
        try {
          const natCheck = await new Promise((resCheck) => {
            exec('pgrep -x redsocks 2>/dev/null || iptables -t nat -L WARP_GOOGLE -n 2>/dev/null', (err, stdout) => {
              if (stdout && (stdout.includes('WARP_GOOGLE') || stdout.trim().length > 0)) {
                resCheck({ active: true, output: stdout.trim() });
              } else {
                resCheck({ active: false, output: '' });
              }
            });
          });
          transparentProxyActive = natCheck.active;
          transparentProxyDetails = natCheck.output;
        } catch {}

        // 4. 通过 SOCKS5 代理探测出口 IP 与归属地
        let ipInfo = null;
        if (portOpen) {
          try {
            const agent = new SocksProxyAgent('socks5://127.0.0.1:40000');
            const res = await axios.get('https://ipinfo.io/json', {
              httpAgent: agent,
              httpsAgent: agent,
              timeout: 4000
            });
            if (res.data) {
              ipInfo = {
                ip: res.data.ip || null,
                country: res.data.country || null,
                city: res.data.city || null,
                org: res.data.org || null
              };
            }
          } catch (e) {
            // fallback 尝试 ip-api
            try {
              const agent = new SocksProxyAgent('socks5://127.0.0.1:40000');
              const res2 = await axios.get('http://ip-api.com/json', {
                httpAgent: agent,
                httpsAgent: agent,
                timeout: 3000
              });
              if (res2.data) {
                ipInfo = {
                  ip: res2.data.query || null,
                  country: res2.data.countryCode || res2.data.country || null,
                  city: res2.data.city || null,
                  org: res2.data.org || res2.data.as || null
                };
              }
            } catch {}
          }
        }

        resolve({
          installed: isInstalled,
          connected: isConnected,
          portOpen,
          port: 40000,
          rawStatus: rawStatus || (isInstalled ? 'Unknown' : 'Not Installed'),
          transparentProxyActive,
          transparentProxyDetails,
          ipInfo,
          proxyConfigured: config.proxy === 'socks5://127.0.0.1:40000',
          autoRestartEnabled: config.warp?.autoRestart !== false
        });
      });
    });
  }

  /**
   * 兼容各种 Linux 系统的安全重启与换 IP 命令执行
   * 优先尝试 warp-cli 动态换 IP，其次执行 systemctl/warp restart
   * @param {string} reason - 重启原因
   * @returns {Promise<boolean>}
   */
  async restartWarp(reason = '网络请求受阻') {
    const now = Date.now();
    if (this.isRestarting) {
      log.warn(`[WARP] 已有 WARP 重启任务正在进行中，跳过重复请求 (${reason})`);
      return false;
    }

    if (now - this.lastRestartTime < this.cooldownMs) {
      const remainSec = Math.ceil((this.cooldownMs - (now - this.lastRestartTime)) / 1000);
      log.warn(`[WARP] 触发重启过于频繁，冷却中 (还剩 ${remainSec} 秒) - 跳过重启`);
      return false;
    }

    // 如果配置中关闭了自动重启，则跳过
    if (config.warp?.autoRestart === false && reason.includes('Google API 地区受限')) {
      log.warn(`[WARP] 自动重启换 IP 已在配置中关闭，跳过执行`);
      return false;
    }

    this.isRestarting = true;
    this.lastRestartTime = now;

    log.warn(`[WARP] ⚡ 检测到异常: ${reason}，正在执行多兼容重启换 IP ...`);

    // 组合兼容命令（使用 /bin/sh 兼容的简洁语法，避免换行压缩时的语法错误）:
    const restartCmd = 'warp restart 2>/dev/null || (warp-cli --accept-tos disconnect 2>/dev/null || warp-cli disconnect 2>/dev/null; sleep 1; warp-cli --accept-tos connect 2>/dev/null || warp-cli connect 2>/dev/null) || systemctl restart warp-svc 2>/dev/null || true';

    return new Promise((resolve) => {
      // timeout: 防止 warp/systemctl 命令挂起导致调用方（含服务启动流程）被卡死。
      // 注意不能设得过短：warp restart 走 systemctl 兜底分支时实测可达 25 秒，
      // 中途被杀可能让 WARP 停留在断开状态，因此保留 60 秒上限。
      exec(restartCmd, { shell: '/bin/bash', timeout: 60000 }, (error, stdout, stderr) => {
        this.isRestarting = false;
        if (error) {
          log.error(`[WARP] 重启失败: ${error.message}`);
          resolve(false);
        } else {
          log.info(`[WARP] ✓ WARP 重启与刷新命令执行完成！${stdout ? stdout.trim() : ''}`);
          resolve(true);
        }
      });
    });
  }

  /**
   * 一键快速安装并配置 WARP SOCKS5 代理服务（40000 端口 + MemoryMax=200M）
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async quickSetup() {
    return new Promise((resolve) => {
      const scriptUrl = 'https://raw.githubusercontent.com/4kercc/warp-google-unlock/main/warp-google.sh';
      // 传递参数 1 直接触发安装流程，避免进入交互菜单阻塞超时
      const setupCmd = `
        curl -sL ${scriptUrl} -o /tmp/warp-setup.sh &&
        chmod +x /tmp/warp-setup.sh &&
        export SOCKS_ONLY=1 &&
        bash /tmp/warp-setup.sh 1
      `.trim().replace(/\n\s+/g, ' ');

      exec(setupCmd, { timeout: 180000 }, (error, stdout, stderr) => {
        if (error) {
          log.error(`[WARP] 一键安装配置失败: ${error.message}`);
          resolve({ success: false, message: error.message });
        } else {
          log.info(`[WARP] 一键安装配置完成: ${stdout ? stdout.trim().slice(-200) : ''}`);
          resolve({ success: true, message: 'WARP 客户端与 SOCKS5 (40000 端口) 配置完成！' });
        }
      });
    });
  }
}

export default new WarpManager();
