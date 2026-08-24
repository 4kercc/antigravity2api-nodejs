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
      exec(restartCmd, { shell: '/bin/bash' }, (error, stdout, stderr) => {
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
