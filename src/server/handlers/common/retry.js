import config from '../../../config/config.js';
import { DEFAULT_RETRY_INTERVAL_MS, LONG_COOLDOWN_THRESHOLD } from '../../../constants/index.js';
import tokenCooldownManager from '../../../auth/token_cooldown_manager.js';
import { getGroupKey } from '../../../utils/modelGroups.js';
import { hasOtherAvailableModelGroups, getAvailableModelGroups } from '../../../utils/tokenQuotaHelper.js';
import logger from '../../../utils/logger.js';

/**
 * 重试次数规范化工具
 * @param {any} retryTimes
 * @returns {number}
 */
export function getSafeRetries(retryTimes) {
  const maxRetries = Number(retryTimes || 0);
  return maxRetries > 0 ? Math.floor(maxRetries) : 0;
}

/**
 * 固定重试间隔规范化工具
 * @param {any} retryIntervalMs
 * @returns {number}
 */
export function getSafeRetryIntervalMs(retryIntervalMs) {
  const value = Number(retryIntervalMs);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_RETRY_INTERVAL_MS;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseDurationToMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== 'string') return null;

  const s = value.trim();
  if (!s) return null;

  const msMatch = s.match(/^(\d+(\.\d+)?)\s*ms$/i);
  if (msMatch) return Math.max(0, Math.floor(Number(msMatch[1])));

  const secMatch = s.match(/^(\d+(\.\d+)?)\s*s$/i);
  if (secMatch) return Math.max(0, Math.floor(Number(secMatch[1]) * 1000));

  const num = Number(s);
  if (Number.isFinite(num)) return Math.max(0, Math.floor(num));
  return null;
}

function tryParseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    const first = value.indexOf('{');
    const last = value.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return JSON.parse(value.slice(first, last + 1));
      } catch { }
    }
    return null;
  }
}

function extractUpstreamErrorBody(error) {
  if (error?.isUpstreamApiError && error.rawBody) {
    return tryParseJson(error.rawBody) || error.rawBody;
  }
  if (error?.response?.data) {
    return tryParseJson(error.response.data) || error.response.data;
  }
  return tryParseJson(error?.message);
}

function getErrorDetails(body) {
  const root = body && typeof body === 'object' ? body : null;
  const inner = root?.error || root;
  return Array.isArray(inner?.details) ? inner.details : [];
}

function collectRetryHintsFromObject(obj, hints) {
  if (!obj || typeof obj !== 'object') return;

  const durationKeys = [
    'retryDelay',
    'quotaResetDelay',
    'retryAfter',
    'retry_after',
    'delay'
  ];

  for (const key of durationKeys) {
    const ms = parseDurationToMs(obj[key]);
    if (ms !== null) hints.delays.push(ms);
  }

  const timestampKeys = [
    'quotaResetTimeStamp',
    'quotaResetTimestamp',
    'resetTime',
    'resetTimestamp',
    'retryAt'
  ];

  for (const key of timestampKeys) {
    const value = obj[key];
    if (typeof value !== 'string') continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) hints.timestamps.push(timestamp);
  }
}

/**
 * 从上游错误响应体中提取重试提示。
 * 没有显式 retryDelay / quotaResetDelay / quotaResetTimeStamp 时返回 hasRetryHint=false。
 * @param {Error} error
 * @returns {{body: any, details: Array, explicitDelayMs: number|null, resetTimestamp: number|null, reason: string|null, hasRetryHint: boolean}}
 */
export function getRetryHint(error) {
  const body = extractUpstreamErrorBody(error);
  const details = getErrorDetails(body);
  const hints = { delays: [], timestamps: [] };

  const root = body && typeof body === 'object' ? body : null;
  const inner = root?.error || root;
  collectRetryHintsFromObject(inner, hints);

  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue;
    collectRetryHintsFromObject(detail, hints);
    collectRetryHintsFromObject(detail.metadata, hints);
  }

  const resetTimestamp = hints.timestamps.length > 0
    ? Math.max(...hints.timestamps)
    : null;

  const resetDelay = resetTimestamp !== null
    ? Math.max(0, resetTimestamp - Date.now())
    : null;

  const delayCandidates = [...hints.delays];
  if (resetDelay !== null) delayCandidates.push(resetDelay);

  const explicitDelayMs = delayCandidates.length > 0 ? Math.max(...delayCandidates) : null;
  const reason = details.find(detail => detail?.reason)?.reason || inner?.status || null;

  return {
    body,
    details,
    explicitDelayMs,
    resetTimestamp,
    reason,
    hasRetryHint: explicitDelayMs !== null || resetTimestamp !== null
  };
}

