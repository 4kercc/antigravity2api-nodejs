import { log } from '../utils/logger.js';

/**
 * Token 轮询策略基类
 */
class TokenRotationStrategy {
  /**
   * 从可用 token 列表中选择一个
   * @param {Array<{tokenId: string, token: Object}>} tokens - 可用的 token 列表
   * @param {Object} context - 上下文信息
   * @returns {Object|null} 选中的 token 信息 {tokenId, token}
   */
  selectToken(tokens, context) {
    throw new Error('Must implement selectToken');
  }

  /**
   * 记录本次使用
   * @param {string} tokenId - 使用的 tokenId
   */
  recordUsage(tokenId) {
    // 默认实现：不记录
  }

  /**
   * 重置状态
   */
  reset() {
    // 默认实现：无状态
  }

  /**
   * 获取策略名称
   * @returns {string} 策略名称
   */
  getName() {
    return this.constructor.name;
  }
}

/**
 * 轮询策略：Round Robin（均衡负载）
 * 每次请求切换到下一个 token
 */
class RoundRobinStrategy extends TokenRotationStrategy {
  constructor() {
    super();
    this.currentIndex = 0;
  }

  selectToken(tokens, context) {
    if (tokens.length === 0) return null;
    
    const selected = tokens[this.currentIndex % tokens.length];
    this.currentIndex = (this.currentIndex + 1) % tokens.length;
    
    return selected;
  }

  reset() {
    this.currentIndex = 0;
  }

  getName() {
    return 'round_robin';
  }
}

/**
 * 轮询策略：Quota Exhausted（额度耗尽才切换）
 * 使用一个 token 直到其额度耗尽（或低于阈值被过滤），再切换到下一个。
 *
 * 实现说明：按 tokenId 追踪“当前正在使用的账号”，而不是用数组下标。
 * 候选列表会随额度阈值过滤动态变化（账号被剔除/恢复），下标会随之错位，
 * 导致反复选中同一账号或跳过本该轮到的账号。
 */
class QuotaExhaustedStrategy extends TokenRotationStrategy {
  constructor() {
    super();
    /** @type {string|null} 当前正在使用的 tokenId */
    this.currentTokenId = null;
    /** @type {string[]} 上一次候选列表的顺序（用于定位“下一个账号”） */
    this.lastCandidateIds = [];
    /** @type {boolean} 是否被显式要求切换（额度被标记耗尽） */
    this.forceAdvance = false;
  }

  selectToken(tokens, context) {
    if (tokens.length === 0) {
      this.currentTokenId = null;
      this.lastCandidateIds = [];
      this.forceAdvance = false;
      return null;
    }

    const candidateIds = tokens.map(item => item.tokenId);
    const candidatesById = new Map(tokens.map(item => [item.tokenId, item]));

    // 1. 未被要求切换且当前账号仍在候选中 → 继续使用当前账号
    if (!this.forceAdvance && this.currentTokenId && candidatesById.has(this.currentTokenId)) {
      this.lastCandidateIds = candidateIds;
      return candidatesById.get(this.currentTokenId);
    }

    // 2. 需要切换：按上一次候选顺序，从当前账号之后循环查找第一个仍可用的账号
    //    （这样账号因额度低于阈值被剔除或恢复时，都会顺延到逻辑上的“下一个”，不会跳号）
    let selected = null;
    const referenceOrder = this.lastCandidateIds.length > 0 ? this.lastCandidateIds : candidateIds;
    if (this.currentTokenId) {
      const currentPos = referenceOrder.indexOf(this.currentTokenId);
      if (currentPos !== -1) {
        for (let step = 1; step <= referenceOrder.length; step++) {
          const candidateId = referenceOrder[(currentPos + step) % referenceOrder.length];
          if (candidatesById.has(candidateId)) {
            selected = candidatesById.get(candidateId);
            break;
          }
        }
      }
    }

    // 3. 兜底：使用候选列表中的第一个账号
    if (!selected) selected = tokens[0];

    this.currentTokenId = selected ? (selected.tokenId || null) : null;
    this.forceAdvance = false;
    this.lastCandidateIds = candidateIds;
    return selected;
  }

