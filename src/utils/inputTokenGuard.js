/**
 * 输入 Token 预估与上限守卫
 *
 * Google Antigravity / Gemini 单次请求的输入上限为 1,048,576 (2^20) token，
 * 超出时上游返回：
 *   400 INVALID_ARGUMENT: The input token count exceeds the maximum number of tokens allowed 1048576.
 *
 * 本地无法精确分词（与上游 tokenizer 存在差异），因此这里使用启发式估算：
 *   - CJK 字符（中/日/韩）≈ 1 token / 字符
 *   - 其他字符 ≈ 1 token / 4 字符
 *   - 内联 base64 图片 ≈ 固定估值（若按 base64 长度换算会严重高估）
 *
 * 估算值有两个用途：
 *   1. 请求发出前预检，明显超限时提前拦截（避免无谓的上游请求与账号消耗）
 *   2. 上游返回超限 400 时，在中文提示里给出参考数值
 * 估算值不参与精确计费，仅作提示。
 */

import { InputTokenLimitError } from './errors.js';

/** Gemini / Antigravity 单次请求输入上限 */
export const DEFAULT_INPUT_TOKEN_LIMIT = 1048576;

/** 单张内联图片的 token 估算值（Gemini 大图约 1K token 量级） */
const DEFAULT_IMAGE_TOKEN_ESTIMATE = 1300;

/** 判定为 base64 图片数据的最小长度，避免把普通短字符串当图片 */
const BASE64_BLOB_MIN_LENGTH = 256;

/** 视为内联图片数据的键名（不区分大小写） */
const IMAGE_DATA_KEYS = new Set(['data', 'base64', 'imagedata', 'imagedataurl']);

/**
 * 思考签名类字段：上游不计入输入 token（实测验证）
 *
 * 实测：在请求中回传一个 1244 字符的真实 thoughtSignature，
 * 上游返回的 prompt_tokens 只增加 8（即新增文本本身），签名本身不计入。
 * 而线上真实签名单个可达 12.6 万字符，若不排除会让估算值虚高数万 token/个，
 * 造成「明明没超限却被提前拦截」的误判。
 */
const SIGNATURE_KEYS = new Set([
  'thoughtsignature',
  'signature',
  'reasoningsignature',
  'toolsignature',
  'thinkingsignature'
]);

/** 默认安全余量：估算值超过上限的 (1 + safetyRatio) 倍才拦截，避免启发式高估误伤 */
const DEFAULT_SAFETY_RATIO = 0.15;

/** 递归遍历深度上限，防御异常深的对象 */
const MAX_WALK_DEPTH = 32;

/** 默认接近上限的告警比例 */
const DEFAULT_WARN_RATIO = 0.9;

const CJK_CHAR_RE = /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

/** data URL 形式的图片（OpenAI 视觉接口常见：data:image/png;base64,xxxx） */
const DATA_URL_IMAGE_RE = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i;

/**
 * 判断字符串是否为内联图片数据
 * 只认明确的信号（data URL 前缀），避免把普通长文本误判成图片
 * @param {string} value
 * @returns {boolean}
 */
export function isInlineImageValue(value) {
  if (typeof value !== 'string' || value.length < BASE64_BLOB_MIN_LENGTH) return false;
  return DATA_URL_IMAGE_RE.test(value);
}

/**
 * 估算一段文本的 token 数
 * @param {string} text
 * @returns {number}
 */
export function estimateTextTokens(text) {
  if (typeof text !== 'string' || !text) return 0;
  const cjkMatches = text.match(CJK_CHAR_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount + otherCount / 4);
}

/**
 * 递归估算请求体（最终发送给上游的 JSON 结构）的输入 token 数
 * @param {any} payload
 * @param {{ imageTokenEstimate?: number }} [options]
 * @returns {{ tokens: number, images: number }}
 */
export function estimateInputTokens(payload, options = {}) {
  const imageTokenEstimate = Number(options.imageTokenEstimate) > 0
    ? Number(options.imageTokenEstimate)
    : DEFAULT_IMAGE_TOKEN_ESTIMATE;

  let tokens = 0;
  let images = 0;
  const visited = new WeakSet();
  const contributions = [];

  const record = (path, chars, valueTokens, kind) => {
    contributions.push({ path, chars, tokens: valueTokens, kind });
  };

  const walk = (node, depth, path) => {
    if (node === null || node === undefined || depth > MAX_WALK_DEPTH) return;

    const type = typeof node;
    if (type === 'string') {
      // 内联图片（OpenAI 的 data URL / 直接 base64 数据）：按固定估值计，
      // 否则上百万字符的 base64 会被当成文本严重高估
      if (isInlineImageValue(node)) {
        images += 1;
        tokens += imageTokenEstimate;
        record(path, node.length, imageTokenEstimate, 'image');
        return;
      }
      const valueTokens = estimateTextTokens(node);
      tokens += valueTokens;
      record(path, node.length, valueTokens, 'text');
      return;
    }
    if (type !== 'object') return;

    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) walk(node[i], depth + 1, `${path}[${i}]`);
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (value === null || value === undefined) continue;
      const lowerKey = key.toLowerCase();
      const childPath = path ? `${path}.${key}` : key;

      // 思考签名：上游不计入输入 token，仅记录长度用于排障
      if (typeof value === 'string' && SIGNATURE_KEYS.has(lowerKey)) {
        record(childPath, value.length, 0, 'signature');
        continue;
      }

      if (typeof value === 'string'
        && IMAGE_DATA_KEYS.has(lowerKey)
        && value.length >= BASE64_BLOB_MIN_LENGTH) {
        images += 1;
        tokens += imageTokenEstimate;
        record(childPath, value.length, imageTokenEstimate, 'image');
        continue;
      }
      walk(value, depth + 1, childPath);
    }
  };

  walk(payload, 0, '');

  // 只保留占用最大的若干项，用于排障时说明「估算值从哪来」（不含内容，避免泄露对话）
  contributions.sort((a, b) => b.tokens - a.tokens);
  const top = contributions.slice(0, 5).map(c => ({ ...c, path: c.path || '(root)' }));

  return { tokens, images, top };
}

