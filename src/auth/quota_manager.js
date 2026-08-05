import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';
import { getDataDir } from '../utils/paths.js';
import { QUOTA_CACHE_TTL, QUOTA_CLEANUP_INTERVAL } from '../constants/index.js';
import { getGroupKey } from '../utils/modelGroups.js';

// 每次请求消耗的额度百分比（按模型系列区分）
const REQUEST_COST_PERCENT = 0.6667;

// 不同模型系列的每次请求消耗百分比
const GROUP_COST_PERCENT = {
  claude: 0.6667,
  gemini: 0.6667,
  banana: 5.0,    // 图片生成模型消耗更高，约 20 次/满额
  other: 0.6667
};

class QuotaManager {
  /**
   * @param {string} filePath - 额度数据文件路径
   */
  constructor(filePath = path.join(getDataDir(), 'quotas.json')) {
    this.filePath = filePath;
    /** @type {Map<string, {lastUpdated: number, models: Object, requestCounts: Object, resetTimes: Object}>} */
    this.cache = new Map();
    this.CACHE_TTL = QUOTA_CACHE_TTL;
    this.CLEANUP_INTERVAL = QUOTA_CLEANUP_INTERVAL;
    this.cleanupTimer = null;
    this.ensureFileExists();
    this.loadFromFile();
    this.startCleanupTimer();
  }

