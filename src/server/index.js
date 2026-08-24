/**
 * 服务器主入口
 * Express 应用配置、中间件、路由挂载、服务器启动和关闭
 */

import express from 'express';
import http from 'http';
import https from 'https';
import tls from 'tls';
import fs from 'fs';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import requesterManager from '../utils/requesterManager.js';
import logger from '../utils/logger.js';
import logWsServer from '../utils/logWsServer.js';
import config, { checkAndUpdateVersion } from '../config/config.js';
import memoryManager from '../utils/memoryManager.js';
import { getPublicDir, getRelativePath } from '../utils/paths.js';
import { errorHandler } from '../utils/errors.js';
import { getChunkPoolSize, clearChunkPool } from './stream.js';
import ipBlockManager from '../utils/ipBlockManager.js';
import apiKeyManager from '../auth/api_key_manager.js';
import { certsExist, getCertPaths, generateSelfSignedCert, getCertificateInfo, issueAcmeCert } from '../utils/sslManager.js';

// 路由模块
import adminRouter from '../routes/admin.js';
import sdRouter from '../routes/sd.js';
import openaiRouter from '../routes/openai.js';
import geminiRouter from '../routes/gemini.js';
import claudeRouter from '../routes/claude.js';
import cliRouter from '../routes/cli.js';

const publicDir = getPublicDir();

const app = express();

