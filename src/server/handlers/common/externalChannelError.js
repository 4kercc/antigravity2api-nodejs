/**
 * 外部上游渠道错误信息提取
 *
 * axios 抛出的错误 message 往往只有「Request failed with status code 400」，
 * 真正有用的原因在上游响应体里。这里统一提取并做两件事：
 *   1. 输入上下文超限（如 1M token 上限）时，转换为中文可读提示
 *   2. 其余情况提取上游 error.message，避免只暴露泛化的 axios 文案
 */

import {
  isInputTokenLimitError,
  parseUpstreamInputLimit,
  buildInputTokenLimitMessage,
  DEFAULT_INPUT_TOKEN_LIMIT
} from '../../../utils/inputTokenGuard.js';

const MAX_MESSAGE_LENGTH = 600;

function stringifyBody(body) {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function truncate(text) {
  const value = String(text || '').trim();
  if (value.length <= MAX_MESSAGE_LENGTH) return value;
  return `${value.slice(0, MAX_MESSAGE_LENGTH)}…（已截断）`;
}

/**
 * 提取外部渠道错误的可读原因
 * @param {any} err - axios / fetch 抛出的错误对象
 * @returns {string}
 */
export function extractUpstreamErrorReason(err) {
  const data = err?.response?.data;

  // 优先取上游 error.message（OpenAI / Claude / Gemini 三种格式）
  if (data && typeof data === 'object') {
    const inner = data.error;
    if (typeof inner === 'string' && inner.trim()) return truncate(inner);
    if (inner && typeof inner === 'object' && typeof inner.message === 'string' && inner.message.trim()) {
      return truncate(inner.message);
    }
    if (typeof data.message === 'string' && data.message.trim()) return truncate(data.message);
  }

  const bodyText = stringifyBody(data);
  if (bodyText) return truncate(bodyText);

  return truncate(err?.message || '未知错误');
}

/**
 * 构建面向客户端的外部渠道错误描述
 *
 * 输入上下文超限时返回中文提示（并带上从上游报文解析出的真实上限），
 * 其他错误返回上游可读原因。
 * @param {any} err
 * @returns {string}
 */
export function describeExternalChannelError(err) {
  const reason = extractUpstreamErrorReason(err);

  if (isInputTokenLimitError(reason)) {
    const limit = parseUpstreamInputLimit(reason) || DEFAULT_INPUT_TOKEN_LIMIT;
    return buildInputTokenLimitMessage({ limit });
  }

  return reason;
}
