/**
 * 账号风控（风险状态）识别模块
 *
 * 算法移植自 cockpit-tools（https://github.com/jlcodes99/cockpit-tools）的
 * `wakeup_verification.rs` 判定逻辑：
 *
 * 1. 上游返回 403 时，解析响应体 `error.details[]` 中的 Google RPC ErrorInfo：
 *    - reason = VALIDATION_REQUIRED → 风控要求验证（verification_required），可提取 metadata.validation_url
 *    - reason = TOS_VIOLATION       → 违反服务条款被封禁（tos_violation），可提取 metadata.appeal_url
 * 2. 无法解析结构化错误时，回退到文本特征匹配：
 *    - authorization expired / unauthorized / unauthenticated → 授权失效（auth_expired）
 *    - tos_violation / violation of terms                     → 违规封禁
 *    - 包含 403                                                → 风控要求验证
 *
 * 识别结果用于：自动禁用该账号 + 前端卡片告警提示（含验证/申诉链接）。
 */

export const RISK_STATUS = {
  VERIFICATION_REQUIRED: 'verification_required',
  TOS_VIOLATION: 'tos_violation',
  AUTH_EXPIRED: 'auth_expired'
};

const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';

/**
 * 将可能是「JSON 字符串」或「对象」的字段统一解析为对象
 * @param {*} value
 * @returns {Object|null}
 */
function coerceJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // 容错：从字符串中截取首个 JSON 对象
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * 提取错误详情数组（兼容 details 为字符串、或直接为数组、或多层嵌套）
 * @param {Object} parsed - 已解析的响应体
 * @returns {Array<Object>}
 */
function extractErrorDetails(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];

  const fromError = parsed?.error?.details;
  const candidates = [fromError, parsed.details, parsed];

  for (const candidate of candidates) {
    const resolved = coerceJson(candidate);
    if (Array.isArray(resolved)) return resolved;
    // 形如 { error: { details: [...] } } 的字符串化嵌套
    const nested = coerceJson(resolved?.error?.details);
    if (Array.isArray(nested)) return nested;
  }

  return [];
}

/**
 * 从错误详情中按 reason 提取指定 metadata 字段（URL）
 * @param {Array<Object>} details
 * @param {string} reason - VALIDATION_REQUIRED | TOS_VIOLATION
 * @param {string} metaKey - validation_url | appeal_url
 * @returns {string|null}
 */
function extractUrlByReason(details, reason, metaKey) {
  for (const item of details) {
    if (!item || typeof item !== 'object') continue;

    const type = typeof item['@type'] === 'string' ? item['@type'] : '';
    const itemReason = typeof item.reason === 'string' ? item.reason : '';
    if (type !== ERROR_INFO_TYPE || itemReason !== reason) continue;

    const url = item?.metadata?.[metaKey];
    if (typeof url === 'string' && url.trim()) {
      return url.trim();
    }
  }
  return null;
}

/**
 * 提取上游错误中的 message 文本
 * @param {Object} parsed
 * @param {string} fallback
 * @returns {string}
 */
function extractMessage(parsed, fallback) {
  const message = parsed?.error?.message ?? parsed?.message;
  if (typeof message === 'string' && message.trim()) {
    return message.trim();
  }
  return fallback;
}

/**
 * 识别账号风控状态
 *
 * @param {*} errorBody - 上游错误响应体（字符串或对象）
 * @param {number|null} status - HTTP 状态码（可选，默认从 403 语义推断）
 * @returns {{kind: string|null, status: string|null, message: string, validationUrl: string|null, appealUrl: string|null, errorCode: number|null}}
 */
export function detectAccountRisk(errorBody, status = null) {
  const fallbackText = typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody ?? '');
  const parsed = coerceJson(errorBody);
  const httpStatus = Number(status) || (parsed ? null : 403);

  // ============ 1. 结构化错误：Google RPC ErrorInfo ============
  const details = extractErrorDetails(parsed);
  if (details.length > 0) {
    const appealUrl = extractUrlByReason(details, 'TOS_VIOLATION', 'appeal_url');
    if (appealUrl) {
      return {
        kind: RISK_STATUS.TOS_VIOLATION,
        status: RISK_STATUS.TOS_VIOLATION,
        message: extractMessage(parsed, fallbackText),
        validationUrl: null,
        appealUrl,
        errorCode: 403
      };
    }

    const validationUrl = extractUrlByReason(details, 'VALIDATION_REQUIRED', 'validation_url');
    if (validationUrl) {
      return {
        kind: RISK_STATUS.VERIFICATION_REQUIRED,
        status: RISK_STATUS.VERIFICATION_REQUIRED,
        message: extractMessage(parsed, fallbackText),
        validationUrl,
        appealUrl: null,
        errorCode: 403
      };
    }

    // 有 details 但未命中已知 reason 时，若为 403 仍按风控处理（与 cockpit-tools 一致）
    if (httpStatus === 403) {
      return {
        kind: RISK_STATUS.VERIFICATION_REQUIRED,
        status: RISK_STATUS.VERIFICATION_REQUIRED,
        message: extractMessage(parsed, fallbackText),
        validationUrl: null,
        appealUrl: null,
        errorCode: 403
      };
    }
  }

  // ============ 2. 文本特征兜底 ============
  const lower = String(fallbackText || '').toLowerCase();

  if (lower.includes('tos_violation') || lower.includes('violation of terms')) {
    return {
      kind: RISK_STATUS.TOS_VIOLATION,
      status: RISK_STATUS.TOS_VIOLATION,
      message: fallbackText,
      validationUrl: null,
      appealUrl: null,
      errorCode: 403
    };
  }

  if (lower.includes('authorization expired') || lower.includes('unauthorized') || lower.includes('unauthenticated')) {
    return {
      kind: RISK_STATUS.AUTH_EXPIRED,
      status: RISK_STATUS.AUTH_EXPIRED,
      message: fallbackText,
      validationUrl: null,
      appealUrl: null,
      errorCode: 401
    };
  }

  if (lower.includes('403')) {
    return {
      kind: RISK_STATUS.VERIFICATION_REQUIRED,
      status: RISK_STATUS.VERIFICATION_REQUIRED,
      message: fallbackText,
      validationUrl: null,
      appealUrl: null,
      errorCode: 403
    };
  }

  return {
    kind: null,
    status: null,
    message: fallbackText,
    validationUrl: null,
    appealUrl: null,
    errorCode: null
  };
}

/**
 * 是否属于「账号级风控」（需要禁用账号并提示用户处理）
 * @param {string|null} kind
 * @returns {boolean}
 */
export function isAccountRisk(kind) {
  return kind === RISK_STATUS.VERIFICATION_REQUIRED
    || kind === RISK_STATUS.TOS_VIOLATION
    || kind === RISK_STATUS.AUTH_EXPIRED;
}

/**
 * 生成中文状态标签
 * @param {string|null} kind
 * @returns {string}
 */
export function getRiskLabel(kind) {
  switch (kind) {
    case RISK_STATUS.VERIFICATION_REQUIRED:
      return '风控要求验证';
    case RISK_STATUS.TOS_VIOLATION:
      return '违反服务条款被封禁';
    case RISK_STATUS.AUTH_EXPIRED:
      return '授权已失效';
    default:
      return '正常';
  }
}
