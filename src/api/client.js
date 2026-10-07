import { randomUUID } from 'crypto';
import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';
import { saveBase64Image } from '../utils/imageStorage.js';
import logger from '../utils/logger.js';
import memoryManager from '../utils/memoryManager.js';
import requesterManager from '../utils/requesterManager.js';
import { generateTrajectorybody } from '../utils/trajectory.js';
import { buildRecordCodeAssistMetricsBody } from '../utils/recordCodeAssistMetrics.js';
import { createTelemetryBatch, serializeTelemetryBatch } from "../utils/createTelemetry.js"
import { createLog1, createLog2 } from "../utils/additionalLogs.js"
import { buildClientRegister, buildFrontEnd, buildClientFeatrueHeaders, buildClientRegisterHeaders, buildFrontEndHeaders } from "../utils/unleash.js"
import { DEFAULT_RETRY_INTERVAL_MS, MODEL_LIST_CACHE_TTL, QA_PAIRS } from '../constants/index.js';
import { createApiError, InputTokenLimitError } from '../utils/errors.js';
import {
  assertInputTokensWithinLimit,
  estimateInputTokens,
  isInputTokenLimitError,
  parseUpstreamInputLimit,
  buildInputTokenLimitMessage,
  DEFAULT_INPUT_TOKEN_LIMIT
} from '../utils/inputTokenGuard.js';
import { generateCheckpointBody } from '../utils/checkPoint.js';
import axios from 'axios';
import {
  convertToToolCall,
  registerStreamMemoryCleanup
} from './stream_parser.js';
import { setSignature, shouldCacheSignature, isImageModel } from '../utils/thoughtSignatureCache.js';
import {
  isDebugDumpEnabled,
  createDumpId,
  createStreamCollector,
  collectStreamChunk,
  dumpFinalRequest,
  dumpStreamResponse,
  dumpFinalRawResponse
} from './debugDump.js';
import { getUpstreamStatus, readUpstreamErrorBody, isCallerDoesNotHavePermission } from './upstreamError.js';
import { detectAccountRisk, isAccountRisk, getRiskLabel } from '../utils/accountRiskDetector.js';
import { createStreamLineProcessor } from './streamLineProcessor.js';
import { runSseStream, postJsonAndParse } from './geminiTransport.js';
import { parseGeminiCandidateParts, toOpenAIUsage } from './geminiResponseParser.js';

// ==================== Token 计时器管理 ====================
const tokenTimers = new Map(); // { tokenKey: { lastUsed: timestamp, intervalId: intervalId } }
const TOKEN_TIMEOUT = 3 * 60 * 1000; // 3分钟
const BACKEND_CALL_INTERVAL = 60 * 1000; // 60秒
const checkPointList = new Set([]);

function getTokenKey(token) {
  return token.access_token;
}

/**
 * 上报一次后台代理请求失败，用于触发 WARP 快速自愈
 * （使用动态导入避免模块加载顺序耦合）
 * @param {string} reason
 */
function reportWarpNetworkFailure(reason) {
  import('../utils/warpManager.js')
    .then(m => m.default.reportNetworkFailure(reason))
    .catch(() => {});
}

function startTokenTimer(token) {
  const key = getTokenKey(token);
  const now = Date.now();

  if (tokenTimers.has(key)) {
    tokenTimers.get(key).lastUsed = now;
    return;
  }

  const runBackendCalls = () => {
    sendClientRegister(token).catch(err => {
      logger.warn('定时调用ClientRegister失败:', err.message);
      reportWarpNetworkFailure('定时遥测 ClientRegister 失败');
    });
    sendClientFeature(token).catch(err => {
      logger.warn('定时调用ClientFeature失败:', err.message);
      reportWarpNetworkFailure('定时遥测 ClientFeature 失败');
    });
    sendFrontEnd(token).catch(err => {
      logger.warn('定时调用FrontEnd失败:', err.message);
      reportWarpNetworkFailure('定时遥测 FrontEnd 失败');
    });
  };

  runBackendCalls();

  const intervalId = setInterval(runBackendCalls, BACKEND_CALL_INTERVAL);

  tokenTimers.set(key, { lastUsed: now, intervalId });
}

