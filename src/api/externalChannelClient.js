/**
/**
 * 外部上游渠道请求客户端
 * 支持将 OpenAI / Gemini / Claude 请求代理转发至第三方兼容服务 (如 AIStudioToAPI, OneAPI, NewAPI 等)
 */

import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import config from '../config/config.js';
import logger from '../utils/logger.js';

function getAxiosClient(targetUrl = '') {
  const clientConfig = {
    timeout: config.timeout || 120000,
  };

  // 判断是否为本地内网/Docker 回环地址 (如 localhost, 127.0.0.1, 192.168.x, 10.x 等)
  let isLocalAddress = false;
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.')) {
      isLocalAddress = true;
    }
  } catch {}

  // 只有当目标不是本地内网回环地址，且配置了 SOCKS 代理时，才走 WARP/SOCKS 代理；本地 Docker 端点直连不走 SOCKS 代理
  if (!isLocalAddress && config.proxy && typeof config.proxy === 'string') {
    if (config.proxy.startsWith('socks')) {
      const agent = new SocksProxyAgent(config.proxy);
      clientConfig.httpAgent = agent;
      clientConfig.httpsAgent = agent;
    }
  } else {
    clientConfig.proxy = false;
  }

  return axios.create(clientConfig);
}

/**
 * 转发 OpenAI 兼容请求至外部渠道（支持流式与非流式）
 */
export async function forwardToExternalOpenAIChannel(channel, payload, stream = false, onData = null) {
  const url = `${channel.baseUrl}/chat/completions`;
  const client = getAxiosClient(url);
  
  const headers = {
    'Content-Type': 'application/json'
  };
  if (channel.apiKey) {
    headers['Authorization'] = `Bearer ${channel.apiKey}`;
  }

  // 深度清洗 payload，剔除 Google Antigravity 私有非标字段，保留标准 OpenAI 参数
  const cleanPayload = {
    model: payload.model,
    messages: payload.messages,
    stream: stream ? true : false
  };

  if (payload.temperature !== undefined) cleanPayload.temperature = payload.temperature;
  if (payload.top_p !== undefined) cleanPayload.top_p = payload.top_p;
  if (payload.max_tokens !== undefined) cleanPayload.max_tokens = payload.max_tokens;
  if (payload.tools !== undefined) cleanPayload.tools = payload.tools;
  if (payload.tool_choice !== undefined) cleanPayload.tool_choice = payload.tool_choice;
  if (payload.response_format !== undefined) cleanPayload.response_format = payload.response_format;

  if (stream) {
    const response = await client.post(url, cleanPayload, {
      headers,
      responseType: 'stream'
    });

    let buffer = '';
    let totalUsage = null;

    return new Promise((resolve, reject) => {
      response.data.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留未完整的行

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.replace(/^data:\s*/, '').trim();
          if (dataStr === '[DONE]') {
            continue;
          }

          try {
            const parsed = JSON.parse(dataStr);
            const choice = parsed.choices?.[0];
            const delta = choice?.delta;

            if (parsed.usage) {
              totalUsage = parsed.usage;
              if (onData) onData({ type: 'usage', usage: parsed.usage });
            }

            if (delta) {
              if (delta.reasoning_content || delta.thinking) {
                if (onData) onData({
                  type: 'reasoning',
                  reasoning_content: delta.reasoning_content || delta.thinking
                });
              }
              if (delta.content) {
                if (onData) onData({
                  type: 'content',
                  content: delta.content
                });
              }
              if (delta.tool_calls) {
                if (onData) onData({
                  type: 'tool_calls',
                  tool_calls: delta.tool_calls
                });
              }
            }
          } catch (e) {
            // 忽略非 JSON 行
          }
        }
      });

      response.data.on('end', () => {
        resolve({ usage: totalUsage });
      });

      response.data.on('error', (err) => {
        logger.error(`外部渠道 [${channel.name}] 流式响应异常:`, err.message);
        reject(err);
      });
    });
  } else {
    // 非流式请求
    const response = await client.post(url, cleanPayload, { headers });
    const data = response.data;
    const choice = data.choices?.[0];
    const message = choice?.message || {};

    return {
      content: message.content || '',
      reasoning: message.reasoning_content || message.thinking || null,
      toolCalls: message.tool_calls || null,
      usage: data.usage || null
    };
  }
}

/**
 * 在线测试外部渠道的连通性与延迟
 */
export async function testExternalChannel(channel, customModel = null) {
  const testModel = customModel || (channel.models && channel.models.length > 0 && channel.models[0] !== '*' 
    ? channel.models[0] 
    : 'gemini-2.5-flash');

  const url = `${channel.baseUrl}/chat/completions`;
  const client = getAxiosClient(url);
  const startTime = Date.now();
  const headers = { 'Content-Type': 'application/json' };
  if (channel.apiKey) {
    headers['Authorization'] = `Bearer ${channel.apiKey}`;
  }

  const payload = {
    model: testModel,
    messages: [{ role: 'user', content: 'Hi, please respond with OK.' }],
    max_tokens: 10
  };

  const response = await client.post(url, payload, { headers, timeout: 15000 });
  const latency = Date.now() - startTime;

  return {
    success: true,
    status: response.status,
    latencyMs: latency,
    modelTested: testModel,
    responseSnippet: response.data?.choices?.[0]?.message?.content || 'OK'
  };
}