  /**
   * 标记当前账号已耗尽，要求下一次选择切换到其后继账号
   */
  switchToNext() {
    this.forceAdvance = true;
  }

  reset() {
    this.currentTokenId = null;
    this.lastCandidateIds = [];
    this.forceAdvance = false;
  }

  getName() {
    return 'quota_exhausted';
  }
}

/**
 * 轮询策略：Request Count（请求计数）
 * 每个 token 处理固定次数的请求后切换
 */
class RequestCountStrategy extends TokenRotationStrategy {
  constructor(requestCountPerToken = 10) {
    super();
    this.requestCountPerToken = requestCountPerToken;
    this.currentIndex = 0;
    /** @type {Map<string, number>} */
    this.tokenRequestCounts = new Map();
  }

  selectToken(tokens, context) {
    if (tokens.length === 0) return null;
    
    const selected = tokens[this.currentIndex % tokens.length];
    return selected;
  }

  recordUsage(tokenId) {
    const current = this.tokenRequestCounts.get(tokenId) || 0;
    const newCount = current + 1;
    this.tokenRequestCounts.set(tokenId, newCount);
    
    // 如果达到阈值，标记需要切换
    if (newCount >= this.requestCountPerToken) {
      return true; // 返回 true 表示需要切换
    }
    return false;
  }

  /**
   * 切换到下一个 token
   * @param {number} totalTokens - token 总数
   * @param {string} currentTokenId - 当前 tokenId
   */
  switchToNext(totalTokens, currentTokenId) {
    if (totalTokens > 0) {
      this.currentIndex = (this.currentIndex + 1) % totalTokens;
      // 重置当前 token 的计数
      if (currentTokenId) {
        this.tokenRequestCounts.set(currentTokenId, 0);
      }
    }
  }

  /**
   * 重置指定 token 的计数
   * @param {string} tokenId - Token ID
   */
  resetCount(tokenId) {
    this.tokenRequestCounts.set(tokenId, 0);
  }

  /**
   * 获取指定 token 的请求计数
   * @param {string} tokenId - Token ID
   * @returns {number} 请求计数
   */
  getCount(tokenId) {
    return this.tokenRequestCounts.get(tokenId) || 0;
  }

  /**
   * 设置每个 token 的请求计数阈值
   * @param {number} count - 请求计数
   */
  setRequestCountPerToken(count) {
    if (count > 0) {
      this.requestCountPerToken = count;
    }
  }

  reset() {
    this.currentIndex = 0;
    this.tokenRequestCounts.clear();
  }

  getName() {
    return 'request_count';
  }
}

/**
 * 策略工厂
 */
class StrategyFactory {
  /**
   * 创建策略实例
   * @param {string} strategyName - 策略名称
   * @param {Object} options - 策略选项
   * @returns {TokenRotationStrategy} 策略实例
   */
  static create(strategyName, options = {}) {
    switch (strategyName) {
      case 'round_robin':
        return new RoundRobinStrategy();
      
      case 'quota_exhausted':
        return new QuotaExhaustedStrategy();
      
      case 'request_count':
        return new RequestCountStrategy(options.requestCountPerToken || 10);
      
      default:
        log.warn(`未知的轮询策略: ${strategyName}，使用默认策略 round_robin`);
        return new RoundRobinStrategy();
    }
  }

  /**
   * 获取所有支持的策略名称
   * @returns {Array<string>} 策略名称列表
   */
  static getSupportedStrategies() {
    return ['round_robin', 'quota_exhausted', 'request_count'];
  }

  /**
   * 验证策略名称是否有效
   * @param {string} strategyName - 策略名称
   * @returns {boolean} 是否有效
   */
  static isValidStrategy(strategyName) {
    return this.getSupportedStrategies().includes(strategyName);
  }
}

// 轮询策略枚举（保持向后兼容）
const RotationStrategy = {
  ROUND_ROBIN: 'round_robin',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  REQUEST_COUNT: 'request_count'
};

export {
  TokenRotationStrategy,
  RoundRobinStrategy,
  QuotaExhaustedStrategy,
  RequestCountStrategy,
  StrategyFactory,
  RotationStrategy
};