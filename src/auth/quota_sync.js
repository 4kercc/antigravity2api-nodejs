/**
 * 额度自动同步任务
 *
 * 背景：quotaManager 的额度缓存原先只有管理页手动查看时才会写入，
 * 导致「额度耗尽切换」的阈值过滤长期基于空数据（空数据一律视为有额度），
 * 表现为：一直使用同一账号直到额度真正耗尽。
 *
 * 本模块定期批量拉取所有启用账号的额度并写入 quotaManager，
 * 使阈值判断在无人工干预下也始终基于新鲜数据。
 */
import tokenManager from './token_manager.js';
import quotaManager from './quota_manager.js';
import { getModelsWithQuotas } from '../api/client.js';
import { getConfigJson } from '../config/config.js';
import warpManager from '../utils/warpManager.js';
import { NETWORK_ERROR_SIGNATURES } from './token_lifecycle_manager.js';
import { log } from '../utils/logger.js';

const DEFAULT_SYNC_INTERVAL_MS = 10 * 60 * 1000; // 默认每 10 分钟同步一次
const INITIAL_SYNC_DELAY_MS = 30 * 1000;         // 启动后 30 秒进行首次预热同步
const SYNC_BATCH_SIZE = 4;                        // 每批并发数，避免瞬间打爆上游

let intervalTimer = null;
let initialTimer = null;
let syncing = false;

/**
 * 判断错误是否属于网络/代理层异常（而非鉴权、额度等业务错误）
 * @param {any} error
 * @returns {boolean}
 */
function isNetworkOrProxyError(error) {
  const text = `${error?.message || ''} ${error?.code || ''}`.toLowerCase();
  return NETWORK_ERROR_SIGNATURES.some(signature => text.includes(signature));
}

/**
 * 立即同步所有启用账号的额度数据
 * @returns {Promise<{total: number, synced: number, failed: number, skipped?: boolean}>}
 */
export async function syncAllTokenQuotas() {
  if (syncing) {
    return { total: 0, synced: 0, failed: 0, skipped: true };
  }
  syncing = true;

  try {
    await tokenManager.ensureInitialized();

    const tokens = tokenManager.pool.getAll().filter(token => token && token.enable !== false);
    if (tokens.length === 0) {
      return { total: 0, synced: 0, failed: 0 };
    }

    let synced = 0;
    let failed = 0;
    const failures = []; // 保留少量失败原因，用于区分「网络中断」与「令牌失效」

    for (let i = 0; i < tokens.length; i += SYNC_BATCH_SIZE) {
      const batch = tokens.slice(i, i + SYNC_BATCH_SIZE);
      await Promise.all(batch.map(async (token) => {
        try {
          // 过期令牌的刷新由 getModelsWithQuotas 内部负责（访问令牌仅 1 小时有效期）
          const quotas = await getModelsWithQuotas(token);
          if (quotas && Object.keys(quotas).length > 0) {
            const tokenId = await tokenManager.pool.generateTokenId(token);
            quotaManager.updateQuota(tokenId, quotas);
            synced++;
          } else {
            failed++;
          }
        } catch (error) {
          failed++;
          if (failures.length < 5) failures.push(error);
          log.warn(`[QuotaSync] 账号额度同步失败 [${token.email || token.projectId || 'unknown'}]: ${error.message}`);
        }
      }));
    }

    log.info(`[QuotaSync] 额度自动同步完成: 成功 ${synced} 个${failed > 0 ? `, 失败 ${failed} 个` : ''}`);

    // 全部账号同步失败通常意味着代理/网络中断，上报给 WARP 自愈检测器；
    // 但若失败是令牌失效/权限问题（401/403 等），重启 WARP 换 IP 无济于事，需避免误触发。
    if (synced === 0 && failed > 0) {
      if (failures.some(isNetworkOrProxyError)) {
        warpManager.reportNetworkFailure(`额度同步全部失败 (${failed} 个账号)`);
      } else {
        log.warn('[QuotaSync] 全部账号同步失败且均为非网络类错误（如令牌失效），已跳过 WARP 自愈');
      }
    }

    return { total: tokens.length, synced, failed };
  } finally {
    syncing = false;
  }
}

/**
 * 读取同步间隔配置（config.json: quota.syncIntervalMs，设为 0 可关闭）
 * @returns {number} 同步间隔毫秒
 */
function resolveSyncIntervalMs() {
  try {
    const configured = Number(getConfigJson()?.quota?.syncIntervalMs);
    if (Number.isFinite(configured) && configured >= 0) {
      return configured;
    }
  } catch (e) {
    // 忽略配置读取异常，使用默认值
  }
  return DEFAULT_SYNC_INTERVAL_MS;
}

/**
 * 启动额度自动同步定时任务
 * @returns {boolean} 是否成功启动
 */
export function startQuotaSyncTimer() {
  stopQuotaSyncTimer();

  const intervalMs = resolveSyncIntervalMs();
  if (intervalMs <= 0) {
    log.info('[QuotaSync] 额度自动同步已关闭（quota.syncIntervalMs = 0）');
    return false;
  }

  // 启动预热：让额度缓存尽快就绪，无需等待第一个完整周期
  initialTimer = setTimeout(() => {
    syncAllTokenQuotas().catch((error) => {
      log.warn(`[QuotaSync] 首次额度同步异常: ${error.message}`);
    });
  }, INITIAL_SYNC_DELAY_MS);
  if (typeof initialTimer.unref === 'function') initialTimer.unref();

  intervalTimer = setInterval(() => {
    syncAllTokenQuotas().catch((error) => {
      log.warn(`[QuotaSync] 额度同步任务异常: ${error.message}`);
    });
  }, intervalMs);
  if (typeof intervalTimer.unref === 'function') intervalTimer.unref();

  log.info(`[QuotaSync] 额度自动同步任务已启动（间隔: ${Math.round(intervalMs / 60000)} 分钟）`);
  return true;
}

/**
 * 停止额度自动同步定时任务
 */
export function stopQuotaSyncTimer() {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
}