function checkTokenTimeout() {
  const now = Date.now();
  for (const [key, data] of tokenTimers.entries()) {
    if (now - data.lastUsed > TOKEN_TIMEOUT) {
      clearInterval(data.intervalId);
      tokenTimers.delete(key);
    }
  }
}

setInterval(checkTokenTimeout, 30 * 1000); // 每30秒检查一次超时

// ==================== 模型列表缓存（智能管理） ====================
const getModelCacheTTL = () => {
  return config.cache?.modelListTTL || MODEL_LIST_CACHE_TTL;
};

let modelListCache = null;
let modelListCacheTime = 0;

// 默认模型列表（当 API 请求失败时使用）
// 使用 Object.freeze 防止意外修改，并帮助 V8 优化
const DEFAULT_MODELS = Object.freeze([
  'claude-opus-4-6',
  'claude-opus-4-6-thinking',
  'claude-opus-4-7',
  'claude-opus-4-7-thinking',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking',
  'gemini-3.8-flash',
  'gemini-3.8-flash-cyber',
  'gemini-3.8-flash-thinking',
  'gemini-3.8-pro',
  'gemini-3.7-flash',
  'gemini-3.7-flash-tiered',
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low',
  'gemini-3.7-flash-thinking',
  'gemini-3.7-flash-lite',
  'gemini-3.7-pro',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-pro-high',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-image-4K',
  'gemini-3.1-flash-image-2K',
  'gemini-2.5-flash-thinking',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-3.1-pro-low',
  'chat_20706',
  'rev19-uic3-1p',
  'gpt-oss-120b-medium',
  'chat_23310'
]);

// 生成默认模型列表响应
function getDefaultModelList() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: DEFAULT_MODELS.map(id => ({
      id,
      object: 'model',
      created,
      owned_by: 'google'
    }))
  };
}


// 注册对象池与模型缓存的内存清理回调
function registerMemoryCleanup() {
  // 由流式解析模块管理自身对象池大小
  registerStreamMemoryCleanup();

  // 统一由内存清理器定时触发：仅清理"已过期"的模型列表缓存
  memoryManager.registerCleanup(() => {
    const ttl = getModelCacheTTL();
    const now = Date.now();
    if (modelListCache && (now - modelListCacheTime) > ttl) {
      modelListCache = null;
      modelListCacheTime = 0;
    }
  });
}

// 初始化时注册清理回调
registerMemoryCleanup();

// ==================== 辅助函数 ====================

function buildHeaders(token, hostOverride = null) {
  return {
    'Host': hostOverride || config.api.host,
    'User-Agent': config.api.userAgent,
    'Transfer-Encoding': 'chunked',
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip'
  };
}

// ==================== 上游 baseURL Fallback ====================

/**
 * 判断错误是否应触发 baseURL fallback
 * 429 不触发（交给 with429Retry 的三档处理）
 * 403/400 不触发（权限/请求错误，换 URL 没用）
 */
function shouldFallback(error) {
  // 如果已经向客户端发送过流数据，禁止 fallback（避免脏数据）
  if (error?._skipFallback) return false;
  const status = getUpstreamStatus(error);
  if (status === 429) return false;
  if (status === 403) return false;
  if (status === 400) return false;
  if (status === 503) return true;
  if (status >= 500) return true;
  // 网络错误/超时（无 status 或 fallback 默认 500）
  const code = error?.code || error?.cause?.code;
  const networkCodes = [
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
    'EAI_AGAIN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT'
  ];
  if (code && networkCodes.includes(code)) return true;
  if (error?.message?.includes('timeout')) return true;
  return false;
}

function getSafeUpstreamFallbackDelayMs() {
  const value = Number(config.retryIntervalMs);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_RETRY_INTERVAL_MS;
}

