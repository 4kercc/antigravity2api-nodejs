import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fingerprintRequester from '../requester.js';
import { buildAxiosRequestConfig } from '../utils/httpClient.js';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { generateToken, authMiddleware, verifyToken } from '../auth/jwt.js';
import tokenManager from '../auth/token_manager.js';
import geminicliTokenManager from '../auth/geminicli_token_manager.js';
import quotaManager from '../auth/quota_manager.js';
import oauthManager from '../auth/oauth_manager.js';
import config, { getConfigJson, saveConfigJson } from '../config/config.js';
import logger from '../utils/logger.js';
import memoryManager from '../utils/memoryManager.js';
import { parseEnvFile, updateEnvFile } from '../utils/envParser.js';
import { reloadConfig } from '../utils/configReloader.js';
import { deepMerge } from '../utils/deepMerge.js';
import { getModelsWithQuotas } from '../api/client.js';
import { getEnvPath } from '../utils/paths.js';
import ipBlockManager from '../utils/ipBlockManager.js';
import apiKeyManager from '../auth/api_key_manager.js';
import { getCertificateInfo, verifyDomainDNS, issueAcmeCert, generateSelfSignedCert, updateCustomCert, saveCertMeta } from '../utils/sslManager.js';
import { get2FAConfig, save2FAConfig, generateSecret, generateTOTP, verifyTOTP, generateBackupCodes, consumeBackupCode } from '../utils/totpManager.js';
import warpManager from '../utils/warpManager.js';
import { server } from '../server/index.js';
import dotenv from 'dotenv';

const envPath = getEnvPath();

const router = express.Router();

// 禁用缓存中间件，确保管理后台数据实时性
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Cookie 配置
const COOKIE_OPTIONS = {
  httpOnly: true,
  // secure: process.env.NODE_ENV === 'production', // 移除静态配置，改为动态判断
  sameSite: 'strict',
  maxAge: 24 * 60 * 60 * 1000 // 24小时
};

// 从 Cookie 或 Header 获取 JWT Token 的中间件
const cookieAuthMiddleware = (req, res, next) => {
  // 优先从 Cookie 获取
  let token = req.cookies?.authToken;

  // 如果 Cookie 中没有，尝试从 Header 获取（兼容旧版本）
  if (!token) {
    const authHeader = req.headers.authorization;
    token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  }

  if (!token) {
    return res.status(401).json({ error: 'Token required' });
  }

  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    // 清除无效的 Cookie
    res.clearCookie('authToken', {
      ...COOKIE_OPTIONS,
      secure: req.secure || process.env.NODE_ENV === 'production'
    });
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// 获取真实客户端 IP（公网裸连时提取底层 TCP 对端，杜绝构造 X-Forwarded-For 伪造内网白名单）
function getClientIP(req) {
  let ip = req.socket?.remoteAddress || req.connection?.remoteAddress || req.ip || 'unknown';
  if (typeof ip === 'string' && ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  return ip;
}

// 登录接口
router.post('/login', async (req, res) => {
  const clientIP = getClientIP(req);

  // 使用统一的 IP 封禁管理器检查
  const blockStatus = ipBlockManager.check(clientIP);
  if (blockStatus.blocked) {
    if (blockStatus.reason === 'permanent') {
      return res.status(403).json({ success: false, message: '您的IP已被永久封禁' });
    }
    const remainingMinutes = Math.ceil((blockStatus.expiresAt - Date.now()) / 60000);
    return res.status(429).json({
      success: false,
      message: `登录尝试过多，请 ${remainingMinutes} 分钟后重试`,
      retryAfter: remainingMinutes * 60
    });
  }

  const { username, password } = req.body;

  // 验证输入
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ success: false, message: '用户名和密码必填' });
  }

  // 限制输入长度防止 DoS
  if (username.length > 100 || password.length > 100) {
    return res.status(400).json({ success: false, message: '输入过长' });
  }

  if (username === config.admin.username && password === config.admin.password) {
    const twoFactorConfig = get2FAConfig();
    if (twoFactorConfig.enabled && twoFactorConfig.secret) {
      // 启用了 2FA，不直接签发完整 authToken，需要第二步输入 2FA 动态码
      const tempToken = generateToken({ username, stage: '2fa_pending' });
      logger.info(`🔐 管理员密码凭据通过 [IP: ${clientIP}]，等待 2FA 动态口令二次验证...`);
      return res.json({ success: true, require2FA: true, tempToken });
    }

    const token = generateToken({ username, role: 'admin' });

    // 设置 HttpOnly Cookie
    // 动态设置 secure: 如果通过 https 访问 (req.secure) 或在生产环境，则启用 secure
    res.cookie('authToken', token, {
      ...COOKIE_OPTIONS,
      secure: req.secure || process.env.NODE_ENV === 'production'
    });

    // 同时返回 token（兼容旧版本前端）
    logger.info(`🔐 管理员登录成功 [IP: ${clientIP}] (用户: ${username})`);
    res.json({ success: true, token });
  } else {
    // 密码错误单次加重违规权重为 10（5次即触发临时封禁，累计多次直接永久封禁）
    await ipBlockManager.recordViolation(clientIP, 'admin_login_fail', 10);
    logger.warn(`❌ 管理员登录失败 [IP: ${clientIP}] (尝试用户: ${username})`);
    res.status(401).json({ success: false, message: '用户名或密码错误' });
  }
});

// 2FA 二次验证登录接口
router.post('/login/verify-2fa', async (req, res) => {
  const clientIP = getClientIP(req);
  const { tempToken, code } = req.body;

  if (!tempToken || !code) {
    return res.status(400).json({ success: false, message: '临时凭证和验证码必填' });
  }

  try {
    const decoded = verifyToken(tempToken);
    if (!decoded || decoded.stage !== '2fa_pending') {
      return res.status(401).json({ success: false, message: '无效或已过期的登录凭证' });
    }

    const twoFactorConfig = get2FAConfig();
    if (!twoFactorConfig.enabled || !twoFactorConfig.secret) {
      return res.status(400).json({ success: false, message: '系统未开启 2FA 双因素验证' });
    }

    // 校验 TOTP 6位动态验证码
    let valid = verifyTOTP(code, twoFactorConfig.secret);

    // 若动态码校验未通过，尝试备用恢复码
    if (!valid && consumeBackupCode(code)) {
      valid = true;
    }

    if (!valid) {
      await ipBlockManager.recordViolation(clientIP, 'admin_2fa_fail', 10);
      logger.warn(`❌ 2FA 二次验证失败 [IP: ${clientIP}]`);
      return res.status(401).json({ success: false, message: '验证码或备用恢复码无效' });
    }

    // 验证通过，正式签发 JWT Token 并写 Cookie
    const token = generateToken({ username: decoded.username, role: 'admin' });
    res.cookie('authToken', token, {
      ...COOKIE_OPTIONS,
      secure: req.secure || process.env.NODE_ENV === 'production'
    });

    logger.info(`🔐 2FA 二次验证通过，管理员登录成功 [IP: ${clientIP}]`);
    res.json({ success: true, token });
  } catch (error) {
    logger.error('2FA 验证登录异常:', error.message);
    res.status(401).json({ success: false, message: '验证失败: ' + error.message });
  }
});

