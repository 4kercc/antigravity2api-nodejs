import { detectAccountRisk, isAccountRisk, getRiskLabel, RISK_STATUS } from '../src/utils/accountRiskDetector.js';

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name, '|', detail); }
};

// ============ 1. VALIDATION_REQUIRED（风控要求验证） ============
const verificationBody = JSON.stringify({
  error: {
    code: 403,
    message: 'The caller does not have permission to access this resource',
    status: 'PERMISSION_DENIED',
    details: [{
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'VALIDATION_REQUIRED',
      domain: 'cloudcode-pa.googleapis.com',
      metadata: { validation_url: 'https://accounts.google.com/verify?token=abc123' }
    }]
  }
});
let r = detectAccountRisk(verificationBody, 403);
t('VALIDATION_REQUIRED → verification_required', r.kind === RISK_STATUS.VERIFICATION_REQUIRED, r.kind);
t('提取 validation_url', r.validationUrl === 'https://accounts.google.com/verify?token=abc123', r.validationUrl);
t('标记为账号级风控', isAccountRisk(r.kind) === true);
t('中文标签正确', getRiskLabel(r.kind) === '风控要求验证', getRiskLabel(r.kind));

// ============ 2. TOS_VIOLATION（违反条款被封禁） ============
const tosBody = JSON.stringify({
  error: {
    code: 403,
    message: 'Your account has been suspended',
    details: [{
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'TOS_VIOLATION',
      metadata: { appeal_url: 'https://support.google.com/appeal/form/12345' }
    }]
  }
});
r = detectAccountRisk(tosBody, 403);
t('TOS_VIOLATION → tos_violation', r.kind === RISK_STATUS.TOS_VIOLATION, r.kind);
t('提取 appeal_url', r.appealUrl === 'https://support.google.com/appeal/form/12345', r.appealUrl);
t('中文标签正确', getRiskLabel(r.kind) === '违反服务条款被封禁', getRiskLabel(r.kind));

// ============ 3. details 为「字符串化 JSON」（cockpit-tools 兼容场景） ============
const stringifiedDetails = JSON.stringify({
  error: {
    code: 403,
    message: 'verification needed',
    details: JSON.stringify({
      error: {
        details: [{
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'VALIDATION_REQUIRED',
          metadata: { validation_url: 'https://verify.example.com/x' }
        }]
      }
    })
  }
});
r = detectAccountRisk(stringifiedDetails, 403);
t('details 为字符串时仍能识别', r.kind === RISK_STATUS.VERIFICATION_REQUIRED && r.validationUrl === 'https://verify.example.com/x', `${r.kind} / ${r.validationUrl}`);

// ============ 4. 403 但 details 未命中已知 reason → 兜底按风控处理 ============
r = detectAccountRisk(JSON.stringify({ error: { code: 403, message: 'blocked', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'OTHER_REASON' }] } }), 403);
t('403 + 未知 reason → 兜底 verification_required', r.kind === RISK_STATUS.VERIFICATION_REQUIRED, r.kind);

// ============ 5. 文本兜底 ============
r = detectAccountRisk('{"error":{"message":"TOS_VIOLATION detected"}}', 403);
t('文本含 tos_violation → tos_violation', r.kind === RISK_STATUS.TOS_VIOLATION, r.kind);

r = detectAccountRisk('Authorization expired, please login again', 401);
t('文本含 authorization expired → auth_expired', r.kind === RISK_STATUS.AUTH_EXPIRED, r.kind);

r = detectAccountRisk('Request failed with status code 403', 403);
t('文本含 403 → verification_required', r.kind === RISK_STATUS.VERIFICATION_REQUIRED, r.kind);

// ============ 6. 非风控错误不应误判 ============
r = detectAccountRisk('{"error":{"code":400,"message":"Invalid argument: max_tokens too large"}}', 400);
t('普通 400 参数错误 → 不判定为风控', r.kind === null, String(r.kind));
t('非风控时 isAccountRisk 为 false', isAccountRisk(r.kind) === false);

r = detectAccountRisk('{"error":{"code":429,"message":"Resource exhausted"}}', 429);
t('429 限流 → 不判定为风控', r.kind === null, String(r.kind));

// ============ 7. 对象入参（非字符串）也应支持 ============
r = detectAccountRisk({
  error: {
    code: 403,
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'VALIDATION_REQUIRED', metadata: { validation_url: 'https://obj.example.com/v' } }]
  }
}, 403);
t('对象入参识别正常', r.kind === RISK_STATUS.VERIFICATION_REQUIRED && r.validationUrl === 'https://obj.example.com/v', `${r.kind}/${r.validationUrl}`);

// ============ 8. 真实抓包响应体（retrieveUserQuotaSummary 返回的风控 403） ============
const realBody = JSON.stringify({
  error: {
    code: 403,
    message: 'The caller does not have permission',
    status: 'PERMISSION_DENIED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'VALIDATION_REQUIRED',
        domain: 'cloudcode-pa.googleapis.com',
        metadata: {
          validation_error_message: 'Verify your account to continue.',
          validation_url_link_text: 'Verify your account',
          validation_url: 'https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini',
          validation_learn_more_url: 'https://support.google.com/accounts?p=al_alert'
        }
      },
      { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Verify your account', url: 'https://accounts.google.com/signin/continue' }] }
    ]
  }
});
r = detectAccountRisk(realBody, 403, { requireExplicitReason: true });
t('真实响应体（严格模式）→ verification_required', r.kind === RISK_STATUS.VERIFICATION_REQUIRED, r.kind);
t('真实响应体提取 validation_url', (r.validationUrl || '').startsWith('https://accounts.google.com/signin/continue'), r.validationUrl);
t('优先使用 metadata 提示文案', r.message === 'Verify your account to continue.', r.message);

// ============ 9. 严格模式：无明确 reason 的 403 不误判 ============
r = detectAccountRisk(JSON.stringify({ error: { code: 403, message: 'blocked', details: [] } }), 403, { requireExplicitReason: true });
t('严格模式：403 无 reason → 不判定（防误禁）', r.kind === null, String(r.kind));
r = detectAccountRisk(JSON.stringify({ error: { code: 403, message: 'blocked', details: [] } }), 403);
t('非严格模式：403 兜底仍判定', r.kind === RISK_STATUS.VERIFICATION_REQUIRED, r.kind);

console.log(`\n===== 通过 ${pass} / ${pass + fail} =====`);
if (fail > 0) process.exit(1);