function shouldWaitBeforeFallback(error) {
  return getUpstreamStatus(error) === 503;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带上游 baseURL fallback 的执行器
 * 按 config.api.upstreamCandidates 顺序尝试，遇到 503/网络错误/5xx 时自动切换下一个
 * 503 属于容量/资源临时不可用，切换下一个上游前也按固定重试间隔等待
 * 429/403/400 等不 fallback，直接抛出让上层处理
 *
 * @param {Function} fn - (candidate) => Promise，candidate 包含 { name, url, noStreamUrl, host, ... }
 *                        candidate 为 null 时表示无候选列表，应使用默认 config
 * @returns {Promise<any>}
 */
async function withUpstreamFallback(fn) {
  const candidates = config.api.upstreamCandidates;
  if (!candidates || candidates.length === 0) {
    // 无候选列表，直接用默认配置执行
    return fn(null);
  }
  let lastError = null;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    try {
      return await fn(candidate);
    } catch (error) {
      lastError = error;
      if (!shouldFallback(error)) {
        throw error; // 429/403/400 等不应 fallback 的错误直接抛出
      }
      const status = getUpstreamStatus(error);
      const nextCandidate = candidates[index + 1];
      if (nextCandidate && shouldWaitBeforeFallback(error)) {
        const retryIntervalMs = getSafeUpstreamFallbackDelayMs();
        logger.warn(
          `[upstream-fallback] ${candidate.name} 失败 (${status || 'network error'}: ${error.message?.substring(0, 100)})，` +
          `等待固定间隔 ${retryIntervalMs}ms 后尝试下一个上游 ${nextCandidate.name}...`
        );
        await sleep(retryIntervalMs);
      } else {
        logger.warn(
          `[upstream-fallback] ${candidate.name} 失败 (${status || 'network error'}: ${error.message?.substring(0, 100)})，` +
          (nextCandidate ? `尝试下一个上游 ${nextCandidate.name}...` : '没有更多上游可尝试')
        );
      }
    }
  }
  logger.error('[upstream-fallback] 所有上游均失败');
  throw lastError;
}

/**
 * 发送上游前的输入 token 预检（本地启发式估算）
 *
 * 明显超过模型单次上限时直接抛出 InputTokenLimitError（400），
 * 避免把注定失败的请求发给上游、白白消耗账号额度与时间。
 * @param {any} requestBody - 即将发送给上游的完整请求体
 * @returns {{ tokens: number, images: number, limit: number, nearLimit: boolean }|null}
 */
function precheckInputTokens(requestBody) {
  try {
    const info = assertInputTokensWithinLimit(requestBody, config.inputTokenGuard);
    if (info?.nearLimit) {
      logger.warn(
        `⚠️ [输入超限预检] 本次输入约 ${info.tokens} token` +
        `（其中思考签名 ${info.signatureTokens} token / ${info.signatureChars} 字符），已接近模型上限 ${info.limit}`
      );
    }
    return info;
  } catch (error) {
    logger.warn(`⛔ [输入超限预检] ${error.message}`);
    // 打印估算值的主要来源（仅路径/长度/估算值，不含内容），便于判断是否误判
    if (Array.isArray(error.topContributors)) {
      for (const item of error.topContributors) {
        logger.warn(`   ↳ 估算来源 ${item.path} | ${item.kind} | ${item.chars} 字符 ≈ ${item.tokens} token`);
      }
    }
    throw error;
  }
}