  ensureFileExists() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ meta: { lastCleanup: Date.now(), ttl: this.CLEANUP_INTERVAL }, quotas: {} }, null, 2), 'utf8');
    }
  }

  loadFromFile() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      Object.entries(parsed.quotas || {}).forEach(([key, value]) => {
        // 确保 requestCounts 和 resetTimes 字段存在
        if (!value.requestCounts) value.requestCounts = {};
        if (!value.resetTimes) value.resetTimes = {};
        this.cache.set(key, value);
      });
    } catch (error) {
      log.error('加载额度文件失败:', error.message);
    }
  }

  saveToFile() {
    try {
      const quotas = {};
      this.cache.forEach((value, key) => {
        quotas[key] = value;
      });
      const data = {
        meta: { lastCleanup: Date.now(), ttl: this.CLEANUP_INTERVAL },
        quotas
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      log.error('保存额度文件失败:', error.message);
    }
  }

  /**
   * 更新额度数据
   * @param {string} refreshToken - Token ID
   * @param {Object} quotas - 额度数据
   */
  updateQuota(refreshToken, quotas) {
    const existing = this.cache.get(refreshToken) || {};
    const existingModels = existing.models || {};
    const existingRequestCounts = existing.requestCounts || {};
    const existingResetTimes = existing.resetTimes || {};

    // 检查各个模型组的重置时间和额度变化
    const newResetTimes = {};
    const newRequestCounts = { ...existingRequestCounts };

    // 记录额度真正重置的组（需要打印日志）
    const quotaResetGroups = new Set();

    // 记录每个组的最低额度，用于检测额度变化
    const groupMinRemaining = {};
    const existingGroupMinRemaining = {};

    // 计算新数据中每个组的最低额度和重置时间
    Object.entries(quotas || {}).forEach(([modelId, quotaData]) => {
      const groupKey = getGroupKey(modelId);
      const remaining = quotaData.r || 0;

      if (groupMinRemaining[groupKey] === undefined || remaining < groupMinRemaining[groupKey]) {
        groupMinRemaining[groupKey] = remaining;
      }

      const resetTimeRaw = quotaData.t;
      if (resetTimeRaw) {
        const newResetMs = Date.parse(resetTimeRaw);

        // 更新重置时间（取最早的）
        if (!newResetTimes[groupKey] || newResetMs < Date.parse(newResetTimes[groupKey])) {
          newResetTimes[groupKey] = resetTimeRaw;
        }
      }
    });

    // 计算旧数据中每个组的最低额度
    Object.entries(existingModels).forEach(([modelId, quotaData]) => {
      const groupKey = getGroupKey(modelId);
      const remaining = quotaData.r || 0;

      if (existingGroupMinRemaining[groupKey] === undefined || remaining < existingGroupMinRemaining[groupKey]) {
        existingGroupMinRemaining[groupKey] = remaining;
      }
    });

    // 检测额度重置：只有当旧的重置时间已经过去，才认为是真正的额度重置
    const now = Date.now();
    for (const groupKey of Object.keys(groupMinRemaining)) {
      const newMin = groupMinRemaining[groupKey];
      const oldMin = existingGroupMinRemaining[groupKey];
      const oldResetTimeRaw = existingResetTimes[groupKey];
      const oldResetMs = oldResetTimeRaw ? Date.parse(oldResetTimeRaw) : null;

      // 条件1: 旧的重置时间已经过去（说明进入了新的额度周期）
      const resetTimePassed = oldResetMs && Number.isFinite(oldResetMs) && now > oldResetMs;

      // 条件2: 新额度明显高于旧额度（说明额度确实恢复了）
      const quotaIncreased = oldMin !== undefined && newMin > oldMin + 0.05;

      if (resetTimePassed && existingRequestCounts[groupKey] > 0) {
        // 重置时间已过，清零计数
        newRequestCounts[groupKey] = 0;
        quotaResetGroups.add(groupKey);
      } else if (resetTimePassed && quotaIncreased) {
        // 重置时间已过且额度增加，清零计数
        newRequestCounts[groupKey] = 0;
        quotaResetGroups.add(groupKey);
      }
      // 注意：如果重置时间未过，即使 API 返回的额度更高，也不重置计数
      // 这避免了官方 API 返回值波动导致的误重置
    }

    // 只有额度真正重置时才打印日志
    if (quotaResetGroups.size > 0) {
      log.info(`[QuotaManager] 额度重置（重置时间已过），清零请求计数: ${Array.from(quotaResetGroups).join(', ')}`);
    }

    this.cache.set(refreshToken, {
      lastUpdated: Date.now(),
      models: quotas,
      requestCounts: newRequestCounts,
      resetTimes: newResetTimes
    });
    this.saveToFile();
  }

  /**
   * 记录一次请求
   * @param {string} refreshToken - Token ID
   * @param {string} modelId - 使用的模型 ID
   */
  recordRequest(refreshToken, modelId) {
    let data = this.cache.get(refreshToken);

    // 如果没有缓存条目，创建一个新的
    if (!data) {
      data = {
        lastUpdated: Date.now(),
        models: {},
        requestCounts: {},
        resetTimes: {}
      };
      this.cache.set(refreshToken, data);
    }

    const groupKey = getGroupKey(modelId);
    if (!data.requestCounts) data.requestCounts = {};

    // 检查是否已过重置时间
    const resetTimeRaw = data.resetTimes?.[groupKey];
    if (resetTimeRaw) {
      const resetMs = Date.parse(resetTimeRaw);
      if (Date.now() > resetMs) {
        // 已过重置时间，重置计数
        data.requestCounts[groupKey] = 0;
      }
    }

    data.requestCounts[groupKey] = (data.requestCounts[groupKey] || 0) + 1;
    this.saveToFile();
  }

  /**
   * 获取额度数据（包含请求计数和预估）
   * @param {string} refreshToken - Token ID
   * @returns {Object|null} 额度数据
   */
  getQuota(refreshToken) {
    const data = this.cache.get(refreshToken);
    if (!data) return null;

    // 检查缓存是否过期
    if (Date.now() - data.lastUpdated > this.CACHE_TTL) {
      return null;
    }

    return data;
  }

  /**
   * 获取指定 token 的请求计数
   * @param {string} refreshToken - Token ID
   * @returns {Object} 请求计数 { claude: number, gemini: number, banana: number, other: number }
   */
  getRequestCounts(refreshToken) {
    const data = this.cache.get(refreshToken);
    return data?.requestCounts || {};
  }

  /**
   * 检查 token 对特定模型组是否有额度
   * @param {string} tokenId - Token ID
   * @param {string} modelId - 模型 ID
   * @returns {boolean} 是否有额度（true = 有额度或无数据，false = 额度为 0）
   */
  hasQuotaForModel(tokenId, modelId, threshold = 0) {
    const data = this.cache.get(tokenId);
    if (!data || !data.models) {
      // 没有额度数据，假设有额度
      return true;
    }

    const groupKey = getGroupKey(modelId);

    // 使用该组的最小额度来判断（与 getModelGroupQuota 逻辑一致）
    let minRemaining = null;

    for (const [id, quotaData] of Object.entries(data.models)) {
      const idGroupKey = getGroupKey(id);
      if (idGroupKey === groupKey) {
        const remaining = quotaData.r || 0;
        const weeklyRemaining = quotaData.wr !== null && quotaData.wr !== undefined ? quotaData.wr : null;
        const effectiveRemaining = weeklyRemaining !== null ? Math.min(remaining, weeklyRemaining) : remaining;
        if (minRemaining === null || effectiveRemaining < minRemaining) {
          minRemaining = effectiveRemaining;
        }
      }
    }

    // 没有找到该组的模型数据，假设有额度
    if (minRemaining === null) return true;

    // 比较有效额度是否达到设定阈值 (例如 0.20)
    return minRemaining >= threshold;
  }

  /**
   * 获取模型组的最小额度
   * @param {string} tokenId - Token ID
   * @param {string} modelId - 模型 ID
   * @returns {number} 该组的最小额度 (0-1)，如果没有数据返回 1
   */
  getModelGroupQuota(tokenId, modelId) {
    const data = this.cache.get(tokenId);
    if (!data || !data.models) {
      return 1; // 没有数据，假设满额
    }

    const groupKey = getGroupKey(modelId);
    let minRemaining = 1;
    let found = false;

    for (const [id, quotaData] of Object.entries(data.models)) {
      const idGroupKey = getGroupKey(id);
      if (idGroupKey === groupKey) {
        found = true;
        const remaining = quotaData.r || 0;
        if (remaining < minRemaining) {
          minRemaining = remaining;
        }
      }
    }

    return found ? minRemaining : 1;
  }

  /**
   * 获取模型系列的最早恢复时间
   * @param {string} tokenId - Token ID
   * @param {string} modelId - 模型 ID
   * @returns {{resetTime: number|null, hasData: boolean}} resetTime 为时间戳（毫秒），hasData 表示是否有该系列的数据
   */
  getModelGroupResetTime(tokenId, modelId) {
    const data = this.cache.get(tokenId);
    if (!data || !data.models) {
      return { resetTime: null, hasData: false };
    }

    const groupKey = getGroupKey(modelId);
    let earliestReset = null;
    let found = false;

    for (const [id, quotaData] of Object.entries(data.models)) {
      const idGroupKey = getGroupKey(id);
      if (idGroupKey === groupKey) {
        found = true;
        const resetTimeRaw = quotaData.t;
        if (resetTimeRaw) {
          const resetMs = Date.parse(resetTimeRaw);
          if (Number.isFinite(resetMs)) {
            if (earliestReset === null || resetMs < earliestReset) {
              earliestReset = resetMs;
            }
          }
        }
      }
    }

    return { resetTime: earliestReset, hasData: found };
  }

  /**
   * 检查是否有指定 token 的额度数据
   * @param {string} tokenId - Token ID
   * @returns {boolean} 是否有数据
   */
  hasQuotaData(tokenId) {
    const data = this.cache.get(tokenId);
    return !!(data && data.models && Object.keys(data.models).length > 0);
  }

  /**
   * 计算预估剩余请求次数
   * @param {number} remainingFraction - 剩余额度比例 (0-1)
   * @param {number} requestCount - 已使用的请求次数
   * @param {string} [groupKey] - 模型系列 key（用于获取对应的消耗率）
   * @returns {number} 预估剩余请求次数
   */
  calculateEstimatedRequests(remainingFraction, requestCount = 0, groupKey = null) {
    // 根据模型系列使用不同的消耗率
    const costPercent = (groupKey && GROUP_COST_PERCENT[groupKey]) || REQUEST_COST_PERCENT;
    // 基于当前阈值计算总的可用次数
    const percentageValue = remainingFraction * 100;
    const totalFromThreshold = Math.floor(percentageValue / costPercent);
    // 减去已记录的请求次数
    return Math.max(0, totalFromThreshold - requestCount);
  }

  /**
   * 获取模型系列的消耗率配置（供前端使用）
   * @returns {Object} 各系列的消耗率
   */
  static getGroupCostPercent() {
    return { ...GROUP_COST_PERCENT };
  }

  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    this.cache.forEach((value, key) => {
      if (now - value.lastUpdated > this.CLEANUP_INTERVAL) {
        this.cache.delete(key);
        cleaned++;
      }
    });

    if (cleaned > 0) {
      log.info(`清理了 ${cleaned} 个过期的额度记录`);
      this.saveToFile();
    }
  }

  startCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanupTimer = setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL);
    // 使用 unref 避免阻止进程退出
    this.cleanupTimer.unref?.();
  }

  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  convertToBeijingTime(utcTimeStr) {
    if (!utcTimeStr) return 'N/A';
    try {
      const utcDate = new Date(utcTimeStr);
      return utcDate.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai'
      });
    } catch (error) {
      return 'N/A';
    }
  }
}

const quotaManager = new QuotaManager();
export default quotaManager;

