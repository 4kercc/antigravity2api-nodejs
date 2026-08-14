/**
 * Gemini CLI API 路由
 * 处理多种格式的端点：
 * - /cli/v1/chat/completions (OpenAI 格式)
 * - /cli/v1beta/models/:model:generateContent (Gemini 格式)
 * - /cli/v1beta/models/:model:streamGenerateContent (Gemini 流式格式)
 * - /cli/v1/messages (Claude 格式)
 *
 * 这是 Gemini CLI 反代的入口，支持 OpenAI/Gemini/Claude 兼容的 API 格式
 */

import { Router } from 'express';
import { handleGeminiCliRequest } from '../server/handlers/geminicli.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';

const router = Router();

/**
 * 中间件：检查 Gemini CLI 功能是否启用
 */
const checkGeminiCliEnabled = (req, res, next) => {
  if (config.geminicli?.enabled === false) {
    return res.status(503).json({
      error: {
        message: 'Gemini CLI 功能未启用',
        type: 'service_unavailable',
        code: 'geminicli_disabled'
      }
    });
  }
  next();
};

// 应用中间件到所有路由
router.use(checkGeminiCliEnabled);

/**
 * 生成 Gemini CLI 可用模型列表
 * 与 gcli2api 项目保持一致
 */
function getGeminiCliModels() {
  const baseModels = [
    'gemini-3.7-flash',
    'gemini-3.7-flash-tiered',
    'gemini-3.7-flash-high',
    'gemini-3.7-flash-medium',
    'gemini-3.7-flash-low',
    'gemini-3.7-flash-lite',
    'gemini-3.7-pro',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-3-pro-preview',
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview'
  ];
  
  const models = [];
  const featurePrefixes = ['', '假流式/', '流式抗截断/'];
  const thinkingSuffixes = ['', '-maxthinking', '-nothinking'];
  const searchSuffix = '-search';
  
  for (const baseModel of baseModels) {
    for (const prefix of featurePrefixes) {
      // 基础模型
      models.push(`${prefix}${baseModel}`);
      
      // 带 thinking 后缀
      for (const thinkingSuffix of thinkingSuffixes) {
        if (thinkingSuffix) {
          models.push(`${prefix}${baseModel}${thinkingSuffix}`);
        }
      }
      
      // 带 search 后缀
      models.push(`${prefix}${baseModel}${searchSuffix}`);
      
      // 带 thinking + search 组合后缀
      for (const thinkingSuffix of thinkingSuffixes) {
        if (thinkingSuffix) {
          models.push(`${prefix}${baseModel}${thinkingSuffix}${searchSuffix}`);
        }
      }
    }
  }
  
  return models;
}

/**
 * 返回模型列表（OpenAI 格式）
 */
function handleModelsRequestOpenAI(req, res) {
  try {
    const created = Math.floor(Date.now() / 1000);
    const models = getGeminiCliModels();

    const modelList = {
      object: 'list',
      data: models.map(id => ({
        id,
        object: 'model',
        created,
        owned_by: 'google'
      }))
    };

    res.json(modelList);
  } catch (error) {
    logger.error('[GeminiCLI] 获取模型列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
}

/**
 * 返回模型列表（Gemini 格式）
 */
function handleModelsRequestGemini(req, res) {
  try {
    const models = getGeminiCliModels();

    const modelList = {
      models: models.map(id => ({
        name: `models/${id}`,
        version: '001',
        displayName: id,
        description: 'GeminiCLI model',
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        supportedGenerationMethods: ['generateContent', 'countTokens'],
        temperature: 1.0,
        topP: 0.95,
        topK: 40
      }))
    };

    res.json(modelList);
  } catch (error) {
    logger.error('[GeminiCLI] 获取模型列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
}

/**
 * GET /cli/v1/models
 * 获取可用模型列表（OpenAI 格式）
 */
router.get('/v1/models', handleModelsRequestOpenAI);

/**
 * GET /cli/v1beta/models
 * 获取可用模型列表（Gemini 格式）
 */
router.get('/v1beta/models', handleModelsRequestGemini);

/**
 * POST /cli/v1/chat/completions
 * 处理 OpenAI 格式的聊天补全请求
 */
router.post('/v1/chat/completions', (req, res) => handleGeminiCliRequest(req, res, 'openai'));

// ==================== Gemini 格式端点 ====================

/**
 * POST /cli/v1beta/models/:model:generateContent
 * 处理 Gemini 格式的非流式请求
 * 使用正则表达式以支持模型名称中包含 / 的情况（如 "假流式/gemini-2.5-pro"）
 */
router.post(/^\/v1beta\/models\/(.+):generateContent$/, (req, res) => {
  // 将模型名称添加到请求体（解码 URL 编码的字符）
  req.body.model = decodeURIComponent(req.params[0]);
  handleGeminiCliRequest(req, res, 'gemini');
});

/**
 * POST /cli/v1beta/models/:model:streamGenerateContent
 * 处理 Gemini 格式的流式请求
 * 使用正则表达式以支持模型名称中包含 / 的情况（如 "假流式/gemini-2.5-pro"）
 */
router.post(/^\/v1beta\/models\/(.+):streamGenerateContent$/, (req, res) => {
  // 将模型名称添加到请求体，并标记为流式（解码 URL 编码的字符）
  req.body.model = decodeURIComponent(req.params[0]);
  req.body._isStream = true; // 内部标记
  handleGeminiCliRequest(req, res, 'gemini');
});

// ==================== Claude 格式端点 ====================

/**
 * POST /cli/v1/messages
 * 处理 Claude 格式的消息请求
 */
router.post('/v1/messages', (req, res) => handleGeminiCliRequest(req, res, 'claude'));

// ==================== 健康检查 ====================

/**
 * GET /cli/health
 * 健康检查端点
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'geminicli',
    enabled: config.geminicli?.enabled !== false,
    supportedFormats: ['openai', 'gemini', 'claude']
  });
});

export default router;