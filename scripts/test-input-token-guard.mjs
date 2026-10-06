/**
 * 输入 Token 预估与上限守卫单元测试
 * 运行：node scripts/test-input-token-guard.mjs
 */
import {
  estimateTextTokens,
  estimateInputTokens,
  isInputTokenLimitError,
  parseUpstreamInputLimit,
  buildInputTokenLimitMessage,
  formatTokenCount,
  assertInputTokensWithinLimit,
  isInlineImageValue,
  DEFAULT_INPUT_TOKEN_LIMIT
} from '../src/utils/inputTokenGuard.js';
import { InputTokenLimitError, buildOpenAIErrorPayload } from '../src/utils/errors.js';
import { describeExternalChannelError } from '../src/server/handlers/common/externalChannelError.js';

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name, '|', detail); }
};

// ============ 1. 文本估算 ============
t('纯 ASCII 4 字符 ≈ 1 token', estimateTextTokens('abcd') === 1, String(estimateTextTokens('abcd')));
t('纯 ASCII 400 字符 = 100 token', estimateTextTokens('a'.repeat(400)) === 100);
t('中文 4 字 ≈ 4 token', estimateTextTokens('你好世界') === 4, String(estimateTextTokens('你好世界')));
t('空字符串 = 0', estimateTextTokens('') === 0);
t('非字符串 = 0', estimateTextTokens(null) === 0 && estimateTextTokens(123) === 0);
t('中英混合：中文按字计，英文按 4 字符计', estimateTextTokens('你好abcdefgh') === 4, String(estimateTextTokens('你好abcdefgh')));

// ============ 2. 请求体估算 ============
// 只含一个文本 part 的请求体，便于精确断言
const bodyOf = (chars) => ({ request: { contents: [{ parts: [{ text: 'a'.repeat(chars) }] }] } });

const textBody = {
  model: 'gemini-3.8-flash',
  request: {
    contents: [{ role: 'user', parts: [{ text: 'a'.repeat(400) }] }],
    generationConfig: { maxOutputTokens: 32000 }
  }
};
const est1 = estimateInputTokens(textBody);
// 400 字符文本 100 + 模型名 'gemini-3.8-flash' 4 + role 'user' 1
t('请求体所有字符串都被估算（100+4+1）', est1.tokens === 105, JSON.stringify(est1));
t('无图片时 images = 0', est1.images === 0);
t('纯文本请求体精确估算', estimateInputTokens(bodyOf(400)).tokens === 100);

const imageBody = {
  request: {
    contents: [{
      parts: [
        { text: 'a'.repeat(40) },
        { inlineData: { data: 'iVBORw0KGgo' + 'A'.repeat(20000) } }
      ]
    }]
  }
};
const est2 = estimateInputTokens(imageBody);
t('内联图片按固定估值计（1 张 = 1300 token）', est2.images === 1 && est2.tokens === 10 + 1300, JSON.stringify(est2));
t('base64 图片不会按长度爆炸式高估', est2.tokens < 5000, String(est2.tokens));

const customImageBody = { parts: [{ inlineData: { data: 'A'.repeat(1000) } }] };
const est3 = estimateInputTokens(customImageBody, { imageTokenEstimate: 258 });
t('图片估值可配置（258）', est3.tokens === 258, JSON.stringify(est3));

// 循环引用不应死循环
const cyclic = { text: 'hello' };
cyclic.self = cyclic;
const estCyclic = estimateInputTokens(cyclic);
t('循环引用安全处理', estCyclic.tokens === estimateTextTokens('hello'), JSON.stringify(estCyclic));

// OpenAI 视觉格式：data URL 图片不应按 base64 长度高估
const dataUrlBody = {
  messages: [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(400000) } },
      { type: 'text', text: 'a'.repeat(400) }
    ]
  }]
};
const estDataUrl = estimateInputTokens(dataUrlBody);
t('data URL 图片识别为图片', estDataUrl.images === 1, JSON.stringify(estDataUrl));
t('data URL 图片不按 base64 长度高估', estDataUrl.tokens < 2000, String(estDataUrl.tokens));
t('isInlineImageValue 识别 data URL', isInlineImageValue('data:image/jpeg;base64,' + 'A'.repeat(1000)) === true);
t('isInlineImageValue 不误判普通长文本', isInlineImageValue('a'.repeat(2000)) === false);
t('isInlineImageValue 忽略短字符串', isInlineImageValue('data:image/png;base64,AAA') === false);

// 估算来源分解（用于排障，不含内容）
t('返回占用最大的估算来源', estDataUrl.top.length >= 3 && estDataUrl.top[0].kind === 'image', JSON.stringify(estDataUrl.top));
t('估算来源带字段路径', estDataUrl.top.some(item => item.path.includes('url')), JSON.stringify(estDataUrl.top.map(i => i.path)));
t('估算来源不含原始内容', estDataUrl.top.every(item => Object.keys(item).sort().join(',') === 'chars,kind,path,tokens'));

// ============ 3. 超限报文识别 ============
const realUpstreamBody = JSON.stringify({
  error: {
    code: 400,
    message: 'The input token count exceeds the maximum number of tokens allowed 1048576.',
    status: 'INVALID_ARGUMENT'
  }
});
t('识别真实上游超限报文', isInputTokenLimitError(realUpstreamBody) === true);
t('识别对象形式的超限报文', isInputTokenLimitError(JSON.parse(realUpstreamBody)) === true);
t('解析真实上限 1048576', parseUpstreamInputLimit(realUpstreamBody) === 1048576, String(parseUpstreamInputLimit(realUpstreamBody)));

