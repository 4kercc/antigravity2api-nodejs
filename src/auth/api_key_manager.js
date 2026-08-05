import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { log } from '../utils/logger.js';
import config from '../config/config.js';

class ApiKeyManager {
  constructor() {
    this.filePath = path.join(process.cwd(), 'data', 'api_keys.json');
    this.keys = [];
    this.loadFromFile();
  }

  loadFromFile() {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf8');
        const data = JSON.parse(content);
        this.keys = Array.isArray(data.keys) ? data.keys : [];
      } else {
        this.keys = [];
        this.initializeDefaultKeys();
      }
    } catch (error) {
      log.error('加载 API 密钥文件失败:', error.message);
      this.keys = [];
    }
  }

  initializeDefaultKeys() {
    const envApiKey = config.security?.apiKey || process.env.API_KEY;
    if (envApiKey) {
      this.keys.push({
        id: 'key_default',
        name: '默认密钥',
        key: envApiKey,
        enabled: true,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        usage: {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0
        }
      });
      this.saveToFile();
    }
  }

  saveToFile() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        meta: { lastUpdated: new Date().toISOString() },
        keys: this.keys
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      log.error('保存 API 密钥文件失败:', error.message);
    }
  }

  getAllKeys() {
    return this.keys.map(k => ({ ...k }));
  }

  getKeyById(id) {
    return this.keys.find(k => k.id === id) || null;
  }

  validateKey(providedKey) {
    // 如果系统中没有任何配置的 key 且未全局要求
    if (this.keys.length === 0) {
      const globalKey = config.security?.apiKey;
      if (!globalKey) return { valid: true, keyInfo: null };
      if (providedKey === globalKey) return { valid: true, keyInfo: { id: 'global', name: '全局密钥' } };
      return { valid: false, keyInfo: null };
    }

    if (!providedKey) {
      const hasEnabledKeys = this.keys.some(k => k.enabled);
      const globalKey = config.security?.apiKey;
      if (!hasEnabledKeys && !globalKey) {
        return { valid: true, keyInfo: null };
      }
      return { valid: false, keyInfo: null };
    }

    // 匹配启用的 key
    const match = this.keys.find(k => k.key === providedKey && k.enabled);
    if (match) {
      return { valid: true, keyInfo: match };
    }

    // 兼容全局 key
    const globalKey = config.security?.apiKey;
    if (globalKey && providedKey === globalKey) {
      return { valid: true, keyInfo: { id: 'global', name: '全局密钥' } };
    }

    return { valid: false, keyInfo: null };
  }

  createKey({ name, key }) {
    const keyId = 'key_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
    const apiKeyString = key && key.trim() ? key.trim() : ('sk-' + crypto.randomBytes(16).toString('hex'));

    const newKey = {
      id: keyId,
      name: name && name.trim() ? name.trim() : 'API Key',
      key: apiKeyString,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      usage: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      }
    };

    this.keys.push(newKey);
    this.saveToFile();
    return newKey;
  }

  updateKey(id, { name, enabled, key }) {
    const target = this.keys.find(k => k.id === id);
    if (!target) return null;

    if (typeof name === 'string' && name.trim()) {
      target.name = name.trim();
    }
    if (typeof enabled === 'boolean') {
      target.enabled = enabled;
    }
    if (typeof key === 'string' && key.trim()) {
      target.key = key.trim();
    }

    this.saveToFile();
    return target;
  }

  deleteKey(id) {
    const index = this.keys.findIndex(k => k.id === id);
    if (index === -1) return false;

    this.keys.splice(index, 1);
    this.saveToFile();
    return true;
  }

  recordUsage(keyId, usage) {
    if (!keyId) return;
    const target = this.keys.find(k => k.id === keyId);
    if (!target) return;

    const inputTokens = Number(usage?.prompt_tokens || usage?.input_tokens || usage?.promptTokenCount || 0);
    const outputTokens = Number(usage?.completion_tokens || usage?.output_tokens || usage?.candidatesTokenCount || 0);
    const totalTokens = Number(usage?.total_tokens || usage?.totalTokenCount || (inputTokens + outputTokens));

    if (!target.usage) {
      target.usage = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }

    target.usage.requests = (target.usage.requests || 0) + 1;
    target.usage.inputTokens = (target.usage.inputTokens || 0) + inputTokens;
    target.usage.outputTokens = (target.usage.outputTokens || 0) + outputTokens;
    target.usage.totalTokens = (target.usage.totalTokens || 0) + totalTokens;
    target.lastUsedAt = new Date().toISOString();

    this.saveToFile();
  }

  getOverallStats() {
    let totalRequests = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;

    this.keys.forEach(k => {
      if (k.usage) {
        totalRequests += k.usage.requests || 0;
        totalInputTokens += k.usage.inputTokens || 0;
        totalOutputTokens += k.usage.outputTokens || 0;
        totalTokens += k.usage.totalTokens || 0;
      }
    });

    return {
      totalKeys: this.keys.length,
      enabledKeys: this.keys.filter(k => k.enabled).length,
      totalRequests,
      totalInputTokens,
      totalOutputTokens,
      totalTokens
    };
  }
}

const apiKeyManager = new ApiKeyManager();
export default apiKeyManager;