function stringifyErrorBody(body, fallbackMessage) {
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body || fallbackMessage || '');
  } catch {
    return String(fallbackMessage || '');
  }
}

function hasQuotaExhaustionSignal(error, hint) {
  const text = stringifyErrorBody(hint.body, error?.message).toLowerCase();
  return (
    text.includes('quota') ||
    text.includes('exhaust') ||
    text.includes('resource_exhausted') ||
    text.includes('limit exceeded') ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('额度')
  );
}

function isLongQuotaCooldown(status, error, hint, thresholdMs) {
  return (
    status === 429 &&
    hint.explicitDelayMs !== null &&
    hint.explicitDelayMs >= thresholdMs &&
    hasQuotaExhaustionSignal(error, hint)
  );
}

function normalizeRetryOptions(options, legacyOnAttempt) {
  if (typeof options === 'string') {
    return {
      loggerPrefix: options,
      onAttempt: legacyOnAttempt
    };
  }
  return options && typeof options === 'object' ? options : {};
}

function getCurrentTokenId(options) {
  if (typeof options.getTokenId === 'function') return options.getTokenId();
  return options.tokenId || null;
}

// ==================== 额度自动刷新（节流） ====================
// 修复「额度阈值不生效」的关键环节：原先 refreshQuota 从未被调用，
// quotaManager 的额度缓存长期为空，阈值过滤形同虚设（same token 一直被用到耗尽）。
// 这里在真实请求路径上自动刷新额度数据，并按 tokenId 做节流，避免频繁打上游。
const QUOTA_REFRESH_MIN_INTERVAL_MS = 3 * 60 * 1000;   // 常规成功路径：每账号最多 3 分钟刷一次
const QUOTA_REFRESH_FORCE_GAP_MS = 30 * 1000;          // 429 长冷却(额度耗尽)时：每账号最多 30 秒刷一次
const quotaRefreshTimestamps = new Map();

async function maybeRefreshQuota(options, { loggerPrefix = '', force = false } = {}) {
  if (typeof options.refreshQuota !== 'function') return false;

  const tokenId = getCurrentTokenId(options);
  if (!tokenId) return false;

  const now = Date.now();
  const lastRefresh = quotaRefreshTimestamps.get(tokenId) || 0;
  const minGap = force ? QUOTA_REFRESH_FORCE_GAP_MS : QUOTA_REFRESH_MIN_INTERVAL_MS;
  if (now - lastRefresh < minGap) return false;

  quotaRefreshTimestamps.set(tokenId, now);

  try {
    await options.refreshQuota();
    logger.info(`${loggerPrefix}已自动刷新额度缓存 [${tokenId}]`);
    return true;
  } catch (error) {
    logger.warn(`${loggerPrefix}自动刷新额度失败 [${tokenId}]: ${error.message}`);
    return false;
  }
}

function getCurrentToken(options) {
  if (typeof options.getToken === 'function') return options.getToken();
  return options.token || null;
}

async function applyLongQuotaCooldown({ options, loggerPrefix, modelId, hint, thresholdMs }) {
  const tokenId = getCurrentTokenId(options);
  if (!tokenId || !modelId) return;

  const cooldownUntil = hint.resetTimestamp || (Date.now() + hint.explicitDelayMs);
  if (!cooldownUntil || cooldownUntil <= Date.now()) return;

  const groupKey = getGroupKey(modelId);
  const delayMinutes = Math.round((cooldownUntil - Date.now()) / 1000 / 60);
  const thresholdMinutes = Math.round(thresholdMs / 1000 / 60);

  logger.warn(
    `${loggerPrefix}[长冷却] 收到 429 额度耗尽，恢复时间约 ${delayMinutes} 分钟后，` +
    `超过阈值(${thresholdMinutes}分钟)，禁用 token ${tokenId} 的 ${groupKey} 系列`
  );

  tokenCooldownManager.setCooldown(tokenId, modelId, cooldownUntil);

  if (!hasOtherAvailableModelGroups(tokenId)) {
    logger.warn(`${loggerPrefix}Token ${tokenId} 的所有核心模型组都已禁用，标记为配额耗尽`);
    const tokenManager = options.tokenManager || null;
    const token = getCurrentToken(options);
    if (tokenManager && token) {
      try {
        await tokenManager.markTokenQuotaExhausted(token);
      } catch (error) {
        logger.error(`${loggerPrefix}标记 token 配额耗尽失败: ${error.message}`);
      }
    }
  } else {
    const availableGroups = getAvailableModelGroups(tokenId);
    logger.info(`${loggerPrefix}Token ${tokenId} 仍有其他可用模型组: ${availableGroups.join(', ')}`);
  }
}