// 统一错误处理
async function handleApiError(error, token, dumpId = null, context = {}) {
  const status = getUpstreamStatus(error);
  const errorBody = await readUpstreamErrorBody(error);

  if (dumpId) {
    await dumpFinalRawResponse(dumpId, String(errorBody ?? ''));
  }

  const errorStr = String(errorBody ?? '');

  // 输入上下文超过模型单次上限（如 1M token）：转成中文可读提示，
  // 避免用户把「上下文过大」误判成账号失效 / 额度耗尽
  if (isInputTokenLimitError(errorBody)) {
    const limit = parseUpstreamInputLimit(errorBody)
      || Number(config.inputTokenGuard?.limit)
      || DEFAULT_INPUT_TOKEN_LIMIT;
    const breakdown = context?.requestBody
      ? estimateInputTokens(context.requestBody, config.inputTokenGuard)
      : null;
    const estimatedTokens = Number(context?.estimatedTokens) > 0
      ? Number(context.estimatedTokens)
      : (breakdown ? breakdown.tokens : null);
    const signatureTokens = breakdown?.signatureTokens || null;
    const message = buildInputTokenLimitMessage({ estimatedTokens, limit, signatureTokens });
    logger.warn(`⚠️ [输入超限] ${message}`);
    // 打印上游原始报文与本地估算来源：用于核对「上游真实上限」与「估算是否失真」
    logger.warn(`⚠️ [输入超限] 上游原始报文(截断 800 字符): ${String(errorStr).slice(0, 800)}`);
    logger.warn(`⚠️ [输入超限] 命中状态码 ${status} | 模型 ${context?.requestBody?.model || '未知'} | 本地估算 ${estimatedTokens ?? '未知'} token | 其中思考签名 ${signatureTokens ?? 0} token`);
    if (breakdown) {
      for (const item of breakdown.top) {
        logger.warn(`   ↳ 估算来源 ${item.path} | ${item.kind} | ${item.chars} 字符 ≈ ${item.tokens} token`);
      }
    }
    throw new InputTokenLimitError(message, { estimatedTokens, limit, signatureTokens });
  }

  // 遇到地区限制/IP不受支持时，自动触发 WARP 重启更换出口 IP
  if (errorStr.includes('User location is not supported') || errorStr.includes('location is not supported')) {
    import('../utils/warpManager.js').then(m => {
      m.default.restartWarp('Google API 地区受限 (User location is not supported)').catch(() => {});
    });
  }

  if (status === 403) {
    if (isCallerDoesNotHavePermission(errorBody)) {
      throw createApiError(`超出模型最大上下文。错误详情: ${errorBody}`, status, errorBody);
    }

    // 风控识别（算法移植自 cockpit-tools）：
    // 区分「风控要求验证 / 违反条款被封禁 / 授权失效」，命中后自动禁用账号并记录处理链接
    const risk = detectAccountRisk(errorBody, status);
    if (isAccountRisk(risk.kind)) {
      await tokenManager.markTokenRisk(token, risk);
      const hints = [
        risk.validationUrl ? `请完成验证: ${risk.validationUrl}` : '',
        risk.appealUrl ? `申诉入口: ${risk.appealUrl}` : ''
      ].filter(Boolean).join('；');
      throw createApiError(
        `账号已被${getRiskLabel(risk.kind)}，已自动禁用。${hints}`,
        status,
        errorBody
      );
    }

    tokenManager.disableToken(token);
    throw createApiError(`该账号没有使用权限，已自动禁用。错误详情: ${errorBody}`, status, errorBody);
  }

  throw createApiError(`API请求失败 (${status}): ${errorBody}`, status, errorBody);
}


// ==================== 导出函数 ====================