const otherBody = JSON.stringify({
  error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' }
});
t('403 权限报文不误判为超限', isInputTokenLimitError(otherBody) === false);
t('429 报文不误判为超限', isInputTokenLimitError('{"error":{"code":429,"message":"Resource has been exhausted"}}') === false);
t('空报文不误判', isInputTokenLimitError('') === false && isInputTokenLimitError(null) === false);
t('OpenAI 风格 context length 报文可识别', isInputTokenLimitError('This model\'s maximum context length is 128000 tokens, however you requested 200000.') === true);

// ============ 4. 提示文案 ============
t('token 数格式化（万）', formatTokenCount(1048576) === '104.9 万', formatTokenCount(1048576));
t('token 数格式化（小值）', formatTokenCount(3200) === '3200', formatTokenCount(3200));
const msg = buildInputTokenLimitMessage({ estimatedTokens: 1100000, limit: 1048576, precheck: true });
t('提示包含「提前拦截」', msg.includes('提前拦截'), msg);
t('提示包含上限数字', msg.includes('1,048,576'), msg);
t('提示包含本次估算', msg.includes('110.0 万'), msg);
t('提示包含处理建议', msg.includes('新建会话') && msg.includes('附件'), msg);
const msgNoEstimate = buildInputTokenLimitMessage({ limit: 1048576 });
t('无估算值时文案不出现「本地估算」', !msgNoEstimate.includes('本地估算'), msgNoEstimate);

// ============ 5. 预检守卫 ============
const smallInfo = assertInputTokensWithinLimit(bodyOf(400), { limit: DEFAULT_INPUT_TOKEN_LIMIT });
t('小请求通过预检', smallInfo && smallInfo.tokens === 100 && smallInfo.nearLimit === false, JSON.stringify(smallInfo));

let thrown = null;
try {
  assertInputTokensWithinLimit(bodyOf(400), { limit: 50 });
} catch (e) { thrown = e; }
t('超限时抛出 InputTokenLimitError', thrown instanceof InputTokenLimitError, thrown && thrown.name);
t('错误状态码为 400', thrown && thrown.statusCode === 400);
t('错误标记 precheck', thrown && thrown.precheck === true);
t('错误携带估算值', thrown && thrown.estimatedTokens === 100 && thrown.limit === 50);
t('错误消息为中文提示', thrown && thrown.message.includes('提前拦截'), thrown && thrown.message);

t('enabled=false 时跳过预检', assertInputTokensWithinLimit(bodyOf(400), { enabled: false, limit: 1 }) === null);

const nearInfo = assertInputTokensWithinLimit(bodyOf(400), { limit: 105 });
t('达到 90% 上限时标记 nearLimit', nearInfo && nearInfo.nearLimit === true, JSON.stringify(nearInfo));

// 接近真实场景：约 615K token 的历史会话应放行（用户日志中 In 613797 的请求）
const bigInfo = assertInputTokensWithinLimit(bodyOf(613797 * 4), { limit: DEFAULT_INPUT_TOKEN_LIMIT });
t('约 61.4 万 token 的历史会话可放行', bigInfo && bigInfo.tokens === 613797 && bigInfo.nearLimit === false, JSON.stringify(bigInfo));

// 约 107 万 token（超过 1M 上限）应被拦截
let overThrown = null;
try {
  assertInputTokensWithinLimit(bodyOf(1073741 * 4), { limit: DEFAULT_INPUT_TOKEN_LIMIT });
} catch (e) { overThrown = e; }
t('超过 1M 上限的请求被拦截', overThrown instanceof InputTokenLimitError, overThrown && overThrown.message);

// ============ 6. 对外错误响应格式 ============
const payload = buildOpenAIErrorPayload(thrown, 400);
t('OpenAI 错误体 type = invalid_request_error', payload.error.type === 'invalid_request_error', JSON.stringify(payload.error));
t('OpenAI 错误体 code = context_length_exceeded', payload.error.code === 'context_length_exceeded', String(payload.error.code));
t('OpenAI 错误体 message 为中文提示', payload.error.message.includes('上限'), payload.error.message);

// ============ 7. 外部渠道错误描述 ============
const axiosLikeErr = {
  message: 'Request failed with status code 400',
  response: { status: 400, data: JSON.parse(realUpstreamBody) }
};
const described = describeExternalChannelError(axiosLikeErr);
t('外部渠道超限 → 中文提示', described.includes('输入内容超过模型单次上限'), described);
t('外部渠道超限 → 带上游真实上限', described.includes('1,048,576'), described);

const genericErr = { message: 'socket hang up', response: { status: 502, data: { error: { message: 'upstream unreachable' } } } };
t('普通外部渠道错误 → 提取上游原因', describeExternalChannelError(genericErr) === 'upstream unreachable', describeExternalChannelError(genericErr));
t('无响应体错误 → 回退到 err.message', describeExternalChannelError({ message: 'timeout of 120000ms exceeded' }) === 'timeout of 120000ms exceeded');

console.log(`\n${fail === 0 ? '🎉 全部通过' : '⚠️ 存在失败用例'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