function stringifyErrorBody(errorBody) {
  if (errorBody === null || errorBody === undefined) return '';
  if (typeof errorBody === 'string') return errorBody;
  try {
    return JSON.stringify(errorBody);
  } catch {
    return String(errorBody);
  }
}

/**
 * 判断上游错误报文是否为「输入上下文超限」
 * @param {string|Object} errorBody
 * @returns {boolean}
 */
export function isInputTokenLimitError(errorBody) {
  const lower = stringifyErrorBody(errorBody).toLowerCase();
  if (!lower) return false;
  if (lower.includes('input token count exceeds')) return true;
  if (lower.includes('exceeds the maximum number of tokens allowed')) return true;
  if (lower.includes('input is too long')) return true;
  if (lower.includes('too many tokens')) return true;
  if (lower.includes('context length') && lower.includes('exceed')) return true;
  // OpenAI 风格：This model's maximum context length is 128000 tokens, however you requested 200000.
  if (lower.includes('maximum context length')) return true;
  if (lower.includes('context_length_exceeded')) return true;
  if (lower.includes('prompt is too long')) return true;
  return false;
}

/**
 * 从上游报文里解析真实上限，例如 "... allowed 1048576."
 * @param {string|Object} errorBody
 * @returns {number|null}
 */
export function parseUpstreamInputLimit(errorBody) {
  const text = stringifyErrorBody(errorBody);
  if (!text) return null;
  const match = text.match(/allowed\s+(\d{4,})/i) || text.match(/(?:limit|maximum)\D{0,12}(\d{5,})/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 把 token 数格式化为便于阅读的字符串
 * @param {number} value
 * @returns {string}
 */
export function formatTokenCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '0';
  if (num >= 10000) return `${(num / 10000).toFixed(1)} 万`;
  return String(Math.round(num));
}

/**
 * 构建中文可读的「输入超限」提示
 * @param {{ estimatedTokens?: number|null, limit?: number|null, precheck?: boolean }} [options]
 * @returns {string}
 */
export function buildInputTokenLimitMessage(options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : DEFAULT_INPUT_TOKEN_LIMIT;
  const estimatedTokens = Number(options.estimatedTokens) > 0 ? Number(options.estimatedTokens) : null;

  const limitText = `${formatTokenCount(limit)} token（${limit.toLocaleString('en-US')}）`;
  const estimateText = estimatedTokens ? `，本次请求约 ${formatTokenCount(estimatedTokens)} token（本地估算，仅供参考）` : '';
  const head = options.precheck
    ? '请求已被提前拦截：输入内容超过模型单次上限'
    : '输入内容超过模型单次上限';

  return `${head}：上限 ${limitText}${estimateText}。请新建会话、精简历史消息，或减少粘贴的文本 / 图片 / 附件后重试。`;
}

/**
 * 请求发出前的输入 token 预检
 *
 * 明显超限时抛出 InputTokenLimitError（400），否则返回估算结果。
 * @param {any} payload - 即将发送给上游的完整请求体
 * @param {{ enabled?: boolean, limit?: number, warnRatio?: number, safetyRatio?: number, imageTokenEstimate?: number }} [options]
 * @returns {{ tokens: number, images: number, limit: number, nearLimit: boolean }|null}
 */
export function assertInputTokensWithinLimit(payload, options = {}) {
  if (options && options.enabled === false) return null;

  const limit = Number(options?.limit) > 0 ? Number(options.limit) : DEFAULT_INPUT_TOKEN_LIMIT;
  const warnRatio = Number(options?.warnRatio) > 0 && Number(options.warnRatio) < 1
    ? Number(options.warnRatio)
    : DEFAULT_WARN_RATIO;
  const safetyRatio = Number(options?.safetyRatio) >= 0 && Number(options.safetyRatio) < 10
    ? Number(options.safetyRatio)
    : DEFAULT_SAFETY_RATIO;
  const threshold = limit * (1 + safetyRatio);

  const { tokens, images, top } = estimateInputTokens(payload, options);

  if (tokens > threshold) {
    const error = new InputTokenLimitError(
      buildInputTokenLimitMessage({ estimatedTokens: tokens, limit, precheck: true }),
      { estimatedTokens: tokens, limit, precheck: true }
    );
    error.topContributors = top;
    throw error;
  }

  return { tokens, images, limit, nearLimit: tokens >= limit * warnRatio, top };
}