// ==================== 2FA 管理 API ====================

// 获取当前 2FA 开启状态
router.get('/2fa/status', cookieAuthMiddleware, (req, res) => {
  const cfg = get2FAConfig();
  res.json({
    success: true,
    data: {
      enabled: cfg.enabled === true,
      hasBackupCodes: Array.isArray(cfg.backupCodes) && cfg.backupCodes.length > 0,
      remainingBackupCodes: Array.isArray(cfg.backupCodes) ? cfg.backupCodes.length : 0
    }
  });
});

// 生成全新的 2FA 绑定密钥
router.post('/2fa/setup', cookieAuthMiddleware, (req, res) => {
  try {
    const secret = generateSecret();
    const appName = 'Antigravity2API';
    const username = config.admin.username || 'admin';
    const otpauthUrl = `otpauth://totp/${encodeURIComponent(appName)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(appName)}`;

    res.json({
      success: true,
      data: {
        secret,
        otpauthUrl
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 校验 6 位动态验证码并确认开启 2FA
router.post('/2fa/verify-enable', cookieAuthMiddleware, (req, res) => {
  const { secret, code } = req.body;
  if (!secret || !code) {
    return res.status(400).json({ success: false, message: '密钥和验证码必填' });
  }

  const valid = verifyTOTP(code, secret);
  if (!valid) {
    return res.status(400).json({ success: false, message: '验证码错误，请确保时间同步后重试' });
  }

  // 生成备用恢复码
  const backupCodes = generateBackupCodes();
  save2FAConfig({
    enabled: true,
    secret,
    backupCodes
  });

  logger.info('🔐 管理员成功启用双因素身份验证 (2FA)');
  res.json({
    success: true,
    message: '2FA 双因素身份验证开启成功！',
    data: { backupCodes }
  });
});

// 解绑/关闭 2FA 身份验证
router.post('/2fa/disable', cookieAuthMiddleware, (req, res) => {
  const { password, code } = req.body;

  if (!password || !verifyPassword(password)) {
    return res.status(403).json({ success: false, message: '管理员密码验证失败' });
  }

  const currentCfg = get2FAConfig();
  if (currentCfg.enabled && code) {
    const valid = verifyTOTP(code, currentCfg.secret) || consumeBackupCode(code);
    if (!valid) {
      return res.status(400).json({ success: false, message: '2FA 动态验证码错误' });
    }
  }

  save2FAConfig({
    enabled: false,
    secret: null,
    backupCodes: []
  });

  logger.info('🔓 管理员已关闭双因素身份验证 (2FA)');
  res.json({ success: true, message: '已安全关闭 2FA 双因素身份验证' });
});

// 登出接口
router.post('/logout', (req, res) => {
  const clientIP = getClientIP(req);
  res.clearCookie('authToken', {
    ...COOKIE_OPTIONS,
    secure: req.secure || process.env.NODE_ENV === 'production'
  });
  logger.info(`🚪 管理员安全退出登录 [IP: ${clientIP}]`);
  res.json({ success: true, message: '已登出' });
});

// 验证密码（用于敏感操作）
function verifyPassword(password) {
  return password === config.admin.password;
}

// Token管理API - 需要JWT认证（使用 Cookie 优先）
router.get('/tokens', cookieAuthMiddleware, async (req, res) => {
  try {
    const tokens = await tokenManager.getTokenList();
    res.json({ success: true, data: tokens });
  } catch (error) {
    logger.error('获取Token列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/tokens', cookieAuthMiddleware, async (req, res) => {
  const { access_token, refresh_token, expires_in, timestamp, enable, projectId, email, sub, credits } = req.body;
  if (!access_token || !refresh_token) {
    return res.status(400).json({ success: false, message: 'access_token和refresh_token必填' });
  }
  const tokenData = { access_token, refresh_token, expires_in, sub };
  if (timestamp) tokenData.timestamp = timestamp;
  if (enable !== undefined) tokenData.enable = enable;
  if (projectId) tokenData.projectId = projectId;
  if (email) tokenData.email = email;
  if (credits !== null && credits !== undefined) tokenData.credits = credits;

  try {
    const result = await tokenManager.addToken(tokenData);
    logger.info(`添加新Token: ${access_token.substring(0, 8)}...`);
    // 返回符合前端预期的格式
    res.json({ success: true, message: 'Token添加成功', data: result });
  } catch (error) {
    logger.error('添加Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});
// 使用 tokenId 替代 refreshToken
router.put('/tokens/:tokenId', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  const updates = req.body;

  // 不允许通过 API 更新敏感字段
  delete updates.access_token;
  delete updates.refresh_token;

  try {
    const result = await tokenManager.updateTokenById(tokenId, updates);
    logger.info(`更新Token: ${tokenId}`);
    res.json(result);
  } catch (error) {
    logger.error('更新Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/tokens/:tokenId', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  try {
    const result = await tokenManager.deleteTokenById(tokenId);
    logger.info(`删除Token: ${tokenId}`);
    res.json(result);
  } catch (error) {
    logger.error('删除Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/tokens/reload', cookieAuthMiddleware, async (req, res) => {
  try {
    await tokenManager.reload();
    logger.info('手动触发Token热重载');
    res.json({ success: true, message: 'Token已热重载' });
  } catch (error) {
    logger.error('热重载失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 刷新指定Token的access_token（使用 tokenId）
router.post('/tokens/:tokenId/refresh', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  try {
    // 1. 刷新 access_token
    const result = await tokenManager.refreshTokenById(tokenId);

    // 2. 重新获取积分和订阅信息
    try {
      const subscriptionInfo = await tokenManager.refreshSubscriptionAndCreditsById(tokenId);

      if (subscriptionInfo.fetched === false) {
        logger.warn('[刷新Token] 获取订阅和积分信息失败，保留现有数据');
        return res.json({
          success: true,
          message: 'Token刷新成功（但获取订阅信息失败）',
          data: {
            ...result,
            sub: subscriptionInfo.sub,
            credits: subscriptionInfo.credits,
            isActivated: subscriptionInfo.isActivated
          }
        });
      }

      logger.info(`[刷新Token] 已更新订阅和积分信息: sub=${subscriptionInfo.sub}, credits=${subscriptionInfo.credits}`);

      res.json({
        success: true,
        message: 'Token刷新成功',
        data: {
          ...result,
          sub: subscriptionInfo.sub,
          credits: subscriptionInfo.credits,
          isActivated: subscriptionInfo.isActivated
        }
      });
    } catch (subscriptionError) {
      // 即使获取订阅信息失败，token 刷新仍然成功
      logger.warn(`获取订阅信息失败: ${subscriptionError.message}`);
      res.json({
        success: true,
        message: 'Token刷新成功（但获取订阅信息失败）',
        data: result
      });
    }
  } catch (error) {
    logger.error('刷新Token失败:', error.message);
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

// 测试代理连通性
router.post('/test-proxy', cookieAuthMiddleware, async (req, res) => {
  const proxyUrl = req.body?.proxy !== undefined ? String(req.body.proxy).trim() : (config.proxy || '');

  if (!proxyUrl) {
    return res.status(400).json({ success: false, message: '请先输入或配置代理地址' });
  }

  // 规范化代理地址（如果是 socks5h:// 转换为 socks5://；如果包含多余空格清理）
  let normalizedProxy = proxyUrl;
  if (normalizedProxy.startsWith('socks5h://')) {
    normalizedProxy = 'socks5://' + normalizedProxy.slice(10);
  }

  const startTime = Date.now();
  const testTarget = 'https://cloudcode-pa.googleapis.com';

  const isPkg = typeof process.pkg !== 'undefined';
  const configPath = isPkg
    ? path.join(path.dirname(process.execPath), 'bin', 'tls_config.json')
    : path.join(__dirname, '..', 'bin', 'tls_config.json');

  try {
    let status = 200;
    try {
      const requester = fingerprintRequester.create({
        configPath,
        proxy: normalizedProxy,
        timeout: 8
      });

      const response = await requester.antigravity_fetch(testTarget, {
        method: 'GET',
        timeout_ms: 8000
      });
      requester.close();
      status = response.status;
    } catch (tlsError) {
      logger.warn(`[ProxyTest] FingerprintRequester 测试失败，使用 Axios 降级重试: ${tlsError.message}`);
      
      const axiosConfig = {
        method: 'GET',
        url: testTarget,
        timeout: 8000,
        validateStatus: () => true
      };

      if (normalizedProxy.startsWith('socks')) {
        // 对于 SOCKS5 代理，Axios 路径使用内置代理转换或通用链接测试
        try {
          const u = new URL(normalizedProxy);
          axiosConfig.proxy = {
            protocol: 'http',
            host: u.hostname,
            port: parseInt(u.port, 10)
          };
        } catch {
          axiosConfig.proxy = false;
        }
      } else {
        const buildConfig = buildAxiosRequestConfig({
          method: 'GET',
          url: testTarget,
          timeout: 8000
        });
        axiosConfig.httpAgent = buildConfig.httpAgent;
        axiosConfig.httpsAgent = buildConfig.httpsAgent;
        try {
          const u = new URL(normalizedProxy);
          axiosConfig.proxy = {
            protocol: u.protocol.replace(':', ''),
            host: u.hostname,
            port: parseInt(u.port, 10)
          };
        } catch {
          axiosConfig.proxy = false;
        }
      }

      const axiosRes = await axios(axiosConfig);
      status = axiosRes.status;
    }

    const duration = Date.now() - startTime;
    res.json({
      success: true,
      message: `代理连接正常！状态码: ${status} (${duration}ms)`,
      data: {
        latency: duration,
        status,
        proxy: proxyUrl
      }
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.warn(`[ProxyTest] 代理连通性测试失败: ${error.message}`);
    res.status(500).json({
      success: false,
      message: `代理连接失败 (${duration}ms): ${error.message}`,
      data: {
        latency: duration,
        error: error.message,
        proxy: proxyUrl
      }
    });
  }
});

// 手动获取指定Token的Project ID（使用 tokenId）
router.post('/tokens/:tokenId/fetch-project-id', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  try {
    const result = await tokenManager.fetchProjectIdForToken(tokenId);
    logger.info(`手动获取ProjectId: ${tokenId} -> ${result.projectId}`);
    res.json({ success: true, message: 'Project ID获取成功', projectId: result.projectId });
  } catch (error) {
    logger.error('获取ProjectId失败:', error.message);
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

// 导出所有 Token（需要密码验证）
router.post('/tokens/export', cookieAuthMiddleware, async (req, res) => {
  const { password } = req.body;

  if (!password || !verifyPassword(password)) {
    return res.status(403).json({ success: false, message: '密码验证失败' });
  }

  try {
    const allTokens = await tokenManager.store.readAll();

    // 导出格式：包含完整的 token 数据
    logger.info('导出所有Token数据');
    const exportData = {
      version: 1,
      exportTime: new Date().toISOString(),
      tokens: allTokens.map(token => ({
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_in: token.expires_in,
        timestamp: token.timestamp,
        enable: token.enable,
        projectId: token.projectId,
        email: token.email,
        hasQuota: token.hasQuota
      }))
    };

    res.json({ success: true, data: exportData });
  } catch (error) {
    logger.error('导出Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 智能查找字段值（不分大小写，包含匹配）
function findFieldByKeyword(obj, keyword) {
  if (!obj || typeof obj !== 'object') return undefined;
  const lowerKeyword = keyword.toLowerCase();
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase().includes(lowerKeyword)) {
      return obj[key];
    }
  }
  return undefined;
}

function normalizeImportedTextValue(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function normalizeImportedProjectId(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object') {
    return normalizeImportedProjectId(value.id ?? value.projectId ?? value.name);
  }
  return normalizeImportedTextValue(value);
}

function normalizeImportedBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function parseImportedEnable(rawToken) {
  let enable = findFieldByKeyword(rawToken, 'enable');
  if (enable === undefined) enable = findFieldByKeyword(rawToken, 'enabled');

  let disabled = findFieldByKeyword(rawToken, 'disable');
  if (disabled === undefined) disabled = findFieldByKeyword(rawToken, 'disabled');

  if (enable === undefined && disabled !== undefined) {
    return !normalizeImportedBoolean(disabled);
  }

  if (enable === undefined) return true;
  return normalizeImportedBoolean(enable);
}

function deriveImportedExpiresInAndTimestamp({ expires_in, expiry, timestamp }) {
  const nowMs = Date.now();

  let finalExpiresIn = null;
  if (expires_in !== undefined && expires_in !== null && String(expires_in).trim() !== '') {
    const parsed = parseInt(expires_in, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      finalExpiresIn = parsed;
    }
  }

  let finalTimestamp;
  if (finalExpiresIn === null && typeof expiry === 'string' && expiry.trim()) {
    const expiryMs = Date.parse(expiry);
    if (Number.isFinite(expiryMs)) {
      finalExpiresIn = Math.max(1, Math.floor((expiryMs - nowMs) / 1000));
      finalTimestamp = nowMs;
    }
  }

  if (finalTimestamp === undefined) {
    if (timestamp !== undefined && timestamp !== null && String(timestamp).trim() !== '') {
      if (typeof timestamp === 'number') {
        finalTimestamp = timestamp;
      } else {
        const parsedTimestamp = Date.parse(timestamp);
        finalTimestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : nowMs;
      }
    } else {
      finalTimestamp = nowMs;
    }
  }

  return {
    expires_in: finalExpiresIn ?? 3599,
    timestamp: finalTimestamp
  };
}

// 智能解析单个 Token 对象
function smartParseToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'object') return null;

  const refresh_token = normalizeImportedTextValue(findFieldByKeyword(rawToken, 'refresh'));

  if (!refresh_token) return null;

  const token = { refresh_token };

  const projectId = normalizeImportedProjectId(findFieldByKeyword(rawToken, 'project'));
  const access_token = normalizeImportedTextValue(findFieldByKeyword(rawToken, 'access') || rawToken.token);
  const email = normalizeImportedTextValue(findFieldByKeyword(rawToken, 'email') || findFieldByKeyword(rawToken, 'mail'));
  const expires_in = findFieldByKeyword(rawToken, 'expires') || findFieldByKeyword(rawToken, 'expire');
  const timestamp = findFieldByKeyword(rawToken, 'time') || findFieldByKeyword(rawToken, 'stamp') || findFieldByKeyword(rawToken, 'created');
  const expiry = findFieldByKeyword(rawToken, 'expiry') || findFieldByKeyword(rawToken, 'expiresat');
  const hasQuota = findFieldByKeyword(rawToken, 'quota');
  const sub = normalizeImportedTextValue(findFieldByKeyword(rawToken, 'subscription') || findFieldByKeyword(rawToken, 'tier') || rawToken.sub);
  const credits = findFieldByKeyword(rawToken, 'credit');

  if (projectId) token.projectId = projectId;
  if (access_token) token.access_token = access_token;
  if (email) token.email = email;

  const derived = deriveImportedExpiresInAndTimestamp({ expires_in, expiry, timestamp });
  token.expires_in = derived.expires_in;
  token.timestamp = derived.timestamp;
  token.enable = parseImportedEnable(rawToken);

  if (hasQuota !== undefined) token.hasQuota = normalizeImportedBoolean(hasQuota);
  if (sub) token.sub = sub;
  if (credits !== undefined && credits !== null && String(credits).trim() !== '') {
    const parsedCredits = Number(credits);
    if (Number.isFinite(parsedCredits)) {
      token.credits = parsedCredits;
    }
  }

  return token;
}

// ==================== Gemini CLI Token 导入解析辅助 ====================

function extractGeminiCliImportList(data) {
  // 兼容多种 gcli 导出结构：
  // - { tokens: [...] }
  // - { accounts: [...] }
  // - { data: { tokens/accounts: [...] } }
  // - 直接数组 [...]
  // - 单个凭证对象 { token/refresh_token/project_id/expiry/... }
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;

  const list = data.tokens || data.accounts || data.data?.tokens || data.data?.accounts;
  if (Array.isArray(list)) return list;

  const hasRefresh = !!(data.refresh_token || data.refreshToken);
  const hasAccess = !!(data.access_token || data.accessToken || data.token);
  if (hasRefresh || hasAccess) return [data];
  return null;
}

function normalizeTruthyBoolean(value) {
  return value === true || value === 'true' || value === 1;
}

function parseGeminiCliEnable(rawToken) {
  // enable/enabled/disabled 兼容
  let enable = findFieldByKeyword(rawToken, 'enable');
  if (enable === undefined) enable = findFieldByKeyword(rawToken, 'enabled');
  let disabled = findFieldByKeyword(rawToken, 'disable');
  if (disabled === undefined) disabled = findFieldByKeyword(rawToken, 'disabled');
  if (enable === undefined && disabled !== undefined) {
    enable = !normalizeTruthyBoolean(disabled);
  }
  if (enable === undefined) enable = true;
  return normalizeTruthyBoolean(enable);
}

function deriveExpiresInAndTimestamp({ expires_in, expiry, timestamp }) {
  // expires_in / expiry 兼容：
  // - 如果有 expires_in(秒) -> 直接用
  // - 如果只有 expiry(ISO8601) -> 计算剩余秒数，并把 timestamp 设为当前时间
  const nowMs = Date.now();

  let finalExpiresIn = null;
  if (expires_in !== undefined && expires_in !== null && String(expires_in).trim() !== '') {
    const n = parseInt(expires_in, 10);
    if (Number.isFinite(n) && n > 0) finalExpiresIn = n;
  }

  let finalTimestamp = undefined;
  if (finalExpiresIn === null && typeof expiry === 'string' && expiry.trim()) {
    const expiryMs = Date.parse(expiry);
    if (Number.isFinite(expiryMs)) {
      finalExpiresIn = Math.max(1, Math.floor((expiryMs - nowMs) / 1000));
      // 用 expiry 推算时，让 timestamp 表示“当前拿到 token 的时间”
      finalTimestamp = nowMs;
    }
  }

  if (finalTimestamp === undefined) {
    if (timestamp) {
      finalTimestamp = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
    } else {
      finalTimestamp = nowMs;
    }
  }

  return {
    expires_in: finalExpiresIn ?? 3599,
    timestamp: finalTimestamp
  };
}

function smartParseGeminiCliToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'object') return null;

  const refresh_token = findFieldByKeyword(rawToken, 'refresh');
  if (!refresh_token) return null;

  const token = { refresh_token };

  // gcli 常见字段：token（=access_token）
  const access_token = findFieldByKeyword(rawToken, 'access') || rawToken.token;
  const email = findFieldByKeyword(rawToken, 'email') || findFieldByKeyword(rawToken, 'mail');
  const expires_in = findFieldByKeyword(rawToken, 'expires') || findFieldByKeyword(rawToken, 'expire');
  const timestamp = findFieldByKeyword(rawToken, 'time') || findFieldByKeyword(rawToken, 'stamp') || findFieldByKeyword(rawToken, 'created');
  const expiry = findFieldByKeyword(rawToken, 'expiry') || findFieldByKeyword(rawToken, 'expiresat');
  const projectId = findFieldByKeyword(rawToken, 'project');

  if (access_token) token.access_token = access_token;
  if (email) token.email = email;
  if (projectId) token.projectId = projectId;

  const derived = deriveExpiresInAndTimestamp({ expires_in, expiry, timestamp });
  token.expires_in = derived.expires_in;
  token.timestamp = derived.timestamp;
  token.enable = parseGeminiCliEnable(rawToken);

  return token;
}

// 导入 Token（需要密码验证，支持智能字段映射）
router.post('/tokens/import', cookieAuthMiddleware, async (req, res) => {
  const { password, data, mode = 'merge' } = req.body;

  if (!password || !verifyPassword(password)) {
    return res.status(403).json({ success: false, message: '密码验证失败' });
  }

  if (!data || !data.tokens || !Array.isArray(data.tokens)) {
    return res.status(400).json({ success: false, message: '无效的导入数据格式' });
  }

  try {
    const importTokens = data.tokens;
    let addedCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;

    // 智能解析所有 token
    const parsedTokens = [];
    for (const rawToken of importTokens) {
      const parsed = smartParseToken(rawToken);
      if (parsed) {
        parsedTokens.push(parsed);
      } else {
        skippedCount++;
      }
    }

    if (mode === 'replace') {
      // 替换模式：清空现有数据，导入新数据
      await tokenManager.store.writeAll(parsedTokens);
      addedCount = parsedTokens.length;
    } else {
      // 合并模式：根据 refresh_token 去重
      const existingTokens = await tokenManager.store.readAll();
      const existingRefreshTokens = new Set(existingTokens.map(t => t.refresh_token));

      for (const token of parsedTokens) {
        if (existingRefreshTokens.has(token.refresh_token)) {
          // 更新已存在的 token
          const index = existingTokens.findIndex(t => t.refresh_token === token.refresh_token);
          if (index !== -1) {
            existingTokens[index] = { ...existingTokens[index], ...token };
            updatedCount++;
          }
        } else {
          // 添加新 token
          existingTokens.push(token);
          addedCount++;
        }
      }

      await tokenManager.store.writeAll(existingTokens);
    }

    await tokenManager.reload();

    logger.info(`导入Token: 新增 ${addedCount}, 更新 ${updatedCount}, 跳过 ${skippedCount}`);
    res.json({
      success: true,
      message: `导入完成：新增 ${addedCount} 个，更新 ${updatedCount} 个，跳过 ${skippedCount} 个`,
      data: { added: addedCount, updated: updatedCount, skipped: skippedCount }
    });
  } catch (error) {
    logger.error('导入Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/oauth/exchange', cookieAuthMiddleware, async (req, res) => {
  const { code, port, mode = 'antigravity' } = req.body;
  if (!code || !port) {
    return res.status(400).json({ success: false, message: 'code和port必填' });
  }

  try {
    const account = await oauthManager.authenticate(code, port, mode);
    
    if (mode === 'geminicli') {
      // Gemini CLI 模式
      res.json({ success: true, data: account, message: 'Gemini CLI Token添加成功' });
    } else {
      // Antigravity 模式
      const message = account.hasQuota
        ? 'Token添加成功'
        : 'Token添加成功（该账号无资格，已自动使用随机ProjectId）';
      res.json({ success: true, data: account, message, fallbackMode: !account.hasQuota });
    }
  } catch (error) {
    logger.error(`[${mode}] 认证失败:`, error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取配置
router.get('/config', cookieAuthMiddleware, (req, res) => {
  try {
    const envData = parseEnvFile(envPath);
    const jsonData = getConfigJson();

    res.json({ success: true, data: { env: envData, json: jsonData } });
  } catch (error) {
    logger.error('读取配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新配置
router.put('/config', cookieAuthMiddleware, (req, res) => {
  try {
    const { env: envUpdates, json: jsonUpdates, password } = req.body;

    // 安全检查：如果修改了官方系统提示词，必须验证密码
    if (envUpdates && envUpdates.OFFICIAL_SYSTEM_PROMPT !== undefined) {
      const currentEnv = parseEnvFile(envPath);
      // 正规化换行符后再比较（避免 \r\n 和 \n 不一致导致误判）
      const normalizeNewlines = (str) => (str || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
      const newValue = normalizeNewlines(envUpdates.OFFICIAL_SYSTEM_PROMPT);
      const oldValue = normalizeNewlines(currentEnv.OFFICIAL_SYSTEM_PROMPT);

      // 只有当值真正改变时才检查
      if (newValue !== oldValue) {
        if (!password || !verifyPassword(password)) {
          logger.warn(`尝试修改官方系统提示词但密码验证失败 IP: ${getClientIP(req)}`);
          return res.status(403).json({
            success: false,
            message: '修改官方系统提示词需要验证管理员密码'
          });
        }
      }
    }

    if (envUpdates) updateEnvFile(envPath, envUpdates);
    if (jsonUpdates) saveConfigJson(deepMerge(getConfigJson(), jsonUpdates));

    dotenv.config({ override: true });
    reloadConfig();

    // 应用可热更新的运行时配置
    memoryManager.setCleanupInterval(config.server.memoryCleanupInterval);

    logger.info('系统配置已更新并热重载');
    res.json({ success: true, message: '配置已保存并生效（端口/HOST修改需重启）' });
  } catch (error) {
    logger.error('更新配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取轮询策略配置
router.get('/rotation', cookieAuthMiddleware, (req, res) => {
  try {
    const rotationConfig = tokenManager.getRotationConfig();
    res.json({ success: true, data: rotationConfig });
  } catch (error) {
    logger.error('获取轮询配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新轮询策略配置
router.put('/rotation', cookieAuthMiddleware, (req, res) => {
  try {
    const { strategy, requestCount } = req.body;

    // 验证策略值
    const validStrategies = ['round_robin', 'quota_exhausted', 'request_count'];
    if (strategy && !validStrategies.includes(strategy)) {
      return res.status(400).json({
        success: false,
        message: `无效的策略，可选值: ${validStrategies.join(', ')}`
      });
    }

    // 更新内存中的配置
    tokenManager.updateRotationConfig(strategy, requestCount);

    // 保存到config.json
    const currentConfig = getConfigJson();
    if (!currentConfig.rotation) currentConfig.rotation = {};
    if (strategy) currentConfig.rotation.strategy = strategy;
    if (requestCount) currentConfig.rotation.requestCount = requestCount;
    saveConfigJson(currentConfig);

    // 重载配置到内存
    reloadConfig();

    logger.info(`轮询策略已更新: ${strategy || '未变'}, 请求次数: ${requestCount || '未变'}`);
    res.json({ success: true, message: '轮询策略已更新', data: tokenManager.getRotationConfig() });
  } catch (error) {
    logger.error('更新轮询配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== API Key 管理 API ====================

// 获取 API Key 列表
router.get('/api-keys', cookieAuthMiddleware, (req, res) => {
  try {
    const keys = apiKeyManager.getAllKeys();
    const stats = apiKeyManager.getOverallStats();
    res.json({ success: true, data: { keys, stats } });
  } catch (error) {
    logger.error('获取 API 密钥列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 创建 API Key
router.post('/api-keys', cookieAuthMiddleware, (req, res) => {
  try {
    const { name, key, maxTokens } = req.body;
    const newKey = apiKeyManager.createKey({ name, key, maxTokens });
    logger.info(`创建新 API 密钥: ${newKey.name} (${newKey.id}), maxTokens=${newKey.maxTokens || '无限制'}`);
    res.json({ success: true, data: newKey, message: '创建 API 密钥成功' });
  } catch (error) {
    logger.error('创建 API 密钥失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新 API Key (修改名称 / 启用状态 / 密钥文本 / Max Tokens)
router.put('/api-keys/:id', cookieAuthMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { name, enabled, key, maxTokens } = req.body;
    const updated = apiKeyManager.updateKey(id, { name, enabled, key, maxTokens });
    if (!updated) {
      return res.status(404).json({ success: false, message: 'API 密钥不存在' });
    }
    logger.info(`更新 API 密钥 (${id}): ${updated.name}, enabled=${updated.enabled}, maxTokens=${updated.maxTokens || '无限制'}`);
    res.json({ success: true, data: updated, message: '更新成功' });
  } catch (error) {
    logger.error('更新 API 密钥失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 删除 API Key
router.delete('/api-keys/:id', cookieAuthMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const success = apiKeyManager.deleteKey(id);
    if (!success) {
      return res.status(404).json({ success: false, message: 'API 密钥不存在' });
    }
    logger.info(`删除 API 密钥 (${id})`);
    res.json({ success: true, message: '删除成功' });
  } catch (error) {
    logger.error('删除 API 密钥失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== 日志管理 API ====================

// 获取日志列表
router.get('/logs', cookieAuthMiddleware, (req, res) => {
  try {
    const { level, search, limit, offset } = req.query;
    const options = {
      level: level || 'all',
      search: search || '',
      limit: parseInt(limit) || 100,
      offset: parseInt(offset) || 0
    };

    const result = logger.getLogs(options);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('获取日志失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取日志统计
router.get('/logs/stats', cookieAuthMiddleware, (req, res) => {
  try {
    const stats = logger.getLogStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('获取日志统计失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 清空日志
router.delete('/logs', cookieAuthMiddleware, (req, res) => {
  try {
    logger.clearLogs();
    logger.info('日志已清空');
    res.json({ success: true, message: '日志已清空' });
  } catch (error) {
    logger.error('清空日志失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== Token 额度 API ====================

// ==================== Gemini CLI Token 管理 API ====================

// 获取 Gemini CLI Token 列表
router.get('/geminicli/tokens', cookieAuthMiddleware, async (req, res) => {
  try {
    const tokens = await geminicliTokenManager.getTokenList();
    res.json({ success: true, data: tokens });
  } catch (error) {
    logger.error('[GeminiCLI] 获取Token列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 添加 Gemini CLI Token
router.post('/geminicli/tokens', cookieAuthMiddleware, async (req, res) => {
  const { access_token, refresh_token, expires_in, timestamp, enable, email } = req.body;
  if (!access_token || !refresh_token) {
    return res.status(400).json({ success: false, message: 'access_token和refresh_token必填' });
  }
  const tokenData = { access_token, refresh_token, expires_in };
  if (timestamp) tokenData.timestamp = timestamp;
  if (enable !== undefined) tokenData.enable = enable;
  if (email) tokenData.email = email;

  try {
    const result = await geminicliTokenManager.addToken(tokenData);
    logger.info(`[GeminiCLI] 添加新Token: ${access_token.substring(0, 8)}...`);
    res.json(result);
  } catch (error) {
    logger.error('[GeminiCLI] 添加Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新 Gemini CLI Token
router.put('/geminicli/tokens/:tokenId', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  const updates = req.body;

  // 不允许通过 API 更新敏感字段
  delete updates.access_token;
  delete updates.refresh_token;

  try {
    const result = await geminicliTokenManager.updateTokenById(tokenId, updates);
    logger.info(`[GeminiCLI] 更新Token: ${tokenId}`);
    res.json(result);
  } catch (error) {
    logger.error('[GeminiCLI] 更新Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 删除 Gemini CLI Token
router.delete('/geminicli/tokens/:tokenId', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  try {
    const result = await geminicliTokenManager.deleteTokenById(tokenId);
    logger.info(`[GeminiCLI] 删除Token: ${tokenId}`);
    res.json(result);
  } catch (error) {
    logger.error('[GeminiCLI] 删除Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 热重载 Gemini CLI Token
router.post('/geminicli/tokens/reload', cookieAuthMiddleware, async (req, res) => {
  try {
    await geminicliTokenManager.reload();
    logger.info('[GeminiCLI] 手动触发Token热重载');
    res.json({ success: true, message: 'Gemini CLI Token已热重载' });
  } catch (error) {
    logger.error('[GeminiCLI] 热重载失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 刷新指定 Gemini CLI Token
router.post('/geminicli/tokens/:tokenId/refresh', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  try {
    const result = await geminicliTokenManager.refreshTokenById(tokenId);
    logger.info(`[GeminiCLI] 手动刷新Token: ${tokenId}`);
    res.json({ success: true, message: 'Token刷新成功', data: result });
  } catch (error) {
    logger.error('[GeminiCLI] 刷新Token失败:', error.message);
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

// 手动获取指定 Gemini CLI Token 的 Project ID
router.post('/geminicli/tokens/:tokenId/fetch-project-id', cookieAuthMiddleware, async (req, res) => {
  const { tokenId } = req.params;
  try {
    const result = await geminicliTokenManager.fetchProjectIdForToken(tokenId);
    logger.info(`[GeminiCLI] 手动获取ProjectId: ${tokenId} -> ${result.projectId}`);
    res.json({ success: true, message: 'Project ID获取成功', projectId: result.projectId });
  } catch (error) {
    logger.error('[GeminiCLI] 获取ProjectId失败:', error.message);
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

// 导出 Gemini CLI Token（需要密码验证）
router.post('/geminicli/tokens/export', cookieAuthMiddleware, async (req, res) => {
  const { password } = req.body;

  if (!password || !verifyPassword(password)) {
    return res.status(403).json({ success: false, message: '密码验证失败' });
  }

  try {
    const allTokens = await geminicliTokenManager.store.readAll();

    logger.info('[GeminiCLI] 导出所有Token数据');
    const exportData = {
      version: 1,
      exportTime: new Date().toISOString(),
      tokens: allTokens.map(token => ({
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_in: token.expires_in,
        timestamp: token.timestamp,
        enable: token.enable,
        email: token.email,
        projectId: token.projectId
      }))
    };

    res.json({ success: true, data: exportData });
  } catch (error) {
    logger.error('[GeminiCLI] 导出Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 导入 Gemini CLI Token（需要密码验证）
router.post('/geminicli/tokens/import', cookieAuthMiddleware, async (req, res) => {
  const { password, data, mode = 'merge' } = req.body;

  if (!password || !verifyPassword(password)) {
    return res.status(403).json({ success: false, message: '密码验证失败' });
  }

  const importList = extractGeminiCliImportList(data);

  if (!Array.isArray(importList)) {
    return res.status(400).json({ success: false, message: '无效的导入数据格式' });
  }

  try {
    const importTokens = importList;
    let addedCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;

    const parsedTokens = [];
    for (const rawToken of importTokens) {
      const parsed = smartParseGeminiCliToken(rawToken);
      if (parsed) parsedTokens.push(parsed);
      else skippedCount++;
    }

    if (mode === 'replace') {
      await geminicliTokenManager.store.writeAll(parsedTokens);
      addedCount = parsedTokens.length;
    } else {
      const existingTokens = await geminicliTokenManager.store.readAll();
      const existingRefreshTokens = new Set(existingTokens.map(t => t.refresh_token));

      for (const token of parsedTokens) {
        if (existingRefreshTokens.has(token.refresh_token)) {
          const index = existingTokens.findIndex(t => t.refresh_token === token.refresh_token);
          if (index !== -1) {
            existingTokens[index] = { ...existingTokens[index], ...token };
            updatedCount++;
          }
        } else {
          existingTokens.push(token);
          addedCount++;
        }
      }

      await geminicliTokenManager.store.writeAll(existingTokens);
    }

    await geminicliTokenManager.reload();

    logger.info(`[GeminiCLI] 导入Token: 新增 ${addedCount}, 更新 ${updatedCount}, 跳过 ${skippedCount}`);
    res.json({
      success: true,
      message: `导入完成：新增 ${addedCount} 个，更新 ${updatedCount} 个，跳过 ${skippedCount} 个`,
      data: { added: addedCount, updated: updatedCount, skipped: skippedCount }
    });
  } catch (error) {
    logger.error('[GeminiCLI] 导入Token失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== IP 封禁管理 API ====================

// 获取封禁列表
router.get('/blocked-ips', cookieAuthMiddleware, async (req, res) => {
  try {
    const list = await ipBlockManager.listBlocked();
    res.json({ success: true, data: list });
  } catch (error) {
    logger.error('获取封禁列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 手动封禁指定IP (加入黑名单)
router.post('/block-ip', cookieAuthMiddleware, async (req, res) => {
  try {
    const { ip, permanent = true, durationMs } = req.body;
    if (!ip) {
      return res.status(400).json({ success: false, message: 'IP地址必填' });
    }
    const cleanIp = String(ip).trim();
    await ipBlockManager.blockIP(cleanIp, permanent, durationMs);
    res.json({ success: true, message: `IP ${cleanIp} 已成功加入黑名单封禁！` });
  } catch (error) {
    logger.error('手动封禁IP失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 解除IP封禁
router.post('/unblock-ip', cookieAuthMiddleware, async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ success: false, message: 'IP地址必填' });
    }
    const success = await ipBlockManager.unblock(ip);
    if (success) {
      res.json({ success: true, message: `IP ${ip} 已解除封禁` });
    } else {
      res.status(404).json({ success: false, message: 'IP不在封禁列表中' });
    }
  } catch (error) {
    logger.error('解除封禁失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取安全配置
router.get('/security-config', cookieAuthMiddleware, async (req, res) => {
  try {
    const config = ipBlockManager.getConfig();
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('获取安全配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新安全配置
router.put('/security-config', cookieAuthMiddleware, async (req, res) => {
  try {
    const { config: updates } = req.body;
    const currentConfig = ipBlockManager.getConfig();
    const mergedConfig = deepMerge(currentConfig, updates);
    await ipBlockManager.updateConfig(mergedConfig);
    res.json({ success: true, message: '安全配置已更新' });
  } catch (error) {
    logger.error('更新安全配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 添加白名单IP
router.post('/whitelist-ip', cookieAuthMiddleware, async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ success: false, message: 'IP地址必填' });
    }
    const success = await ipBlockManager.addWhitelistIP(ip);
    if (success) {
      res.json({ success: true, message: `IP ${ip} 已添加到白名单` });
    } else {
      res.json({ success: false, message: 'IP已在白名单中' });
    }
  } catch (error) {
    logger.error('添加白名单失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 移除白名单IP
router.delete('/whitelist-ip', cookieAuthMiddleware, async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ success: false, message: 'IP地址必填' });
    }
    const success = await ipBlockManager.removeWhitelistIP(ip);
    if (success) {
      res.json({ success: true, message: `IP ${ip} 已从白名单移除` });
    } else {
      res.status(404).json({ success: false, message: 'IP不在白名单中' });
    }
  } catch (error) {
    logger.error('移除白名单失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== Token 额度 API ====================

// 获取指定Token的模型额度（使用 tokenId）
router.get('/tokens/:tokenId/quotas', cookieAuthMiddleware, async (req, res) => {
  try {
    const { tokenId } = req.params;
    const forceRefresh = req.query.refresh === 'true';
    let subscriptionInfo = null;

    // 通过 tokenId 查找完整的 token 数据
    let tokenData = await tokenManager.findTokenById(tokenId);

    if (!tokenData) {
      return res.status(404).json({ success: false, message: 'Token不存在' });
    }

    // 检查 token 是否禁用
    const isDisabled = tokenData.enable === false;

    // 使用 tokenId 作为缓存键，优先获取缓存数据
    let quotaData = quotaManager.getQuota(tokenId);

    // 禁用的 token 只返回缓存数据，不刷新也不获取新数据
    if (isDisabled) {
      if (!quotaData) {
        // 没有缓存数据，返回空数据
        quotaData = { lastUpdated: null, models: {} };
      }
    } else {
      // 启用的 token 正常处理
      // 检查token是否过期，如果过期则刷新
      if (tokenManager.isExpired(tokenData)) {
        try {
          tokenData = await tokenManager.refreshToken(tokenData);
        } catch (error) {
          logger.error('刷新token失败:', error.message);
          // 使用 400 而不是 401，避免前端误认为 JWT 登录过期
          return res.status(400).json({ success: false, message: 'Google Token已过期且刷新失败，请重新登录Google账号' });
        }
      }

      // 强制刷新时清除缓存
      if (forceRefresh) {
        quotaData = null;

        try {
          subscriptionInfo = await tokenManager.refreshSubscriptionAndCreditsById(tokenId);
        } catch (subscriptionError) {
          logger.warn(`刷新积分信息失败: ${subscriptionError.message}`);
        }
      }

      if (!quotaData) {
        // 缓存未命中或强制刷新，从API获取
        const quotas = await getModelsWithQuotas(tokenData);
        quotaManager.updateQuota(tokenId, quotas);
        // 从缓存中获取完整数据（包含 requestCounts），而不是构造不完整的对象
        quotaData = quotaManager.getQuota(tokenId) || { lastUpdated: Date.now(), models: quotas, requestCounts: {} };
      }
    }

    // 转换时间为北京时间
    const modelsWithBeijingTime = {};
    Object.entries(quotaData.models).forEach(([modelId, quota]) => {
      modelsWithBeijingTime[modelId] = {
        remaining: quota.r,
        resetTime: quotaManager.convertToBeijingTime(quota.t),
        resetTimeRaw: quota.t,
        weeklyRemaining: quota.wr ?? null,
        weeklyResetTime: quota.wt ? quotaManager.convertToBeijingTime(quota.wt) : null,
        weeklyResetTimeRaw: quota.wt ?? null
      };
    });

    // 获取请求计数
    const requestCounts = quotaData.requestCounts || {};

    res.json({
      success: true,
      data: {
        lastUpdated: quotaData.lastUpdated,
        models: modelsWithBeijingTime,
        requestCounts, // 返回请求计数供前端计算预估
        tokenMeta: subscriptionInfo ? {
          sub: subscriptionInfo.sub,
          credits: subscriptionInfo.credits,
          isActivated: subscriptionInfo.isActivated
        } : null
      }
    });
  } catch (error) {
    logger.error('获取额度失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== 域名与 SSL 证书管理 API ====================

// 获取证书及域名信息
router.get('/certificate', cookieAuthMiddleware, async (req, res) => {
  try {
    const certInfo = getCertificateInfo();
    const currentConfig = getConfigJson();
    res.json({
      success: true,
      data: {
        ...certInfo,
        serverDomain: currentConfig.server?.domain || certInfo.domain || '',
        autoRenewCert: currentConfig.server?.autoRenewCert !== false && certInfo.autoRenew !== false,
        port: currentConfig.server?.port || 443
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新/编辑域名配置并更新/重新签发证书
router.put('/certificate/domain', cookieAuthMiddleware, async (req, res) => {
  const { domain } = req.body;
  const cleanDomain = (domain || '').trim();

  try {
    const currentConfig = getConfigJson();
    if (!cleanDomain) {
      // 留空即切换为自签 IP 证书模式
      await generateSelfSignedCert('127.0.0.1');
      saveConfigJson({ server: { ...currentConfig.server, domain: '' } });
      if (server && server.reloadSSLContext) server.reloadSSLContext();
      return res.json({ success: true, message: '已切换为自签 IP 证书模式' });
    }

    // 校验域名 DNS 解析
    const dnsCheck = await verifyDomainDNS(cleanDomain);
    if (!dnsCheck.valid) {
      return res.status(400).json({ success: false, message: `域名解析验证失败: ${dnsCheck.reason}` });
    }

    // 调用 acme 签发证书
    await issueAcmeCert(cleanDomain);
    saveConfigJson({ server: { ...currentConfig.server, domain: cleanDomain } });
    if (server && server.reloadSSLContext) server.reloadSSLContext();

    res.json({ success: true, message: `域名 ${cleanDomain} 证书已成功签发并配置！` });
  } catch (error) {
    logger.error('修改域名/签发证书失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 切换“自动更新证书”开关
router.put('/certificate/auto-renew', cookieAuthMiddleware, async (req, res) => {
  const { autoRenew } = req.body;
  const isEnabled = autoRenew === true;

  try {
    saveCertMeta({ autoRenew: isEnabled });
    const currentConfig = getConfigJson();
    saveConfigJson({ server: { ...currentConfig.server, autoRenewCert: isEnabled } });

    res.json({ success: true, message: `已${isEnabled ? '开启' : '关闭'}证书自动更新` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 手动贴入/编辑 SSL 证书内容 (.crt 和 .key)
router.put('/certificate/custom', cookieAuthMiddleware, async (req, res) => {
  const { cert, key, domain } = req.body;
  if (!cert || !key) {
    return res.status(400).json({ success: false, message: '证书 (CRT) 和私钥 (KEY) 内容均不能为空' });
  }

  try {
    updateCustomCert(cert, key, domain || '');
    if (server && server.reloadSSLContext) server.reloadSSLContext();
    res.json({ success: true, message: '自定义 SSL 证书及私钥更新成功！' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// 手动触发一键证书续期 / 重新签发
router.post('/certificate/renew', cookieAuthMiddleware, async (req, res) => {
  try {
    const certInfo = getCertificateInfo();
    const currentConfig = getConfigJson();
    const targetDomain = currentConfig.server?.domain || certInfo.domain;

    if (!targetDomain || certInfo.type === 'self-signed') {
      return res.status(400).json({ success: false, message: '当前使用自签 IP 证书，无需续期。若要绑定域名请先设置域名。' });
    }

    await issueAcmeCert(targetDomain);
    if (server && server.reloadSSLContext) server.reloadSSLContext();

    res.json({ success: true, message: `域名 ${targetDomain} 的 SSL 证书手动续期/重新签发成功！` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== WARP 客户端管理端点 ====================

// 获取 WARP 运行状态与出口 IP
router.get('/warp/status', cookieAuthMiddleware, async (req, res) => {
  try {
    const status = await warpManager.getStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 手动重启 WARP 并刷新出口 IP
router.post('/warp/restart', cookieAuthMiddleware, async (req, res) => {
  try {
    const success = await warpManager.restartWarp('管理员手动触发重启');
    if (success) {
      const newStatus = await warpManager.getStatus();
      res.json({ success: true, message: 'WARP 客户端重启并刷新出口 IP 成功！', data: newStatus });
    } else {
      res.status(429).json({ success: false, message: 'WARP 处于重启冷却中或已有任务执行，请稍后再试' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 一键配置/更新 WARP 自动自愈开关
router.put('/warp/auto-restart', cookieAuthMiddleware, async (req, res) => {
  const { autoRestart } = req.body;
  const isEnabled = autoRestart !== false;
  try {
    const currentConfig = getConfigJson();
    saveConfigJson({ warp: { ...currentConfig.warp, autoRestart: isEnabled } });
    config.warp = config.warp || {};
    config.warp.autoRestart = isEnabled;
    res.json({ success: true, message: `已${isEnabled ? '开启' : '关闭'}网络异常自动重启换 IP` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 一键将 PROXY 设置为 socks5://127.0.0.1:40000
router.post('/warp/use-proxy', cookieAuthMiddleware, async (req, res) => {
  try {
    const warpProxy = 'socks5://127.0.0.1:40000';
    updateEnvFile(envPath, { PROXY: warpProxy });
    process.env.PROXY = warpProxy;
    config.proxy = warpProxy;
    await reloadConfig();
    res.json({ success: true, message: '已成功将系统代理设置为 WARP SOCKS5 (socks5://127.0.0.1:40000)' });
  } catch (error) {
    logger.error('设置 WARP 代理失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 一键安装配置 WARP 客户端 (SOCKS5 40000)
router.post('/warp/quick-setup', cookieAuthMiddleware, async (req, res) => {
  try {
    const result = await warpManager.quickSetup();
    if (result.success) {
      // 自动设置代理
      const warpProxy = 'socks5://127.0.0.1:40000';
      updateEnvFile(envPath, { PROXY: warpProxy });
      process.env.PROXY = warpProxy;
      config.proxy = warpProxy;
      await reloadConfig();
      const newStatus = await warpManager.getStatus();
      res.json({ success: true, message: result.message, data: newStatus });
    } else {
      res.status(500).json({ success: false, message: result.message });
    }
  } catch (error) {
    logger.error('一键安装 WARP 失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
