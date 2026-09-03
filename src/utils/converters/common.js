// 转换器公共模块
import config from '../../config/config.js';
import { generateRequestId } from '../idGenerator.js';
import { getSignature, shouldCacheSignature, isImageModel } from '../thoughtSignatureCache.js';
import { setToolNameMapping } from '../toolNameCache.js';
import { getThoughtSignatureForModel, getToolSignatureForModel, sanitizeToolName, modelMapping, isEnableThinking, generateGenerationConfig } from '../utils.js';

/**
 * 获取签名上下文
 * @param {string} sessionId - 会话 ID
 * @param {string} actualModelName - 实际模型名称
 * @param {boolean} hasTools - 请求中是否包含工具定义
 * @returns {Object} 包含思维签名、思考内容和工具签名的对象
 */
export function getSignatureContext(sessionId, actualModelName, hasTools = false) {
  const isImage = isImageModel(actualModelName);

  // 判断是否应该从缓存获取签名
  const shouldGetCached = shouldCacheSignature({ hasTools, isImageModel: isImage });

  // 从缓存获取签名+内容对象（现在返回 { signature, content } 或 null）
  const cachedEntry = shouldGetCached ? getSignature(sessionId, actualModelName, { hasTools }) : null;

  // 构建返回值：优先使用缓存（包含签名+内容），回退到兜底签名（仅签名，无内容）
  let reasoningSignature = null;
  let reasoningContent = ' ';
  let toolSignature = null;
  let toolContent = ' ';

  if (cachedEntry) {
    // 统一缓存：同时用于 reasoning 和 tool
    reasoningSignature = cachedEntry.signature;
    reasoningContent = cachedEntry.content || ' ';
    toolSignature = cachedEntry.signature;
    toolContent = cachedEntry.content || ' ';
  } else if (config.useFallbackSignature) {
    // 兜底签名
    reasoningSignature = getThoughtSignatureForModel(actualModelName);
    reasoningContent = config.cacheThinking ? ' ' : ' '; // 兜底签名没有对应内容

    if (hasTools) {
      toolSignature = getToolSignatureForModel(actualModelName);
      toolContent = ' ';
    }
  }

  return {
    reasoningSignature,
    reasoningContent,
    toolSignature,
    toolContent
  };
}

/**
 * 添加用户消息到 antigravityMessages
 * @param {Object} extracted - 提取的内容 { text, images }
 * @param {Array} antigravityMessages - 目标消息数组
 */
export function pushUserMessage(extracted, antigravityMessages) {
  antigravityMessages.push({
    role: 'user',
    parts: [{ text: extracted?.text || ' ' }, ...extracted.images]
  });
}

/**
 * 根据工具调用 ID 查找函数名
 * @param {string} toolCallId - 工具调用 ID
 * @param {Array} antigravityMessages - 消息数组
 * @returns {string} 函数名
 */
export function findFunctionNameById(toolCallId, antigravityMessages) {
  for (let i = antigravityMessages.length - 1; i >= 0; i--) {
    if (antigravityMessages[i].role === 'model') {
      const parts = antigravityMessages[i].parts;
      for (const part of parts) {
        if (part.functionCall && part.functionCall.id === toolCallId) {
          return part.functionCall.name;
        }
      }
    }
  }
  return '';
}

/**
 * 添加函数响应到 antigravityMessages
 * @param {string} toolCallId - 工具调用 ID
 * @param {string} functionName - 函数名
 * @param {string} resultContent - 响应内容
 * @param {Array} antigravityMessages - 目标消息数组
 */
export function pushFunctionResponse(toolCallId, functionName, resultContent, antigravityMessages) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  let outputValue = resultContent ?? '';
  if (typeof outputValue === 'object') {
    outputValue = JSON.stringify(outputValue);
  }
  const functionResponse = {
    functionResponse: {
      id: toolCallId,
      name: functionName || 'function',
      response: { output: outputValue }
    }
  };

  if (lastMessage?.role === 'user' && lastMessage.parts.some(p => p.functionResponse)) {
    lastMessage.parts.push(functionResponse);
  } else {
    antigravityMessages.push({ role: 'user', parts: [functionResponse] });
  }
}

/**
 * 创建带签名的思维 part
 * @param {string} text - 思维文本
 * @param {string} signature - 签名
 * @returns {Object} 思维 part
 */
export function createThoughtPart(text, signature = null) {
  const part = { text: text || ' ', thought: true };
  if (signature) part.thoughtSignature = signature;
  return part;
}

