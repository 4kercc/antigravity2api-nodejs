import fs from 'fs/promises';
import path from 'path';
import { getDataDir } from './paths.js';
import logger from './logger.js';

const BLOCKLIST_FILE = 'ip-blocklist.json';
const SECURITY_CONFIG_FILE = 'security.json';
const SECURITY_CONFIG_EXAMPLE = 'security.json.example';

const DEFAULT_CONFIG = {
  whitelist: {
    enabled: true,
    ips: ['127.0.0.1', '::1']
  },
  blocking: {
    enabled: true,
    tempBlockDuration: 60 * 60 * 1000,
    maxViolationsBeforeTempBlock: 50,
    maxTempBlocksBeforePermanent: 10,
    violationWindow: 5 * 60 * 1000,
    violationDecayTime: 30 * 60 * 1000
  }
};

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^::1$/,
  /^fe80:/,
  /^fc00:/,
  /^::ffff:127\./,
  /^::ffff:10\./,
  /^::ffff:192\.168\./
];

class IpBlockManager {
  constructor() {
    this.filePath = null;
    this.configPath = null;
    this.data = { blocked_ips: {} };
    this.config = DEFAULT_CONFIG;
    this.initialized = false;
    this.savePromise = Promise.resolve();
  }

  async init() {
    if (this.initialized) return;
    const dataDir = getDataDir();
    this.filePath = path.join(dataDir, BLOCKLIST_FILE);
    this.configPath = path.join(process.cwd(), SECURITY_CONFIG_FILE);
    
    await this.loadConfig();
    await this.load();
    this.initialized = true;
  }

  async loadConfig() {
    try {
      const examplePath = path.join(process.cwd(), SECURITY_CONFIG_EXAMPLE);
      
      try {
        await fs.access(this.configPath);
      } catch {
        try {
          await fs.copyFile(examplePath, this.configPath);
          logger.info('已从 security.json.example 创建 security.json');
        } catch (e) {
          logger.warn('未找到 security.json.example，使用默认配置');
        }
      }
      
      try {
        const content = await fs.readFile(this.configPath, 'utf8');
        const loaded = JSON.parse(content);
        this.config = { ...DEFAULT_CONFIG, ...loaded };
        if (loaded.whitelist) this.config.whitelist = { ...DEFAULT_CONFIG.whitelist, ...loaded.whitelist };
        if (loaded.blocking) this.config.blocking = { ...DEFAULT_CONFIG.blocking, ...loaded.blocking };
      } catch (e) {
        if (e.code !== 'ENOENT') {
          logger.error('加载安全配置失败:', e.message);
        }
        this.config = DEFAULT_CONFIG;
      }
    } catch (e) {
      logger.error('初始化安全配置失败:', e.message);
      this.config = DEFAULT_CONFIG;
    }
  }

  async saveConfig() {
    try {
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
      logger.info('安全配置已保存');
    } catch (e) {
      logger.error('保存安全配置失败:', e.message);
    }
  }

  isWhitelisted(ip) {
    if (!ip) return false;
    if (!this.config.whitelist.enabled) return false;
    if (this.config.whitelist.ips.includes(ip)) return true;
    return PRIVATE_IP_RANGES.some(regex => regex.test(ip));
  }