export async function generateAssistantResponse(requestBody, token, callback) {
  startTokenTimer(token);
  precheckInputTokens(requestBody);
  const trajectoryId = requestBody.requestId.split('/')[2];
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const modelName = requestBody.model;
  const dumpId = isDebugDumpEnabled() ? createDumpId('stream') : null;
  const streamCollector = dumpId ? createStreamCollector() : null;
  let num = Math.floor(Math.random() * QA_PAIRS.length);
  if (dumpId) {
    await dumpFinalRequest(dumpId, requestBody);
  }
  //console.log(JSON.stringify(requestBody,null,2));

  try {
    // 追踪是否已经向客户端发送过流数据（用于防止 fallback 时产生脏数据）
    let hasEmittedData = false;
    const safeCallback = (...args) => {
      hasEmittedData = true;
      return callback(...args);
    };

    await withUpstreamFallback(async (candidate) => {
      const targetUrl = candidate?.url || config.api.url;
      const targetHost = candidate?.host || config.api.host;
      const headers = buildHeaders(token, targetHost);
      headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody)));

      // 每次 fallback 尝试都创建新的 state/processor（避免上一次尝试的脏状态）
      const state = {
        toolCalls: [],
        reasoningSignature: null,
        sessionId: requestBody.request?.sessionId,
        model: requestBody.model
      };
      const processor = createStreamLineProcessor({
        state,
        onEvent: safeCallback,
        onRawChunk: (chunk) => collectStreamChunk(streamCollector, chunk)
      });

      try {
        await runSseStream({
          url: targetUrl,
          headers,
          body: requestBody,
          processor,
          onErrorChunk: (chunk) => collectStreamChunk(streamCollector, chunk)
        });
      } catch (error) {
        try { processor.close(); } catch { }
        // 如果已经向客户端发送过数据，不能 fallback（否则客户端收到重复/混乱的流事件）
        if (hasEmittedData) {
          error._skipFallback = true;
        }
        throw error; // 让 withUpstreamFallback 判断是否 fallback
      }
    });

    // 流式响应结束后，以 JSON 格式写入日志
    if (dumpId) {
      await dumpStreamResponse(dumpId, streamCollector);
    }
    sendRecordCodeAssistMetrics(token, trajectoryId).catch(err => logger.warn('发送RecordCodeAssistMetrics失败:', err.message));
    sendRecordTrajectoryAnalytics(token, num, trajectoryId, messageId, conversationId, modelName).catch(err => logger.warn('发送轨迹分析失败:', err.message));
    sendLog(token, num, trajectoryId, conversationId, messageId).catch(err => logger.warn('发送log失败:', err.message));
    sendCheckPoint(token).catch(err => logger.warn('发送checkPoint失败:', err.message));;
  } catch (error) {
    await handleApiError(error, token, dumpId, { requestBody });
  }
}

// 内部工具：从远端拉取完整模型原始数据
async function fetchRawModels(headers, token) {
  try {
    const { data } = await requesterManager.fetch(config.api.modelsUrl, {
      method: 'POST',
      headers,
      body: {},
    });
    return data;
  } catch (error) {
    await handleApiError(error, token);
  }
}

export async function getAvailableModels() {
  // 检查缓存是否有效（动态 TTL）
  const now = Date.now();
  const ttl = getModelCacheTTL();
  if (modelListCache && (now - modelListCacheTime) < ttl) {
    return modelListCache;
  }

  const token = await tokenManager.getToken();
  if (!token) {
    // 没有 token 时返回默认模型列表
    logger.warn('没有可用的 token，返回默认模型列表');
    return getDefaultModelList();
  }

  const headers = buildHeaders(token);
  const data = await fetchRawModels(headers, token);
  if (!data) {
    // fetchRawModels 里已经做了统一错误处理，这里兜底为默认列表
    return getDefaultModelList();
  }

  const created = Math.floor(Date.now() / 1000);
  const modelList = Object.keys(data.models || {}).map(id => ({
    id,
    object: 'model',
    created,
    owned_by: 'google'
  }));

  // 添加默认模型（如果 API 返回的列表中没有）
  const existingIds = new Set(modelList.map(m => m.id));
  for (const defaultModel of DEFAULT_MODELS) {
    if (!existingIds.has(defaultModel)) {
      modelList.push({
        id: defaultModel,
        object: 'model',
        created,
        owned_by: 'google'
      });
    }
  }

  const result = {
    object: 'list',
    data: modelList
  };

  // 更新缓存
  modelListCache = result;
  modelListCacheTime = now;
  const currentTTL = getModelCacheTTL();
  logger.info(`模型列表已缓存 (有效期: ${currentTTL / 1000}秒, 模型数量: ${modelList.length})`);

  return result;
}

// 清除模型列表缓存（可用于手动刷新）
export function clearModelListCache() {
  modelListCache = null;
  modelListCacheTime = 0;
  logger.info('模型列表缓存已清除');
}