/**
 * 创建带签名的函数调用 part
 * @param {string} id - 调用 ID
 * @param {string} name - 函数名（已清理）
 * @param {Object|string} args - 参数
 * @param {string} signature - 签名（可选）
 * @returns {Object} 函数调用 part
 */
export function createFunctionCallPart(id, name, args, signature = null) {
  let parsedArgs = {};
  if (typeof args === 'string') {
    try {
      parsedArgs = args.trim() ? JSON.parse(args) : {};
    } catch {
      parsedArgs = { raw_args: args };
    }
  } else if (args && typeof args === 'object') {
    parsedArgs = args;
  }

  const part = {
    functionCall: {
      id,
      name,
      args: parsedArgs
    }
  };
  if (signature) {
    part.thoughtSignature = signature;
  }
  return part;
}

/**
 * 处理工具名称映射
 * @param {string} originalName - 原始名称
 * @param {string} sessionId - 会话 ID
 * @param {string} actualModelName - 实际模型名称
 * @returns {string} 清理后的安全名称
 */
export function processToolName(originalName, sessionId, actualModelName) {
  const safeName = sanitizeToolName(originalName);
  if (actualModelName && safeName !== originalName) {
    setToolNameMapping(actualModelName, safeName, originalName);
  }
  return safeName;
}

/**
 * 添加模型消息到 antigravityMessages
 * @param {Object} options - 选项
 * @param {Array} options.parts - 消息 parts
 * @param {Array} options.toolCalls - 工具调用 parts
 * @param {boolean} options.hasContent - 是否有文本内容
 * @param {Array} antigravityMessages - 目标消息数组
 */
export function pushModelMessage({ parts, toolCalls, hasContent }, antigravityMessages) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = toolCalls && toolCalls.length > 0;

  if (lastMessage?.role === 'model' && hasToolCalls && !hasContent) {
    lastMessage.parts.push(...toolCalls);
  } else {
    const allParts = [...parts, ...(toolCalls || [])];
    antigravityMessages.push({ role: 'model', parts: allParts });
  }
  //console.log(JSON.stringify(antigravityMessages,null,2));
}

/**
 * 构建基础请求体
 * @param {Object} options - 选项
 * @param {Array} options.contents - 消息内容
 * @param {Array} options.tools - 工具列表
 * @param {Object} options.generationConfig - 生成配置
 * @param {string} options.sessionId - 会话 ID
 * @param {string} options.systemInstruction - 系统指令
 * @param {boolean} options.useCredits - 是否使用积分（可选，用于重试时强制使用积分）
 * @param {Object} token - Token 对象
 * @param {string} actualModelName - 实际模型名称
 * @returns {Object} 请求体
 */
export function buildRequestBody({ contents, tools, generationConfig, sessionId, systemInstruction, useCredits }, token, actualModelName) {
  const hasTools = tools && tools.length > 0;

  const requestBody = {
    project: token.projectId,
    requestId: generateRequestId(),
    request: {
      contents,
      generationConfig,
      sessionId
    },
    model: actualModelName,
    userAgent: 'antigravity',
    requestType: 'agent'
  };

  // 只在有工具时才添加 tools 和 toolConfig 字段
  if (hasTools) {
    requestBody.request.tools = tools;
    requestBody.request.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
  }

  // 构建系统提示词
  const systemInstructionObj = buildSystemInstruction(systemInstruction);
  if (systemInstructionObj) {
    requestBody.request.systemInstruction = systemInstructionObj;
  }

  // 积分使用逻辑：如果配置了 alwaysUseCredits 或者显式传入 useCredits 参数，则注入积分字段
  if (config.alwaysUseCredits || useCredits === true) {
    requestBody.enabledCreditTypes = ["GOOGLE_ONE_AI"];
  }

  return requestBody;
}

/**
 * 清理 system instruction part，移除 Gemini API 不支持的字段
 * @param {Object} part - 原始 part 对象
 * @returns {Object} 清理后的 part 对象（仅保留 text、inlineData 等 Gemini 支持的字段）
 */
function cleanSystemPart(part) {
  if (!part || typeof part !== 'object') return part;

  const cleanedPart = {};

  // 只保留 Gemini API 支持的 part 字段
  if (part.text !== undefined) {
    cleanedPart.text = part.text;
  }
  if (part.inlineData !== undefined) {
    cleanedPart.inlineData = part.inlineData;
  }
  if (part.fileData !== undefined) {
    cleanedPart.fileData = part.fileData;
  }

  // 返回清理后的 part，如果没有有效内容则返回 null
  return Object.keys(cleanedPart).length > 0 ? cleanedPart : null;
}

