// OpenAI 格式转换工具
import config from '../../config/config.js';
import { extractSystemInstruction } from '../utils.js';
import { convertOpenAIToolsToAntigravity } from '../toolConverter.js';
import {
  getSignatureContext,
  pushUserMessage,
  findFunctionNameById,
  pushFunctionResponse,
  createThoughtPart,
  createFunctionCallPart,
  processToolName,
  pushModelMessage,
  buildRequestBody,
  modelMapping,
  isEnableThinking,
  generateGenerationConfig
} from './common.js';

function extractImagesFromContent(content) {
  const result = { text: '', images: [] };
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text;
      } else if (item.type === 'image_url') {
        const imageUrl = item.image_url?.url || '';
        const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          result.images.push({
            inlineData: {
              mimeType: `image/${match[1]}`,
              data: match[2]
            }
          });
        }
      }
    }
  }
  return result;
}

function handleAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId, hasTools) {
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const hasContent = message.content && message.content.trim() !== '';
  const { reasoningSignature, reasoningContent, toolSignature, toolContent } = getSignatureContext(sessionId, actualModelName, hasTools);
  
  const toolCalls = hasToolCalls
    ? message.tool_calls.map(toolCall => {
      const safeName = processToolName(toolCall.function.name, sessionId, actualModelName);
      const signature = enableThinking
        ? (toolCall.thoughtSignature || toolSignature || message.thoughtSignature || reasoningSignature)
        : null;
      return createFunctionCallPart(toolCall.id, safeName, toolCall.function.arguments, signature);
    })
    : [];

  const parts = [];
  if (enableThinking) {
    // 优先使用消息自带的思考内容，否则使用缓存的内容（与签名绑定）
    let reasoningText = ' ';
    let signature = null;
    
    if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
      // 消息自带思考内容，使用消息自带的签名或缓存签名
      reasoningText = message.reasoning_content;
      signature = message.thoughtSignature || reasoningSignature || toolSignature;
    } else {
      // 没有思考内容，使用缓存的签名+内容（绑定关系）
      signature = message.thoughtSignature || reasoningSignature || toolSignature;
      if (signature === reasoningSignature) {
        reasoningText = reasoningContent || ' ';
      } else if (signature === toolSignature) {
        reasoningText = toolContent || ' ';
      }
    }
    
    // 只有在有签名时才添加 thought part，避免 API 报错
    if (signature) {
      parts.push(createThoughtPart(reasoningText, signature));
    }
  }
  if (hasContent) {
    const part = { text: message.content.trimEnd() };
    parts.push(part);
  }
  if (!enableThinking && parts[0]) delete parts[0].thoughtSignature;

  pushModelMessage({ parts, toolCalls, hasContent }, antigravityMessages);
}

function handleToolCall(message, antigravityMessages) {
  const functionName = findFunctionNameById(message.tool_call_id, antigravityMessages);
  pushFunctionResponse(message.tool_call_id, functionName, message.content, antigravityMessages);
}

function openaiMessageToAntigravity(openaiMessages, enableThinking, actualModelName, sessionId, hasTools) {
  const antigravityMessages = [];
  for (const message of openaiMessages) {
    if (message.role === 'user' || message.role === 'system') {
      const extracted = extractImagesFromContent(message.content);
      pushUserMessage(extracted, antigravityMessages);
    } else if (message.role === 'assistant') {
      handleAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId, hasTools);
    } else if (message.role === 'tool') {
      handleToolCall(message, antigravityMessages);
    }
  }
  //console.log(JSON.stringify(antigravityMessages,null,2));
  return antigravityMessages;
}

export function generateRequestBody(openaiMessages, modelName, parameters, openaiTools, token) {
  const enableThinking = isEnableThinking(modelName);
  const actualModelName = modelMapping(modelName);
  const mergedSystemInstruction = extractSystemInstruction(openaiMessages);

  let filteredMessages = openaiMessages;
  let startIndex = 0;
  if (config.useContextSystemPrompt) {
    for (let i = 0; i < openaiMessages.length; i++) {
      if (openaiMessages[i].role === 'system') {
        startIndex = i + 1;
      } else {
        filteredMessages = openaiMessages.slice(startIndex);
        break;
      }
    }
  }

  const tools = convertOpenAIToolsToAntigravity(openaiTools, token.sessionId, actualModelName);
  const hasTools = tools && tools.length > 0;
  //console.log(JSON.stringify(tools, null, 2))
  return buildRequestBody({
    contents: openaiMessageToAntigravity(filteredMessages, enableThinking, actualModelName, token.sessionId, hasTools),
    tools: tools,
    generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName, modelName),
    sessionId: token.sessionId,
    systemInstruction: mergedSystemInstruction
  }, token, actualModelName);
}