export async function getModelsWithQuotas(token) {
  const headers = buildHeaders(token);
  const data = await fetchRawModels(headers, token);
  if (!data) return {};

  // 请求 retrieveUserQuotaSummary 获取周限额 bucket (gemini-weekly / 3p-weekly)
  let userQuotaSummary = null;
  try {
    const targetHost = config.api.host || 'cloudcode-pa.googleapis.com';
    const summaryUrl = `https://${targetHost}/v1internal:retrieveUserQuotaSummary`;
    const summaryRes = await requesterManager.fetch(summaryUrl, {
      method: 'POST',
      headers,
      body: {}
    });
    userQuotaSummary = summaryRes?.data;
  } catch (err) {
    // 风控识别（关键信号）：账号被风控时该接口返回 403，响应体携带 google.rpc.ErrorInfo
    // （reason = VALIDATION_REQUIRED / TOS_VIOLATION）以及验证链接。
    // 该调用在「额度定时同步」中会对每个启用账号执行，因此账号即使长时间空闲也能被及时发现并禁用。
    try {
      const riskBody = await readUpstreamErrorBody(err);
      const risk = detectAccountRisk(
        riskBody,
        err?.response?.status || err?.status || 403,
        { requireExplicitReason: true } // 后台探测要求明确 reason，避免仅凭 403 误判
      );
      if (isAccountRisk(risk.kind)) {
        await tokenManager.markTokenRisk(token, risk);
      } else {
        logger.warn('获取 retrieveUserQuotaSummary 失败:', err.message);
      }
    } catch (detectError) {
      logger.warn('获取 retrieveUserQuotaSummary 失败:', err.message);
    }
  }

  // 从 retrieveUserQuotaSummary 提取周额度 bucket 信息
  const groupWeeklyQuotas = {};
  if (userQuotaSummary && Array.isArray(userQuotaSummary.groups)) {
    userQuotaSummary.groups.forEach(group => {
      const groupName = group.displayName || '';
      const is3p = groupName.toLowerCase().includes('claude') || groupName.toLowerCase().includes('gpt') || groupName.includes('3p');
      const groupKey = is3p ? 'claude' : 'gemini';

      const buckets = group.buckets || [];
      const weeklyBucket = buckets.find(b => b.window === 'weekly' || (b.bucketId && b.bucketId.includes('weekly')));
      if (weeklyBucket) {
        groupWeeklyQuotas[groupKey] = {
          wr: weeklyBucket.remainingFraction ?? null,
          wt: weeklyBucket.resetTime ?? null
        };
      }
    });
  }

  const quotas = {};
  Object.entries(data.models || {}).forEach(([modelId, modelData]) => {
    const qInfo = modelData.quotaInfo || {};
    const is3pModel = modelId.toLowerCase().includes('claude') || modelId.toLowerCase().includes('gpt');
    const groupKey = is3pModel ? 'claude' : 'gemini';
    const groupWeekly = groupWeeklyQuotas[groupKey] || {};

    const wInfo = modelData.weeklyQuotaInfo || modelData.weeklyQuota || (Array.isArray(modelData.quotaInfos) ? modelData.quotaInfos[1] : null) || {};

    quotas[modelId] = {
      r: qInfo.remainingFraction !== undefined ? qInfo.remainingFraction : null,
      t: qInfo.resetTime || null,
      wr: wInfo.remainingFraction ?? qInfo.weeklyRemainingFraction ?? groupWeekly.wr ?? null,
      wt: wInfo.resetTime ?? qInfo.weeklyResetTime ?? groupWeekly.wt ?? null
    };
  });

  return quotas;
}

