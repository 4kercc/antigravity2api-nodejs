/**
 * 额度判定单元测试：disabled 占位模型（未订阅）不应拖垮同组额度
 * 运行：node scripts/test-quota-disabled-model.mjs
 */
import quotaManager from '../src/auth/quota_manager.js';

// 测试期间不要写入真实 data/quotas.json
quotaManager.saveToFile = () => {};

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name, '|', detail); }
};

const T1 = '__test_no_g4__';
const T2 = '__test_has_g4__';
const T3 = '__test_legacy_cache__';
const T4 = '__test_low_quota__';
const cleanup = () => [T1, T2, T3, T4].forEach(id => quotaManager.cache.delete(id));

try {
  // ============ 1. 未订阅 Gemini 4 的账号（线上真实形态） ============
  quotaManager.updateQuota(T1, {
    'gemini-3.8-flash-high': { r: 0.9, t: '2026-10-26T00:00:00Z', wr: null, wt: null },
    'gemini-3.8-flash-tiered': { r: 0.9, t: '2026-10-26T00:00:00Z', wr: null, wt: null },
    'gemini-4-argon-disabled': { r: null, t: null, wr: 1, wt: '2026-10-26T00:00:00Z', disabled: true }
  });

  t('普通 Gemini 模型仍判定可用', quotaManager.hasQuotaForModel(T1, 'gemini-3.8-flash', 0.2) === true);
  t('Gemini 4 判定不可用（账号未订阅）', quotaManager.hasQuotaForModel(T1, 'gemini-4-argon-high', 0.2) === false);
  t('Gemini 4 其他档位同样不可用', quotaManager.hasQuotaForModel(T1, 'gemini-4-argon-medium', 0.2) === false);

  const cache1 = quotaManager.getQuota(T1);
  t('disabled 占位未混入 models', cache1 && !('gemini-4-argon-disabled' in cache1.models));
  t('disabled 占位记录在 disabledModels', Array.isArray(cache1?.disabledModels) && cache1.disabledModels.includes('gemini-4-argon-disabled'), JSON.stringify(cache1?.disabledModels));
  t('组额度未被 null 拖成 0', quotaManager.getModelGroupQuota(T1, 'gemini-3.8-flash') === 0.9, String(quotaManager.getModelGroupQuota(T1, 'gemini-3.8-flash')));

  // ============ 2. 有 Gemini 4 权限的账号 ============
  quotaManager.updateQuota(T2, {
    'gemini-3.8-flash-high': { r: 0.9 },
    'gemini-4-argon-high': { r: 1, wr: 1 },
    'gemini-4-argon-medium': { r: 1, wr: 1 }
  });
  t('有权限账号 Gemini 4 可用', quotaManager.hasQuotaForModel(T2, 'gemini-4-argon-high', 0.2) === true);
  t('有权限账号普通 Gemini 也可用', quotaManager.hasQuotaForModel(T2, 'gemini-3.8-flash', 0.2) === true);
  t('有权限账号无 disabledModels', (quotaManager.getQuota(T2)?.disabledModels || []).length === 0);

  // ============ 3. 兼容修复前写入的旧缓存（disabled 条目残留在 models） ============
  quotaManager.cache.set(T3, {
    lastUpdated: Date.now(),
    models: {
      'gemini-3.8-flash-high': { r: 0.9 },
      'gemini-4-argon-disabled': { r: null }
    },
    requestCounts: {},
    resetTimes: {}
  });
  t('旧缓存：null 额度不再拖垮组判断', quotaManager.hasQuotaForModel(T3, 'gemini-3.8-flash', 0.2) === true);
  t('旧缓存：Gemini 4 仍判不可用', quotaManager.hasQuotaForModel(T3, 'gemini-4-argon-high', 0.2) === false);

  // ============ 4. 阈值逻辑不受影响 ============
  quotaManager.updateQuota(T4, { 'gemini-3.8-flash-high': { r: 0.1 } });
  t('额度低于阈值仍被排除', quotaManager.hasQuotaForModel(T4, 'gemini-3.8-flash', 0.2) === false);
  t('阈值设为 0 时低额度仍可用', quotaManager.hasQuotaForModel(T4, 'gemini-3.8-flash', 0) === true);
} finally {
  cleanup();
}

console.log(`\n${fail === 0 ? '🎉 全部通过' : '⚠️ 存在失败用例'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
