import { log } from '../utils/logger.js';
import { OAUTH_CONFIG } from '../constants/oauth.js';
import { TOKEN_REFRESH_BUFFER } from '../constants/index.js';
import { TokenError } from '../utils/errors.js';
import requesterManager from '../utils/requesterManager.js';
import warpManager from '../utils/warpManager.js';

/**
 * Token 生命周期管理类
 * 负责 Token 的过期检查和刷新
 */
class TokenLifecycleManager {
  constructor(store) {
    this.store = store;
  }

  /**
   * 检查 Token 是否过期
   * @param {Object} token - Token 对象
   * @returns {boolean} 是否过期
   */
  isExpired(token) {
    if (!token.timestamp || !token.expires_in) return true;
    const expiresAt = token.timestamp + (token.expires_in * 1000);
    return Date.now() >= expiresAt - TOKEN_REFRESH_BUFFER;
  }

  /**
   * 刷新单个 token
   * @param {Object} token - Token 对象
   * @param {string} tokenId - Token ID（用于日志）
   * @param {boolean} silent - 是否静默模式（不打印日志）
   * @returns {Promise<Object>} 刷新后的 token
   * @throws {TokenError} 刷新失败时抛出异常
   */
  async refreshToken(token, tokenId, silent = false) {
    if (!silent) {
      log.info(`正在刷新token: ${tokenId}`);
    }

    const body = new URLSearchParams({
      client_id: OAUTH_CONFIG.CLIENT_ID,
      client_secret: OAUTH_CONFIG.CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token
    });

    try {
      const response = await requesterManager.fetch(OAUTH_CONFIG.TOKEN_URL, {
        method: 'POST',
        headers: {
          'Host': 'oauth2.googleapis.com',
          'User-Agent': 'Go-http-client/1.1',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept-Encoding': 'gzip'
        },
        body: body.toString(),
        okStatus: [200]
      });

      token.access_token = response.data.access_token;
      token.expires_in = response.data.expires_in;
      token.timestamp = Date.now();
      
      return token;
    } catch (error) {
      const statusCode = error.status || 500;
      const rawBody = error.message;
      const message = typeof rawBody === 'string' 
        ? rawBody 
        : (rawBody?.error?.message || '刷新 token 失败');

      // 如果遇到网络连接阻断、IP受限或地区拒绝等错误，自动触发 WARP 重启换 IP
      const isNetworkOrGeoError = 
        statusCode === 400 || 
        statusCode === 403 || 
        message.includes('not supported') ||
        message.includes('ECONNREFUSED') ||
        message.includes('ETIMEDOUT') ||
        message.includes('timeout');

      if (isNetworkOrGeoError) {
        warpManager.restartWarp(`Token [${tokenId}] 刷新异常 (${message})`).catch(() => {});
      }

      throw new TokenError(message, tokenId, statusCode);
    }
  }

  /**
   * 安全刷新单个 token（不抛出异常）
   * @param {Object} token - Token 对象
   * @param {string} tokenId - Token ID
   * @returns {Promise<'success'|'disable'|'skip'>} 刷新结果
   */
  async refreshTokenSafe(token, tokenId) {
    try {
      await this.refreshToken(token, tokenId, true);
      return 'success';
    } catch (error) {
      if (error.statusCode === 403 || error.statusCode === 400) {
        return 'disable';
      }
      return 'skip';
    }
  }

  /**
   * 并发刷新多个 token
   * @param {Array<{token: Object, tokenId: string}>} tokens - Token 数组
   * @returns {Promise<Object>} 刷新结果 {success: number, failed: number, tokensToDisable: Array}
   */
  async refreshTokensConcurrently(tokens) {
    if (tokens.length === 0) {
      return { success: 0, failed: 0, tokensToDisable: [], failedTokenIds: [] };
    }

    const tokenIds = tokens.map(t => t.tokenId);
    log.info(`正在批量刷新 ${tokenIds.length} 个token: ${tokenIds.join(', ')}`);
    const startTime = Date.now();

    const results = await Promise.allSettled(
      tokens.map(({ token, tokenId }) => this.refreshTokenSafe(token, tokenId))
    );

    let successCount = 0;
    let failCount = 0;
    const tokensToDisable = [];
    const failedTokenIds = [];

    results.forEach((result, index) => {
      const { token, tokenId } = tokens[index];
      if (result.status === 'fulfilled') {
        if (result.value === 'success') {
          successCount++;
        } else if (result.value === 'disable') {
          tokensToDisable.push({ token, tokenId });
          failCount++;
          failedTokenIds.push(tokenId);
        } else {
          // skip
          failCount++;
          failedTokenIds.push(tokenId);
        }
      } else {
        failCount++;
        failedTokenIds.push(tokenId);
      }
    });

    const elapsed = Date.now() - startTime;
    if (failCount > 0) {
      log.warn(`刷新完成: 成功 ${successCount}, 失败 ${failCount} (${failedTokenIds.join(', ')}), 耗时 ${elapsed}ms`);
    } else {
      log.info(`刷新完成: 成功 ${successCount}, 耗时 ${elapsed}ms`);
    }

    return {
      success: successCount,
      failed: failCount,
      tokensToDisable,
      failedTokenIds
    };
  }

  /**
   * 获取过期的 tokens
   * @param {Array<{token: Object, tokenId: string}>} tokens - Token 数组
   * @returns {Array<{token: Object, tokenId: string}>} 过期的 token 数组
   */
  getExpiredTokens(tokens) {
    return tokens.filter(({ token }) => this.isExpired(token));
  }

  /**
   * 计算 token 剩余有效时间（秒）
   * @param {Object} token - Token 对象
   * @returns {number} 剩余秒数，如果已过期返回 0
   */
  getTimeToExpire(token) {
    if (!token.timestamp || !token.expires_in) return 0;
    const expiresAt = token.timestamp + (token.expires_in * 1000);
    const remaining = expiresAt - Date.now();
    return Math.max(0, Math.floor(remaining / 1000));
  }

  /**
   * 检查 token 是否即将过期（在缓冲时间内）
   * @param {Object} token - Token 对象
   * @param {number} bufferSeconds - 缓冲时间（秒），默认使用 TOKEN_REFRESH_BUFFER
   * @returns {boolean} 是否即将过期
   */
  isExpiringSoon(token, bufferSeconds = TOKEN_REFRESH_BUFFER / 1000) {
    const remaining = this.getTimeToExpire(token);
    return remaining <= bufferSeconds;
  }
}

export default TokenLifecycleManager;