export async function generateAssistantResponseNoStream(requestBody, token) {
  startTokenTimer(token);
  precheckInputTokens(requestBody);
  const trajectoryId = requestBody.requestId.split('/')[2];
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const modelName = requestBody.model;
  const dumpId = isDebugDumpEnabled() ? createDumpId('no_stream') : null;
  let num = Math.floor(Math.random() * QA_PAIRS.length);

  if (dumpId) await dumpFinalRequest(dumpId, requestBody);
  let data;
  try {
    data = await withUpstreamFallback(async (candidate) => {
      const targetUrl = candidate?.noStreamUrl || config.api.noStreamUrl;
      const targetHost = candidate?.host || config.api.host;
      const headers = buildHeaders(token, targetHost);
      headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody)));

      return postJsonAndParse({
        url: targetUrl,
        headers,
        body: requestBody,
        dumpId,
        dumpFinalRawResponse,
        rawFormat: 'json'
      });
    });
    sendRecordCodeAssistMetrics(token, trajectoryId).catch(err => logger.warn('发送RecordCodeAssistMetrics失败:', err.message));
    sendRecordTrajectoryAnalytics(token, num, trajectoryId, messageId, conversationId, modelName).catch(err => logger.warn('发送轨迹分析失败:', err.message));
    sendLog(token, num, trajectoryId, conversationId, messageId).catch(err => logger.warn('发送log失败:', err.message));
  } catch (error) {
    await handleApiError(error, token, dumpId, { requestBody });
  }
  //console.log(JSON.stringify(data));
  const parts = data.response?.candidates?.[0]?.content?.parts || [];
  const parsed = parseGeminiCandidateParts({
    parts,
    sessionId: requestBody.request?.sessionId,
    model: requestBody.model,
    convertToToolCall,
    saveBase64Image
  });

  const usageData = toOpenAIUsage(data.response?.usageMetadata);

  // 将新的签名和思考内容写入全局缓存（按 model），供后续请求兜底使用
  const sessionId = requestBody.request?.sessionId;
  const model = requestBody.model;
  const hasTools = parsed.toolCalls.length > 0;
  const isImage = isImageModel(model);

  // 判断是否应该缓存签名
  if (sessionId && model && shouldCacheSignature({ hasTools, isImageModel: isImage })) {
    // 获取最终使用的签名（优先使用工具签名，回退到思维签名）
    let finalSignature = parsed.reasoningSignature;

    // 工具签名：取最后一个带 thoughtSignature 的工具作为缓存源（更接近"最新"）
    if (hasTools) {
      for (let i = parsed.toolCalls.length - 1; i >= 0; i--) {
        const sig = parsed.toolCalls[i]?.thoughtSignature;
        if (sig) {
          finalSignature = sig;
          break;
        }
      }
    }

    if (finalSignature) {
      const cachedContent = parsed.reasoningContent || ' ';
      setSignature(sessionId, model, finalSignature, cachedContent, { hasTools, isImageModel: isImage });
    }
  }

  // 生图模型：转换为 markdown 格式
  if (parsed.imageUrls.length > 0) {
    let markdown = parsed.content ? parsed.content + '\n\n' : '';
    markdown += parsed.imageUrls.map(url => `![image](${url})`).join('\n\n');
    return { content: markdown, reasoningContent: parsed.reasoningContent, reasoningSignature: parsed.reasoningSignature, toolCalls: parsed.toolCalls, usage: usageData };
  }

  return { content: parsed.content, reasoningContent: parsed.reasoningContent, reasoningSignature: parsed.reasoningSignature, toolCalls: parsed.toolCalls, usage: usageData };
}

export async function generateImageForSD(requestBody, token) {
  startTokenTimer(token);
  precheckInputTokens(requestBody);
  const trajectoryId = requestBody.requestId.split('/')[2];
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const modelName = requestBody.model;
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody), 'utf-8'));
  let num = Math.floor(Math.random() * QA_PAIRS.length);

  //console.log(JSON.stringify(requestBody,null,2));

  let data;
  try {
    const result = await requesterManager.fetch(config.api.noStreamUrl, {
      method: 'POST',
      headers,
      body: requestBody,
    });
    data = result.data;
  } catch (error) {
    await handleApiError(error, token, null, { requestBody });
  }
  sendRecordCodeAssistMetrics(token, trajectoryId).catch(err => logger.warn('发送RecordCodeAssistMetrics失败:', err.message));
  sendRecordTrajectoryAnalytics(token, num, trajectoryId, messageId, conversationId, modelName).catch(err => logger.warn('发送轨迹分析失败:', err.message));
  sendLog(token, num, trajectoryId, conversationId, messageId).catch(err => logger.warn('发送log失败:', err.message));

  const parts = data.response?.candidates?.[0]?.content?.parts || [];
  const images = parts.filter(p => p.inlineData).map(p => p.inlineData.data);

  return images;
}

