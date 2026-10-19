import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';
import { getDataDir } from '../utils/paths.js';
import { QUOTA_CACHE_TTL, QUOTA_CLEANUP_INTERVAL } from '../constants/index.js';
import { getGroupKey } from '../utils/modelGroups.js';
import { modelMapping } from '../utils/utils.js';

// 每次请求消耗的额度百分比（按模型系列区分）
const REQUEST_COST_PERCENT = 0.6667;

// 不同模型系列的每次请求消耗百分比
const GROUP_COST_PERCENT = {
  claude: 0.6667,
  gemini: 0.6667,
  banana: 5.0,    // 图片生成模型消耗更高，约 20 次/满额
  other: 0.6667
};

// 额度数据最大可信时长：超过该时长视为不可信，不再参与阈值判断
// （由额度自动同步任务定时刷新，正常运行时数据不会超过该时长）
const QUOTA_DATA_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * 判断上游的 disabled 占位模型是否覆盖了请求的模型
 *
 * 上游用 `<family>-disabled` 表示「该账号未订阅这一族模型」，例如：
 *   gemini-4-argon-disabled  ->  gemini-4-argon-high / -medium / -low
 * @param {string} disabledId - 占位模型 ID
 * @param {string} modelId - 请求的模型 ID
 * @returns {boolean}
 */
function matchesDisabledModel(disabledId, modelId) {
  if (!disabledId || !modelId) return false;
  const disabled = String(disabledId).toLowerCase();
  const model = String(modelId).toLowerCase();
  if (disabled === model) return true;
  const base = disabled.replace(/-disabled$/, '');
  if (base === disabled) return false;
  return model === base || model.startsWith(`${base}-`);
}

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

    // 上游对未订阅的模型会返回 disabled 占位条目（如 gemini-4-argon-disabled）。
    // 这类条目没有额度信息，若混在 models 里参与组最小值计算会把整组额度拉到 0，
    // 导致该账号被误判为「所有 Gemini 模型都不可用」；因此单独存放，
    // 仅用于判断「该账号确实没有这个模型」。
    const disabledModels = [];
    const enabledQuotas = {};
    Object.entries(quotas || {}).forEach(([modelId, quotaData]) => {
      if (quotaData && quotaData.disabled === true) {
        disabledModels.push(modelId);
        return;
      }
      enabledQuotas[modelId] = quotaData;
    });
    quotas = enabledQuotas;

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
      // r 为 null 表示上游未给出该模型额度（无 quotaInfo），不参与组最小值计算
      if (quotaData.r === null || quotaData.r === undefined) return;
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
      if (quotaData.r === null || quotaData.r === undefined) return;
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
      disabledModels,
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

    // 数据过旧时不再可信：按“有额度”处理，避免陈旧数据永久排除或永久放行某个账号
    // （由额度自动同步任务负责尽快刷新数据）
    if (data.lastUpdated && Date.now() - data.lastUpdated > QUOTA_DATA_MAX_AGE_MS) {
      return true;
    }

    // 上游用 disabled 占位模型表示「该账号未订阅此模型」（如 gemini-4-argon-disabled）。
    // 命中同一模型族时直接判定不可用，避免请求被路由到没有该模型的账号后返回 404。
    // 兼容旧缓存：disabled 条目也可能残留在 models 中，故一并检查 ID 后缀。
    const disabledIds = new Set(Array.isArray(data.disabledModels) ? data.disabledModels : []);
    for (const id of Object.keys(data.models)) {
      if (/-disabled$/i.test(id)) disabledIds.add(id);
    }
    if ([...disabledIds].some(id => matchesDisabledModel(id, modelId))) {
      return false;
    }

    // 模型目录校验：账号的目录里没有该模型时判定不可用。
    // 不同账号的模型目录并不相同（例如 4.6 与 5.5 两代 Claude、是否包含 3.6/3.7 系列），
    // 若不做这一步，请求会被轮询到没有该模型的账号上并返回 404。
    // 比较前先按请求侧同一套规则做别名映射（如 gemini-3.8-flash -> gemini-3.8-flash-tiered）。
    const catalogIds = Object.keys(data.models);
    if (catalogIds.length >= 5) {
      let targetModelId = modelId;
      try {
        targetModelId = modelMapping(modelId) || modelId;
      } catch {
        // 映射失败时按原始名称比较
      }
      if (!catalogIds.includes(targetModelId)) {
        return false;
      }
    }

    const groupKey = getGroupKey(modelId);

    // 使用该组的最小额度来判断（与 getModelGroupQuota 逻辑一致）
    let minRemaining = null;

    for (const [id, quotaData] of Object.entries(data.models)) {
      const idGroupKey = getGroupKey(id);
      if (idGroupKey === groupKey) {
        // r 为 null 表示上游未提供该模型额度（如无 quotaInfo 的占位/内部模型），
        // 不能当作 0 参与最小值计算，否则会把整组额度误判为耗尽
        if (quotaData.r === null || quotaData.r === undefined) continue;
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
        // 无额度信息的模型（r=null）不参与最小值计算
        if (quotaData.r === null || quotaData.r === undefined) continue;
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

