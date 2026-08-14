import { exec } from 'child_process';
import log from './logger.js';

class WarpManager {
  constructor() {
    this.lastRestartTime = 0;
    this.cooldownMs = 60 * 1000; // 60秒冷却时间，防止频繁重启
    this.isRestarting = false;
  }

  /**
   * 触发重启 WARP
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

    this.isRestarting = true;
    this.lastRestartTime = now;

    log.warn(`[WARP] ⚡ 检测到异常: ${reason}，正在执行自动重启命令: warp restart ...`);

    return new Promise((resolve) => {
      exec('warp restart', (error, stdout, stderr) => {
        this.isRestarting = false;
        if (error) {
          log.error(`[WARP] 重启失败: ${error.message}`);
          resolve(false);
        } else {
          log.info(`[WARP] ✓ WARP 重启命令执行成功！${stdout ? stdout.trim() : ''}`);
          resolve(true);
        }
      });
    });
  }
}

export default new WarpManager();