export async function sendRecordTrajectoryAnalytics(token, num, trajectoryId, executionId, cascadeId, modelName = "claude-opus-4-6-thinking") {
  const trajectorybody = generateTrajectorybody(num, trajectoryId, executionId, cascadeId, modelName, token);
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(trajectorybody)));
  try {
    await requesterManager.fetch(config.api.recordTrajectory, {
      method: 'POST',
      headers,
      body: trajectorybody,
      okStatus: [200],
    });
  } catch (error) {
    throw new Error(`轨迹分析请求失败 (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendLog(token, num, trajectoryId, conversationId, messageId) {
  const sessionId = trajectoryId;
  //const conversationId = randomUUID();

  const logs = [
    createLog2(conversationId, token, sessionId),
    createTelemetryBatch(num, sessionId, conversationId, messageId, token.sub),
    createLog1(conversationId, token, sessionId)
  ];

  const headers = buildHeaders(token);
  headers["Host"] = "play.googleapis.com";
  headers["User-Agent"] = "Go-http-client/1.1";
  headers["Content-Type"] = "application/octet-stream";
  headers["Accept-Encoding"] = "gzip";

  // TLS 请求器暂不支持二进制 body，此处固定使用 axios
  try {
    for (const log of logs) {
      const serializeData = serializeTelemetryBatch(log);
      if (!serializeData.success) {
        throw new Error(`Telemetry proto 序列化失败: ${serializeData.error}`);
      }
      const serializeLogBody = serializeData.data;
      headers["Content-Length"] = String(serializeLogBody.length);

      await axios({
        method: 'POST',
        url: "https://play.googleapis.com/log",
        headers,
        data: serializeLogBody
      });
    }
  } catch (error) {
    throw error;
  }
}

export async function sendRecordCodeAssistMetrics(token, trajectoryId) {
  const requestBody = buildRecordCodeAssistMetricsBody(token, trajectoryId);
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody), 'utf-8'));
  try {
    await requesterManager.fetch(config.api.recordCodeAssistMetrics, {
      method: 'POST',
      headers,
      body: requestBody,
      okStatus: [200],
    });
  } catch (error) {
    throw new Error(`RecordCodeAssistMetrics请求失败 (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendClientRegister(token) {
  const requestBody = buildClientRegister(token);
  const headers = buildClientRegisterHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody), 'utf-8'));
  try {
    await requesterManager.fetch(config.api.unleash.register, {
      method: 'POST',
      headers,
      body: requestBody,
      okStatus: [200, 202],
    });
  } catch (error) {
    throw new Error(`ClientRegister请求失败 (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendClientFeature(token) {
  const headers = buildClientFeatrueHeaders(token);
  //console.log(headers);
  try {
    await requesterManager.fetch(config.api.unleash.features, {
      method: 'GET',
      headers,
      okStatus: [200, 202],
    });
  } catch (error) {
    throw new Error(`ClientFeature请求失败 (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendFrontEnd(token) {
  const requestBody = buildFrontEnd(token);
  const headers = buildFrontEndHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody), 'utf-8'));
  try {
    await requesterManager.fetch(config.api.unleash.frontend, {
      method: 'POST',
      headers,
      body: requestBody,
      okStatus: [200, 202],
    });
  } catch (error) {
    throw new Error(`FrontEnd请求失败 (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendCheckPoint(token) {
  const requestBody = generateCheckpointBody(token);
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody), 'utf-8'));
  if (checkPointList.has(token.sessionId)) {
    return;
  } else {
    checkPointList.add(token.sessionId);
  }
  try {
    await requesterManager.fetch(config.api.url, {
      method: 'POST',
      headers,
      body: requestBody,
      okStatus: [200, 202],
    });
  } catch (error) {
    throw new Error(`CheckPoint请求失败 (${error.status ?? ''}): ${error.message}`);
  }
}

// 导出内存清理注册函数（供外部调用）
export { registerMemoryCleanup };