  async load() {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      
      try {
        const content = await fs.readFile(this.filePath, 'utf8');
        this.data = JSON.parse(content);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          logger.error('加载封禁列表失败:', e.message);
        }
        this.data = { blocked_ips: {} };
      }
    } catch (e) {
      logger.error('初始化封禁管理器失败:', e.message);
    }
  }

  async save() {
    this.savePromise = this.savePromise.then(async () => {
      try {
        await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
      } catch (e) {
        logger.error('保存封禁列表失败:', e.message);
      }
    });
    return this.savePromise;
  }

  check(ip) {
    if (!ip || this.isWhitelisted(ip)) return { blocked: false };
    if (!this.config.blocking.enabled) return { blocked: false };
    
    const info = this.data.blocked_ips[ip];
    if (!info) return { blocked: false };

    if (info.permanent) {
      return { blocked: true, reason: 'permanent' };
    }
    
    if (info.expiresAt && Date.now() < info.expiresAt) {
      return { blocked: true, reason: 'temporary', expiresAt: info.expiresAt };
    }

    return { blocked: false };
  }

  async recordViolation(ip, type, severityWeight = 1) {
    if (!ip || this.isWhitelisted(ip)) return;
    if (!this.config.blocking.enabled) return;
    
    if (!this.initialized) await this.init();

    let info = this.data.blocked_ips[ip];
    const now = Date.now();

    if (!info) {
      info = { 
        permanent: false, 
        expiresAt: 0, 
        violations: 0, 
        tempBlockCount: 0, 
        lastViolation: 0 
      };
      this.data.blocked_ips[ip] = info;
    }

    if (info.permanent || (info.expiresAt && now < info.expiresAt)) return;

    const { violationDecayTime, violationWindow, maxViolationsBeforeTempBlock, maxTempBlocksBeforePermanent, tempBlockDuration } = this.config.blocking;

    if (now - info.lastViolation > violationDecayTime) {
      info.violations = Math.max(0, Math.floor(info.violations / 2));
    } else if (now - info.lastViolation > violationWindow) {
      info.violations = 0;
    }

    // 根据不同违规严重度加权（例如后台密码暴力破解单次计 10 次违规，5次即封禁）
    info.violations += (typeof severityWeight === 'number' && severityWeight > 0) ? severityWeight : 1;
    info.lastViolation = now;

    if (info.violations >= maxViolationsBeforeTempBlock) {
      info.tempBlockCount++;
      info.violations = 0;

      if (info.tempBlockCount >= maxTempBlocksBeforePermanent) {
        info.permanent = true;
        info.expiresAt = 0;
        logger.warn(`🚨 IP ${ip} 因频繁违规(${type})达到永久封禁阈值，已被永久拉黑！`);
      } else {
        info.expiresAt = now + tempBlockDuration;
        logger.warn(`⚠️ IP ${ip} 因频繁违规(${type})已被临时封禁 ${Math.round(tempBlockDuration/60000)} 分钟 (累计封禁 ${info.tempBlockCount} 次)`);
      }
      
      await this.save();
    }
  }

  async blockIP(ip, permanent = true, durationMs = null) {
    if (!ip) return false;
    if (!this.initialized) await this.init();

    const now = Date.now();
    const tempDuration = durationMs || this.config.blocking.tempBlockDuration || 3600000;
    
    this.data.blocked_ips[ip] = {
      permanent: permanent,
      expiresAt: permanent ? 0 : (now + tempDuration),
      violations: 999,
      tempBlockCount: permanent ? 10 : 1,
      lastViolation: now
    };

    await this.save();
    logger.warn(`管理员手动封禁 IP: ${ip} (${permanent ? '永久封禁' : `临时封禁 ${Math.round(tempDuration/60000)} 分钟`})`);
    return true;
  }

  async unblock(ip) {
    if (!ip) return false;
    if (this.data.blocked_ips[ip]) {
      delete this.data.blocked_ips[ip];
      await this.save();
      logger.info(`IP ${ip} 已解除封禁`);
      return true;
    }
    return false;
  }

  async listBlocked() {
    const now = Date.now();
    return Object.entries(this.data.blocked_ips)
      .filter(([_, info]) => {
        return info.permanent || (info.expiresAt && now < info.expiresAt);
      })
      .map(([ip, info]) => ({
        ip,
        permanent: info.permanent,
        expiresAt: info.expiresAt,
        tempBlockCount: info.tempBlockCount
      }));
  }

  getConfig() {
    return this.config;
  }

  async updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    if (newConfig.whitelist) this.config.whitelist = { ...this.config.whitelist, ...newConfig.whitelist };
    if (newConfig.blocking) this.config.blocking = { ...this.config.blocking, ...newConfig.blocking };
    await this.saveConfig();
  }

  async addWhitelistIP(ip) {
    if (!this.config.whitelist.ips.includes(ip)) {
      this.config.whitelist.ips.push(ip);
      await this.saveConfig();
      logger.info(`IP ${ip} 已添加到白名单`);
      return true;
    }
    return false;
  }

  async removeWhitelistIP(ip) {
    const index = this.config.whitelist.ips.indexOf(ip);
    if (index > -1) {
      this.config.whitelist.ips.splice(index, 1);
      await this.saveConfig();
      logger.info(`IP ${ip} 已从白名单移除`);
      return true;
    }
    return false;
  }
}

export default new IpBlockManager();