async function prepareNextAttempt(options, context) {
  if (typeof options.onBeforeRetry !== 'function') return true;
  const result = await options.onBeforeRetry(context);
  return result !== false;
}

function getStatus(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status);
}

/**
 * 带 429/503 重试的执行器。
 * 核心策略：
 * - 429 只有上游错误响应体能提取到等待间隔/恢复时间时才重试。
 * - 503 容量/资源临时不可用直接按固定间隔重试，不依赖上游等待提示。
 * - 实际等待时间使用配置的固定间隔，避免短间隔把 503 打成 429。
 * - 长时间 429 额度耗尽会进入模型组冷却；只有开启重试轮询可用 token 时才继续尝试。
 *
 * @param {Function} fn - 要执行的异步函数，接收 attempt 和 shouldUseCredits 参数
 * @param {number} maxRetries - 最大重试次数
 * @param {Object|string} options - 可选参数或旧版 loggerPrefix
 * @param {Function|null} legacyOnAttempt - 旧版调用方式的尝试回调
 * @returns {Promise<any>}
 */
export async function with429Retry(fn, maxRetries, options = {}, legacyOnAttempt = null) {
  const retryOptions = normalizeRetryOptions(options, legacyOnAttempt);
  const loggerPrefix = retryOptions.loggerPrefix || '';
  const retries = getSafeRetries(maxRetries);
  const retryIntervalMs = getSafeRetryIntervalMs(config.retryIntervalMs);
  const longCooldownThreshold = config.retryLongCooldownThresholdMs || LONG_COOLDOWN_THRESHOLD;
  const canPollTokenForRetry = config.retryPollTokenWithQuota === true && typeof retryOptions.onBeforeRetry === 'function';

  let attempt = 0;
  let shouldUseCredits = false;

  while (true) {
    try {
      if (typeof retryOptions.onAttempt === 'function') {
        retryOptions.onAttempt(attempt);
      }
      const result = await fn(attempt, shouldUseCredits);
      // 成功路径：后台异步刷新额度（按 tokenId 节流，不阻塞响应），
      // 保证「额度耗尽切换」阈值判断始终基于新鲜数据
      maybeRefreshQuota(retryOptions, { loggerPrefix }).catch(() => {});
      return result;
    } catch (error) {
      const status = getStatus(error);
      if (status !== 429 && status !== 503) {
        throw error;
      }

      const hint = getRetryHint(error);
      const errorType = status === 503 ? '503' : '429';
      const modelId = retryOptions.modelId || null;
      const previousTokenId = getCurrentTokenId(retryOptions);

      if (status === 429 && !hint.hasRetryHint) {
        logger.warn(`${loggerPrefix}收到 429，但错误响应体未提供等待间隔/恢复时间，按不可重试处理`);
        throw error;
      }

      const longQuotaCooldown = isLongQuotaCooldown(status, error, hint, longCooldownThreshold);
      if (longQuotaCooldown) {
        await applyLongQuotaCooldown({ options: retryOptions, loggerPrefix, modelId, hint, thresholdMs: longCooldownThreshold });
        // 429 额度耗尽：强制刷新该账号额度（按最小间隔节流），让本地缓存与上游真实状态对齐
        maybeRefreshQuota(retryOptions, { loggerPrefix, force: true }).catch(() => {});
        if (!canPollTokenForRetry) {
          throw error;
        }
      }

      if (attempt >= retries) {
        throw error;
      }

      const nextAttempt = attempt + 1;
      if (!config.alwaysUseCredits && !shouldUseCredits) {
        shouldUseCredits = true;
      }

      const hintText = hint.hasRetryHint
        ? `（上游提示≈${hint.explicitDelayMs}ms）`
        : '（上游未提示等待时间）';

      logger.warn(
        `${loggerPrefix}收到 ${errorType}，等待固定间隔 ${retryIntervalMs}ms 后进行第 ${nextAttempt} 次重试（共 ${retries} 次）` +
        hintText +
        (shouldUseCredits ? '（使用积分）' : '') +
        (canPollTokenForRetry ? '（重试前重新轮询可用Token）' : '')
      );

      await sleep(retryIntervalMs);

      const prepared = await prepareNextAttempt(retryOptions, {
        attempt,
        nextAttempt,
        status,
        error,
        hint,
        previousTokenId,
        modelId,
        longQuotaCooldown
      });

      if (!prepared) {
        logger.warn(`${loggerPrefix}重试前未找到对模型 ${modelId || 'unknown'} 可用的 token，终止重试`);
        throw error;
      }

      attempt = nextAttempt;
    }
  }
}