/**
 * 构建系统提示词 parts 数组
 *
 * 逻辑说明：
 * 1. 官方提示词：反重力官方要求的提示词，可在前端编辑
 * 2. 反代提示词：反代自带的提示词（如萌萌），可在前端编辑
 * 3. 用户请求提示词：用户在 API 请求中传入的 system 消息
 *
 * 配置选项：
 * - useContextSystemPrompt: 开启后，将用户请求的 system 追加到反代提示词后面
 * - mergeSystemPrompt: 开启后，将所有提示词合并为单个 part（需要先开启 useContextSystemPrompt）
 * - officialPromptPosition: 官方提示词位置，'before' = 在反代提示词前面，'after' = 在反代提示词后面
 *
 * @param {string|Array} userSystemPrompt - 用户请求中的系统提示词（字符串或 parts 数组）
 * @returns {Array} 系统提示词 parts 数组
 */
export function buildSystemPromptParts(userSystemPrompt) {
  const parts = [];

  // 获取各层提示词（config.js 已处理默认值，直接使用）
  const officialPrompt = config.officialSystemPrompt;
  const proxyPrompt = config.systemInstruction;

  // 处理用户提示词：可能是字符串或 parts 数组
  let userParts = [];
  if (userSystemPrompt) {
    if (typeof userSystemPrompt === 'string' && userSystemPrompt.trim()) {
      userParts = [{ text: userSystemPrompt.trim() }];
    } else if (Array.isArray(userSystemPrompt)) {
      // 清理每个 part，移除 Gemini API 不支持的字段（如 type、cache_control）
      userParts = userSystemPrompt
        .map(p => cleanSystemPart(p))
        .filter(p => p !== null);
    } else if (typeof userSystemPrompt === 'object' && userSystemPrompt.parts) {
      // 处理 { role: 'user', parts: [...] } 格式
      userParts = userSystemPrompt.parts
        .map(p => cleanSystemPart(p))
        .filter(p => p !== null);
    }
  }

  // 构建反代提示词部分（可能包含用户请求的 system）
  const proxyParts = [];
  if (proxyPrompt.trim()) {
    proxyParts.push({ text: proxyPrompt.trim() });
  }

  // 如果开启上下文 System，将用户请求的 system 追加到反代提示词后面
  if (config.useContextSystemPrompt && userParts.length > 0) {
    proxyParts.push(...userParts);
  }

  // 根据官方提示词位置配置，组合最终的 parts 数组
  if (config.officialPromptPosition === 'before') {
    // 官方提示词在前
    if (officialPrompt.trim()) {
      parts.push({ text: officialPrompt.trim() });
    }
    parts.push(...proxyParts);
  } else {
    // 官方提示词在后
    parts.push(...proxyParts);
    if (officialPrompt.trim()) {
      parts.push({ text: officialPrompt.trim() });
    }
  }

  return parts;
}

/**
 * 构建系统提示词（合并为单个字符串或保留多 part 结构）
 * @param {string|Array} userSystemPrompt - 用户请求中的系统提示词
 * @returns {Object} { text: string } 或 { parts: Array }
 */
export function buildSystemInstruction(userSystemPrompt) {
  const parts = buildSystemPromptParts(userSystemPrompt);

  if (parts.length === 0) {
    return null;
  }

  if (config.mergeSystemPrompt) {
    // 合并为单个字符串
    const mergedText = parts
      .map(p => p.text || '')
      .filter(t => t.trim())
      .join('\n\n');
    return {
      role: 'user',
      parts: [{ text: mergedText }]
    };
  } else {
    // 保留多 part 结构
    return {
      role: 'user',
      parts: parts
    };
  }
}

/**
 * 合并系统指令（兼容旧接口）
 * @param {string} baseSystem - 基础系统指令（萌萌提示词）
 * @param {string} contextSystem - 上下文系统指令（用户请求中的提示词）
 * @returns {string} 合并后的系统指令
 */
export function mergeSystemInstruction(baseSystem, contextSystem) {
  // 使用新的构建函数
  const result = buildSystemInstruction(contextSystem);

  if (!result) {
    return baseSystem || '';
  }

  // 返回合并后的文本
  if (result.parts && result.parts.length > 0) {
    return result.parts.map(p => p.text || '').filter(t => t.trim()).join('\n\n');
  }

  return baseSystem || '';
}

// 重导出常用函数
export { sanitizeToolName, modelMapping, isEnableThinking, generateGenerationConfig };

// 重导出参数规范化函数
export {
  normalizeOpenAIParameters,
  normalizeClaudeParameters,
  normalizeGeminiParameters,
  normalizeParameters,
  toGenerationConfig
} from '../parameterNormalizer.js';
