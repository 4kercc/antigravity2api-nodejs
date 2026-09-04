/**
 * OpenAI 格式处理器
 * 处理 /v1/chat/completions 请求，支持流式和非流式响应
 */

import { generateAssistantResponse, generateAssistantResponseNoStream, getModelsWithQuotas } from '../../api/client.js';
import { forwardToExternalOpenAIChannel } from '../../api/externalChannelClient.js';
import channelManager from '../../utils/channelManager.js';
import { generateRequestBody, prepareImageRequest } from '../../utils/utils.js';
import { buildOpenAIErrorPayload } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';
import tokenManager from '../../auth/token_manager.js';
import quotaManager from '../../auth/quota_manager.js';
import {
  createOpenAIStreamChunk as createStreamChunk,
  createOpenAIChatCompletionResponse
} from '../formatters/openai.js';
import { validateIncomingChatRequest } from '../validators/chat.js';
import { getSafeRetries } from './common/retry.js';
import {
  createResponseMeta,
  setStreamHeaders,
  createHeartbeat,
  writeStreamData,
  endStream,
  with429Retry
} from '../stream.js';

/**
 * 处理 OpenAI 格式的聊天请求
 * @param {Request} req - Express请求对象
 * @param {Response} res - Express响应对象
 */
export const handleOpenAIRequest = async (req, res) => {
  const body = req.body || {};
  const { messages, model, stream = false, tools, ...params } = body;

  try {
    const validation = validateIncomingChatRequest('openai', body);
    if (!validation.ok) {
      return res.status(validation.status).json({ error: validation.message });
    }
    if (typeof model !== 'string' || !model) {
      return res.status(400).json({ error: 'model is required' });
    }

    res.locals.model = model;

    const isImageModel = model.includes('-image');
    let token = null;
    let tokenId = null;
    let requestBody = null;

    const applyTokenState = async (nextToken) => {
      if (!nextToken) return false;

      token = nextToken;
      tokenId = await tokenManager.getTokenId(token);
      res.locals.accountInfo = token.email || token.projectId || (tokenId ? `token_${tokenId.substring(0, 8)}` : '原生账号');
      requestBody = generateRequestBody(messages, model, params, tools, token);
      if (isImageModel) {
        prepareImageRequest(requestBody);
      }
      return true;
    };

    const routingMode = config.channels?.routingMode || 'fallback';
    const externalChannel = res.locals.targetChannel || await channelManager.getChannel(model);

    // 辅助函数：通过外部渠道执行请求
    const executeViaExternalChannel = async (chan) => {
      const routeInfo = res.locals.pathPrefix ? `本地路径: ${res.locals.pathPrefix}` : `模式: ${routingMode}`;
      logger.info(`🔀 [外部渠道: ${chan.name}] 正在处理请求 (${model}) [${routeInfo}]`);
      res.locals.channelName = chan.name;
      res.locals.accountInfo = `渠道:${chan.name}`;
      const { id, created } = createResponseMeta();

      if (stream) {
        setStreamHeaders(res);
        const heartbeatTimer = createHeartbeat(res);
        try {
          let usageData = null;
          let contentSent = false;
          let finishReason = 'stop';

          await forwardToExternalOpenAIChannel(chan, body, true, (data) => {
            if (data.type === 'usage') {
              usageData = data.usage;
            } else if (data.type === 'reasoning') {
              writeStreamData(res, createStreamChunk(id, created, model, { reasoning_content: data.reasoning_content }));
            } else if (data.type === 'tool_calls') {
              finishReason = 'tool_calls';
              writeStreamData(res, createStreamChunk(id, created, model, { tool_calls: data.tool_calls }));
            } else if (data.type === 'content') {
              contentSent = true;
              writeStreamData(res, createStreamChunk(id, created, model, { content: data.content }));
            }
          });

          // 如果外部服务没按标准流式分块而是静默返回，或者流式结束，发送 stop chunk
          writeStreamData(res, { ...createStreamChunk(id, created, model, {}, finishReason), usage: usageData });
          if (usageData) {
            res.locals.tokenUsage = usageData;
            channelManager.recordUsage(chan.id, usageData).catch(() => {});
          } else {
            channelManager.recordUsage(chan.id, null).catch(() => {});
          }
          clearInterval(heartbeatTimer);
          return endStream(res);
        } catch (err) {
          clearInterval(heartbeatTimer);
          logger.error(`外部渠道 [${chan.name}] 处理请求失败:`, err.message);
          if (!res.headersSent) {
            return res.status(502).json({ error: `External channel error: ${err.message}` });
          } else {
            return endStream(res);
          }
        }
      } else {
        // 非流式
        try {
          const resp = await forwardToExternalOpenAIChannel(chan, body, false);
          if (resp.usage) {
            res.locals.tokenUsage = resp.usage;
            channelManager.recordUsage(chan.id, resp.usage).catch(() => {});
          } else {
            channelManager.recordUsage(chan.id, null).catch(() => {});
          }
          return res.json(createOpenAIChatCompletionResponse({
            id,
            created,
            model,
            content: resp.content,
            reasoningContent: resp.reasoning,
            toolCalls: resp.toolCalls,
            usage: resp.usage,
            passSignatureToClient: false,
            stripToolCallSignature: true
          }));
        } catch (err) {
          logger.error(`外部渠道 [${chan.name}] 处理非流式请求失败:`, err.message);
          if (!res.headersSent) {
            return res.status(502).json({ error: `External channel error: ${err.message}` });
          }
        }
      }
    };

    // 0. 若请求命中了指定的本地分流路径 (如 /v2, /v3 等)，直接精准走该外部渠道
    if (res.locals.targetChannel) {
      return await executeViaExternalChannel(res.locals.targetChannel);
    }

    if (res.locals.unmatchedPathPrefix) {
      return res.status(404).json({ error: `未找到绑定本地分流路径 [${res.locals.unmatchedPathPrefix}] 的可用外部渠道` });
    }

    // 1. 强制仅走外部渠道
    if (routingMode === 'external_only') {
      if (!externalChannel) {
        return res.status(503).json({ error: '当前配置为【仅使用外部渠道】，但未找到支持此模型的可用外部渠道' });
      }
      return await executeViaExternalChannel(externalChannel);
    }

    // 2. 外部渠道优先
    if (routingMode === 'external_first' && externalChannel) {
      return await executeViaExternalChannel(externalChannel);
    }

    // 3. 原生优先（fallback / 智能降级）
    const nativeToken = await tokenManager.getToken(model);
    const hasNativeToken = nativeToken && await applyTokenState(nativeToken);

    if (!hasNativeToken) {
      if (externalChannel) {
        return await executeViaExternalChannel(externalChannel);
      }
      throw new Error('没有可用的token，请运行 npm run login 获取token 或在设置中添加外部上游渠道');
    }

    const refreshQuota = async () => {
      if (!tokenId || !token) return;
      const quotas = await getModelsWithQuotas(token);
      quotaManager.updateQuota(tokenId, quotas);
    };

    // 创建 with429Retry 选项
    const createRetryOptions = (prefix) => ({
      loggerPrefix: prefix,
      onAttempt: () => tokenManager.recordRequest(token, model),
      getTokenId: () => tokenId,
      modelId: model,
      refreshQuota,
      tokenManager,
      getToken: () => token,
      onBeforeRetry: async ({ previousTokenId }) => {
        const nextToken = await tokenManager.getTokenForRetry(model, previousTokenId);
        return applyTokenState(nextToken);
      }
    });
    //console.log(JSON.stringify(requestBody,null,2));
    const { id, created } = createResponseMeta();
    const safeRetries = getSafeRetries(config.retryTimes);

    if (stream) {
      setStreamHeaders(res);

      // 启动心跳，防止 Cloudflare 超时断连
      const heartbeatTimer = createHeartbeat(res);

      try {
        if (isImageModel) {
          const { content, usage, reasoningSignature } = await with429Retry(
            (attempt, shouldUseCredits) => {
              const actualRequestBody = shouldUseCredits 
                ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
                : requestBody;
              return generateAssistantResponseNoStream(actualRequestBody, token);
            },
            safeRetries,
            createRetryOptions('chat.stream.image ')
          );
          const delta = { content };
          if (reasoningSignature && config.passSignatureToClient) {
            delta.thoughtSignature = reasoningSignature;
          }
          writeStreamData(res, createStreamChunk(id, created, model, delta));
          writeStreamData(res, { ...createStreamChunk(id, created, model, {}, 'stop'), usage });
          if (usage) res.locals.tokenUsage = usage;
        } else {
          let hasToolCall = false;
          let usageData = null;

          await with429Retry(
            (attempt, shouldUseCredits) => {
              const actualRequestBody = shouldUseCredits 
                ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
                : requestBody;
              return generateAssistantResponse(actualRequestBody, token, (data) => {
                if (data.type === 'usage') {
                  usageData = data.usage;
                } else if (data.type === 'reasoning') {
                  const delta = { reasoning_content: data.reasoning_content };
                  if (data.thoughtSignature && config.passSignatureToClient) {
                    delta.thoughtSignature = data.thoughtSignature;
                  }
                  writeStreamData(res, createStreamChunk(id, created, model, delta));
                } else if (data.type === 'tool_calls') {
                  hasToolCall = true;
                  // 根据配置决定是否透传工具调用中的签名
                  const toolCallsWithIndex = data.tool_calls.map((toolCall, index) => {
                    if (config.passSignatureToClient) {
                      return { index, ...toolCall };
                    } else {
                      const { thoughtSignature, ...rest } = toolCall;
                      return { index, ...rest };
                    }
                  });
                  const delta = { tool_calls: toolCallsWithIndex };
                  writeStreamData(res, createStreamChunk(id, created, model, delta));
                } else {
                  const delta = { content: data.content };
                  writeStreamData(res, createStreamChunk(id, created, model, delta));
                }
              });
            },
            safeRetries,
            createRetryOptions('chat.stream ')
          );

          writeStreamData(res, { ...createStreamChunk(id, created, model, {}, hasToolCall ? 'tool_calls' : 'stop'), usage: usageData });
          if (usageData) res.locals.tokenUsage = usageData;
        }

        clearInterval(heartbeatTimer);
        endStream(res);
      } catch (error) {
        clearInterval(heartbeatTimer);
        if (!res.writableEnded) {
          const statusCode = error.statusCode || error.status || 500;
          writeStreamData(res, buildOpenAIErrorPayload(error, statusCode));
          endStream(res);
        }
        logger.error('生成响应失败:', error.message);
        if (requestBody) {
          logger.error('【400 Debug】失败时发送给 Google 的完整 requestBody:');
          logger.error(JSON.stringify(requestBody, null, 2));
        }
        if (body) {
          logger.error('【400 Debug】客户端原始传入的 req.body:');
          logger.error(JSON.stringify(body, null, 2));
        }
        return;
      }
    } else if (config.fakeNonStream && !isImageModel) {
      // 假非流模式：使用流式API获取数据，组装成非流式响应
      req.setTimeout(0);
      res.setTimeout(0);

      let content = '';
      let reasoningContent = '';
      let reasoningSignature = null;
      const toolCalls = [];
      let usageData = null;

      try {
        await with429Retry(
          (attempt, shouldUseCredits) => {
            const actualRequestBody = shouldUseCredits 
              ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
              : requestBody;
            return generateAssistantResponse(actualRequestBody, token, (data) => {
              if (data.type === 'usage') {
                usageData = data.usage;
              } else if (data.type === 'reasoning') {
                reasoningContent += data.reasoning_content || '';
                if (data.thoughtSignature) {
                  reasoningSignature = data.thoughtSignature;
                }
              } else if (data.type === 'tool_calls') {
                toolCalls.push(...data.tool_calls);
              } else if (data.type === 'text') {
                content += data.content || '';
              }
            });
          },
          safeRetries,
          createRetryOptions('chat.fake_no_stream ')
        );

        // 构建非流式响应
        const message = { role: 'assistant' };
        if (reasoningContent) message.reasoning_content = reasoningContent;
        if (reasoningSignature && config.passSignatureToClient) message.thoughtSignature = reasoningSignature;
        message.content = content;

        if (toolCalls.length > 0) {
          if (config.passSignatureToClient) {
            message.tool_calls = toolCalls;
          } else {
            message.tool_calls = toolCalls.map(({ thoughtSignature, ...rest }) => rest);
          }
        }

        if (usageData) res.locals.tokenUsage = usageData;
        res.json(createOpenAIChatCompletionResponse({
          id,
          created,
          model,
          content,
          reasoningContent,
          reasoningSignature,
          toolCalls,
          usage: usageData,
          passSignatureToClient: config.passSignatureToClient,
          stripToolCallSignature: !config.passSignatureToClient
        }));
      } catch (error) {
        logger.error('假非流生成响应失败:', error.message);
        if (res.headersSent) return;
        const statusCode = error.statusCode || error.status || 500;
        return res.status(statusCode).json(buildOpenAIErrorPayload(error, statusCode));
      }
    } else {
      // 非流式请求：设置较长超时，避免大模型响应超时
      req.setTimeout(0); // 禁用请求超时
      res.setTimeout(0); // 禁用响应超时

      const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
        (attempt, shouldUseCredits) => {
          const actualRequestBody = shouldUseCredits 
            ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
            : requestBody;
          return generateAssistantResponseNoStream(actualRequestBody, token);
        },
        safeRetries,
        createRetryOptions('chat.no_stream ')
      );

      // DeepSeek 格式：reasoning_content 在 content 之前
      const message = { role: 'assistant' };
      if (reasoningContent) message.reasoning_content = reasoningContent;
      if (reasoningSignature && config.passSignatureToClient) message.thoughtSignature = reasoningSignature;
      message.content = content;

      if (toolCalls.length > 0) {
        // 根据配置决定是否透传工具调用中的签名
        if (config.passSignatureToClient) {
          message.tool_calls = toolCalls;
        } else {
          message.tool_calls = toolCalls.map(({ thoughtSignature, ...rest }) => rest);
        }
      }

      if (usage) res.locals.tokenUsage = usage;

      // 使用预构建的响应对象，减少内存分配
      res.json(createOpenAIChatCompletionResponse({
        id,
        created,
        model,
        content,
        reasoningContent,
        reasoningSignature,
        toolCalls,
        usage,
        passSignatureToClient: config.passSignatureToClient,
        stripToolCallSignature: !config.passSignatureToClient
      }));
    }
  } catch (error) {
    logger.error('生成响应失败:', error.message);
    if (requestBody) {
      logger.error('【400 Debug】失败时发送给 Google 的完整 requestBody:');
      logger.error(JSON.stringify(requestBody, null, 2));
    }
    if (body) {
      logger.error('【400 Debug】客户端原始传入的 req.body:');
      logger.error(JSON.stringify(body, null, 2));
    }
    if (res.headersSent) return;
    const statusCode = error.statusCode || error.status || 500;
    return res.status(statusCode).json(buildOpenAIErrorPayload(error, statusCode));
  }
};