// 提取真实客户端 TCP 对端 IP（公网裸连时彻底忽略不可信的伪造请求头）
export function getRealClientIP(req) {
  let ip = req.socket?.remoteAddress || req.connection?.remoteAddress || req.ip || 'unknown';
  if (typeof ip === 'string' && ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  return ip;
}

// 公网裸连模式：禁用 trust proxy，防止外部攻击者构造伪造的 X-Forwarded-For 伪装内网白名单绕过封禁
app.set('trust proxy', false);
// 隐藏 Express 标识，降低指纹暴露
app.disable('x-powered-by');

// 初始化 IP 封禁管理器
ipBlockManager.init();

// 全局 IP 封禁检查中间件
app.use((req, res, next) => {
  const ip = getRealClientIP(req);
  req.realClientIP = ip;
  const status = ipBlockManager.check(ip);
  if (status.blocked) {
    if (status.reason === 'permanent') {
      return res.status(403).json({ error: 'Access Denied: Your IP has been permanently blocked.' });
    }
    const remainingMinutes = Math.ceil((status.expiresAt - Date.now()) / 60000);
    return res.status(429).json({ error: `Access Denied: Temporarily blocked for ${remainingMinutes} minutes.` });
  }
  next();
});

// ==================== 基础安全标头中间件 ====================
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ==================== 内存管理 ====================
memoryManager.start(config.server.memoryCleanupInterval);

// ==================== 基础中间件 ====================
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(cookieParser());
app.use(express.json({ limit: config.security.maxRequestSize }));

// 静态文件服务
app.use('/images', express.static(path.join(publicDir, 'images')));
app.use(express.static(publicDir));

// 管理路由
app.use('/admin', adminRouter);

// 使用统一错误处理中间件
app.use(errorHandler);

// ==================== 请求日志中间件 ====================
app.use((req, res, next) => {
  const ignorePaths = [
    '/images', '/favicon.ico', '/.well-known',
    '/sdapi/v1/options', '/sdapi/v1/samplers', '/sdapi/v1/schedulers',
    '/sdapi/v1/upscalers', '/sdapi/v1/latent-upscale-modes',
    '/sdapi/v1/sd-vae', '/sdapi/v1/sd-modules'
  ];
  // 提前获取完整路径，避免在路由处理后 req.path 被修改为相对路径
  const fullPath = req.originalUrl.split('?')[0];
  if (!ignorePaths.some(p => fullPath.startsWith(p))) {
    const start = Date.now();
    res.on('finish', () => {
      const clientIp = getRealClientIP(req);
      logger.request(req.method, fullPath, res.statusCode, Date.now() - start, clientIp, res.locals.tokenUsage);
    });
  }
  next();
});

// SD API 路由
app.use('/sdapi/v1', sdRouter);

// ==================== API Key 验证中间件 ====================
app.use((req, res, next) => {
  let providedKey = null;

  if (req.path.startsWith('/v1/') || req.path.startsWith('/cli/v1/')) {
    const authHeader = req.headers.authorization || req.headers['x-api-key'];
    providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  } else if (req.path.startsWith('/v1beta/')) {
    providedKey = req.query.key || req.headers['x-goog-api-key'];
  } else {
    return next();
  }

  const clientIP = getRealClientIP(req);
  const { valid, keyInfo } = apiKeyManager.validateKey(providedKey);
  if (!valid) {
    ipBlockManager.recordViolation(clientIP, 'auth_fail', 2);
    logger.warn(`API Key 验证失败: ${req.method} ${req.path} (IP: ${clientIP}, 提供的Key: ${providedKey ? providedKey.substring(0, 10) + '...' : '无'})`);
    return res.status(401).json({ error: 'Invalid API Key' });
  }

  req.apiKeyInfo = keyInfo;

  // 请求完成时如果记录了 tokenUsage，自动累加到当前 API Key
  res.on('finish', () => {
    if (res.locals.tokenUsage && req.apiKeyInfo?.id) {
      apiKeyManager.recordUsage(req.apiKeyInfo.id, res.locals.tokenUsage, res.locals.model || 'unknown');
    }
  });

  next();
});

// ==================== API 路由 ====================

// OpenAI 兼容 API
app.use('/v1', openaiRouter);

// Gemini 兼容 API
app.use('/v1beta', geminiRouter);

// Claude 兼容 API（/v1/messages 由 claudeRouter 处理）
app.use('/v1', claudeRouter);

// Gemini CLI 兼容 API
app.use('/cli', cliRouter);

// ==================== 系统端点 ====================

// 内存中记录 /api/check-usage 请求频次防止爆破枚举
const checkUsageRateLimits = new Map();

// 公开使用量查询端点（输入 API Key 查询使用量与模型分布，增加 IP 级防爆破限频）
app.post('/api/check-usage', (req, res) => {
  const clientIP = getRealClientIP(req);
  const now = Date.now();
  const rateInfo = checkUsageRateLimits.get(clientIP) || { count: 0, resetAt: now + 60000 };

  if (now > rateInfo.resetAt) {
    rateInfo.count = 1;
    rateInfo.resetAt = now + 60000;
  } else {
    rateInfo.count++;
  }
  checkUsageRateLimits.set(clientIP, rateInfo);

  // 定期清理过期的内存限频记录
  if (checkUsageRateLimits.size > 2000) {
    for (const [k, v] of checkUsageRateLimits.entries()) {
      if (now > v.resetAt) checkUsageRateLimits.delete(k);
    }
  }

  // 1分钟内单IP最多查询 20 次，超出则限流并累加违规记录
  if (rateInfo.count > 20) {
    ipBlockManager.recordViolation(clientIP, 'check_usage_rate_limit', 5);
    logger.warn(`⚠️ IP [${clientIP}] 频繁查询 /api/check-usage，触发限频保护`);
    return res.status(429).json({ success: false, message: '查询请求过于频繁，请 1 分钟后再试' });
  }

  const { key } = req.body || {};
  if (!key || typeof key !== 'string' || !key.trim()) {
    return res.status(400).json({ success: false, message: '请输入要查询的 API 密钥 (Key)' });
  }

  const report = apiKeyManager.queryUsageReport(key.trim());
  if (!report) {
    // 每次查询无效 key 计一次违规，防止黑客枚举有效 key
    ipBlockManager.recordViolation(clientIP, 'check_usage_invalid_key', 2);
    return res.status(404).json({ success: false, message: '未找到该 API 密钥，请检查输入是否正确' });
  }

  res.json({
    success: true,
    data: report
  });
});

// 内存监控端点
app.get('/v1/memory', (req, res) => {
  const usage = process.memoryUsage();
  res.json({
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    rss: usage.rss,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    poolSizes: memoryManager.getPoolSizes(),
    chunkPoolSize: getChunkPoolSize()
  });
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// 404 处理 (未匹配到任何路由)
app.use((req, res, next) => {
  // 白名单路径：这些路径的 404 不触发 IP 封禁
  // 包含客户端（如 Claude Code）可能请求但我们未实现的端点
  const whitelistPaths = [
    '/favicon.ico',
    '/robots.txt',
    '/.well-known',
    // 管理后台和日志
    '/ws/logs',
    // Claude API 相关端点
    '/api/event_logging',
    '/v1/complete',
    '/v1/models',
    // OpenAI API 相关端点
    '/v1/files',
    '/v1/fine-tunes',
    '/v1/fine_tuning',
    '/v1/assistants',
    '/v1/threads',
    '/v1/batches',
    '/v1/uploads',
    '/v1/organization',
    '/v1/usage',
    // Gemini API 相关端点
    '/v1beta/models'
  ];

  const path = req.path;
  const isWhitelisted = whitelistPaths.some(p => path === p || path.startsWith(p + '/'));

  if (isWhitelisted) {
    return res.status(404).json({ error: 'Not Found' });
  }

  const clientIP = getRealClientIP(req);
  ipBlockManager.recordViolation(clientIP, '404', 1);
  res.status(404).json({ error: 'Not Found' });
});

// ==================== 服务器启动 ====================
let server;
const certPaths = getCertPaths();

// 自动生成或检查证书
if (!certsExist()) {
  try {
    generateSelfSignedCert('127.0.0.1');
  } catch (err) {
    logger.warn('默认自签证书生成失败，系统将尝试备用 HTTP 模式或提示处理:', err.message);
  }
}

const useSSL = config.server.ssl !== false && certsExist();

if (useSSL) {
  try {
    const sslOptions = {
      cert: fs.readFileSync(certPaths.certPath),
      key: fs.readFileSync(certPaths.keyPath)
    };
    server = https.createServer(sslOptions, app);

    // 暴露热重载 SSL 上下文函数
    server.reloadSSLContext = () => {
      try {
        const certData = fs.readFileSync(certPaths.certPath);
        const keyData = fs.readFileSync(certPaths.keyPath);
        const newContext = tls.createSecureContext({
          cert: certData,
          key: keyData
        });
        server.setSecureContext(newContext);
        // 更新默认证书配置，确保后续新建 TLS 连接平滑生效
        if (server._sharedCreds) {
          server._sharedCreds.context = newContext.context;
        }
        logger.info('HTTPS SSL 证书上下文已成功热重载');
      } catch (e) {
        logger.error('HTTPS SSL 证书上下文热重载失败:', e.message);
      }
    };

    logger.info('已开启 HTTPS 原生加密安全传输');
  } catch (err) {
    logger.error('加载 SSL 证书失败，降级为 HTTP 模式:', err.message);
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

// 定时任务：证书自动更新检查（每天检查一次）
const certCheckInterval = 24 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    const certInfo = getCertificateInfo();
    if (certInfo.exists && certInfo.autoRenew && certInfo.type === 'acme' && certInfo.daysRemaining <= 30 && certInfo.domain) {
      logger.info(`证书到期剩余 ${certInfo.daysRemaining} 天，触发 acme.sh 自动续期...`);
      await issueAcmeCert(certInfo.domain);
      if (server && server.reloadSSLContext) {
        server.reloadSSLContext();
      }
    }
  } catch (err) {
    logger.error('定时自动续期证书失败:', err.message);
  }
}, certCheckInterval);

// 导出 server 实例供管理路由重载 SSL 使用
export { server };

server.listen(config.server.port, config.server.host, () => {
  const protocol = useSSL ? 'https' : 'http';
  logger.info(`服务器已启动 (${protocol.toUpperCase()}): ${protocol}://${config.server.host}:${config.server.port}`);

  // 启动时检查版本更新
  checkAndUpdateVersion();

  // 初始化 WebSocket 日志服务
  logWsServer.initialize(server);
  logWsServer.updateConfig({
    logMaxSizeMB: config.log?.maxSizeMB,
    logMaxFiles: config.log?.maxFiles,
    logMaxMemory: config.log?.maxMemory
  });
  logger.info('WebSocket 日志服务已启动: /ws/logs');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.server.port} 已被占用`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    logger.error(`端口 ${config.server.port} 无权限访问`);
    process.exit(1);
  } else {
    logger.error('服务器启动失败:', error.message);
    process.exit(1);
  }
});

// 处理客户端 Socket 异常，安全销毁连接，防止 Node.js 触发 Warning: An error event has already been emitted on the socket
server.on('clientError', (err, socket) => {
  if (err.code === 'ECONNRESET' || !socket.writable) {
    socket.destroy();
    return;
  }
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  } catch {
    socket.destroy();
  }
});

// ==================== 优雅关闭 ====================
const shutdown = () => {
  logger.info('正在关闭服务器...');

  // 停止内存管理器
  memoryManager.stop();
  logger.info('已停止内存管理器');

  // 关闭子进程请求器
  requesterManager.close();
  logger.info('已关闭子进程请求器');

  // 清理对象池
  clearChunkPool();
  logger.info('已清理对象池');

  // 关闭 WebSocket 日志服务
  logWsServer.close();
  logger.info('已关闭 WebSocket 日志服务');

  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });

  // 5秒超时强制退出
  setTimeout(() => {
    logger.warn('服务器关闭超时，强制退出');
    process.exit(0);
  }, 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ==================== 异常处理 ====================
process.on('uncaughtException', (error) => {
  logger.error('未捕获异常:', error.message);
  // 不立即退出，让当前请求完成
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的 Promise 拒绝:', reason);
});
