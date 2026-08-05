import { log } from '../utils/logger.js';
import { generateTokenId } from '../utils/idGenerator.js';
import quotaManager from './quota_manager.js';
import tokenCooldownManager from './token_cooldown_manager.js';
import config from '../config/config.js';

/**
 * Token 验证器类
 * 负责 Token 的各种验证逻辑
 */
class TokenValidator {
  constructor(store) {
    this.store = store;
  }

  /**
   * 检查 token 对指定模型是否有额度
   * @param {Object} token - Token 对象
   * @param {string} modelId - 模型 ID
   * @returns {Promise<boolean>} true = 有额度或无数据，false = 额度为 0
   */
  async hasQuotaForModel(token, modelId) {
    if (!token || !modelId) return true;

    try {
      const salt = await this.store.getSalt();
      if (!salt) return true; // 没有 salt，假设有额度

      const tokenId = generateTokenId(token.refresh_token, salt);
      const threshold = Number.isFinite(config.rotation?.minQuotaThreshold) ? config.rotation.minQuotaThreshold : 0.20;
      return quotaManager.hasQuotaForModel(tokenId, modelId, threshold);
    } catch (error) {
      // 出错时假设有额度
      log.warn(`检查额度时出错: ${error.message}`);
      return true;
    }
  }

  /**
   * 检查 token 对指定模型是否在冷却中
   * @param {Object} token - Token 对象
   * @param {string} modelId - 模型 ID
   * @returns {Promise<boolean>} true = 可用（不在冷却中），false = 在冷却中
   */
  async isAvailableForModel(token, modelId) {
    if (!token || !modelId) return true;

    try {
      const salt = await this.store.getSalt();
      if (!salt) return true;

      const tokenId = generateTokenId(token.refresh_token, salt);
      return tokenCooldownManager.isAvailable(tokenId, modelId);
    } catch (error) {
      log.warn(`检查冷却状态时出错: ${error.message}`);
      return true;
    }
  }

  /**
   * 检查 token 对指定模型是否可用（既有额度，又不在冷却中）
   * @param {Object} token - Token 对象
   * @param {string} modelId - 模型 ID
   * @returns {Promise<boolean>} true = 可用，false = 不可用
   */
  async canUseForModel(token, modelId) {
    if (!token || !modelId) return true;

    // 先检查冷却状态（更严格的限制）
    const isAvailable = await this.isAvailableForModel(token, modelId);
    if (!isAvailable) {
      return false;
    }

    // 再检查额度
    return await this.hasQuotaForModel(token, modelId);
  }

  /**
   * 批量检查多个 token 对指定模型是否可用
   * @param {Array<{tokenId: string, token: Object}>} tokens - Token 数组
   * @param {string} modelId - 模型 ID
   * @returns {Promise<Array<{tokenId: string, token: Object, available: boolean}>>} 检查结果
   */
  async checkTokensAvailability(tokens, modelId) {
    if (!modelId || tokens.length === 0) {
      return tokens.map(t => ({ ...t, available: true }));
    }

    const results = await Promise.all(
      tokens.map(async ({ tokenId, token }) => {
        const available = await this.canUseForModel(token, modelId);
        return { tokenId, token, available };
      })
    );

    return results;
  }

  /**
   * 过滤出对指定模型可用的 tokens
   * @param {Array<{tokenId: string, token: Object}>} tokens - Token 数组
   * @param {string} modelId - 模型 ID
   * @returns {Promise<Array<{tokenId: string, token: Object}>>} 可用的 token 数组
   */
  async filterAvailableTokens(tokens, modelId) {
    if (!modelId || tokens.length === 0) {
      return tokens;
    }

    const results = await this.checkTokensAvailability(tokens, modelId);
    return results.filter(r => r.available).map(r => ({ tokenId: r.tokenId, token: r.token }));
  }

  /**
   * 检查所有 token 对指定模型是否都不可用（额度为0或在冷却中）
   * @param {Array<{tokenId: string, token: Object}>} tokens - Token 数组
   * @param {string} modelId - 模型 ID
   * @returns {Promise<boolean>} true = 所有 token 对该模型都不可用
   */
  async areAllTokensExhausted(tokens, modelId) {
    if (!modelId || tokens.length === 0) return false;

    for (const { token } of tokens) {
      const canUse = await this.canUseForModel(token, modelId);
      if (canUse) {
        return false; // 有至少一个 token 可用
      }
    }
    return true; // 所有 token 都不可用
  }

  /**
   * 验证 token 基本信息是否完整
   * 只要求 refresh_token 必须存在（access_token 可自动刷新，
   * expires_in/timestamp 缺失时视为已过期，触发自动刷新）
   * @param {Object} token - Token 对象
   * @returns {Object} 验证结果 {valid: boolean, missing: Array<string>}
   */
  validateTokenStructure(token) {
    const requiredFields = ['refresh_token'];
    const missing = [];

    for (const field of requiredFields) {
      if (!token[field]) {
        missing.push(field);
      }
    }

    return {
      valid: missing.length === 0,
      missing
    };
  }

  /**
   * 检查 token 是否启用
   * @param {Object} token - Token 对象
   * @returns {boolean} 是否启用
   */
  isEnabled(token) {
    return token.enable !== false;
  }

  /**
   * 检查 token 是否有 projectId
   * @param {Object} token - Token 对象
   * @returns {boolean} 是否有 projectId
   */
  hasProjectId(token) {
    return !!token.projectId;
  }

  /**
   * 检查 token 整体额度标记
   * @param {Object} token - Token 对象
   * @returns {boolean} 是否有额度
   */
  hasQuota(token) {
    return token.hasQuota !== false;
  }

  /**
   * 综合检查 token 是否就绪（可以用于请求）
   * @param {Object} token - Token 对象
   * @param {string} [modelId] - 可选的模型 ID
   * @returns {Promise<{ready: boolean, reasons: Array<string>}>} 检查结果
   */
  async isTokenReady(token, modelId = null) {
    const reasons = [];

    // 检查基本结构
    const structureCheck = this.validateTokenStructure(token);
    if (!structureCheck.valid) {
      reasons.push(`缺少必需字段: ${structureCheck.missing.join(', ')}`);
    }

    // 检查启用状态
    if (!this.isEnabled(token)) {
      reasons.push('token 已禁用');
    }

    // 检查 projectId
    if (!this.hasProjectId(token)) {
      reasons.push('缺少 projectId');
    }

    // 检查整体额度标记
    if (!this.hasQuota(token)) {
      reasons.push('token 标记为无额度');
    }

    // 如果提供了 modelId，检查模型特定的可用性
    if (modelId) {
      const canUse = await this.canUseForModel(token, modelId);
      if (!canUse) {
        reasons.push(`对模型 ${modelId} 不可用（额度耗尽或冷却中）`);
      }
    }

    return {
      ready: reasons.length === 0,
      reasons
    };
  }

  /**
   * 获取 token 的健康状态报告
   * @param {Object} token - Token 对象
   * @param {string} tokenId - Token ID
   * @returns {Promise<Object>} 健康状态报告
   */
  async getHealthReport(token, tokenId) {
    const report = {
      tokenId,
      enabled: this.isEnabled(token),
      hasProjectId: this.hasProjectId(token),
      hasQuota: this.hasQuota(token),
      structure: this.validateTokenStructure(token),
      timestamp: new Date().toISOString()
    };

    return report;
  }
}

export default TokenValidator;