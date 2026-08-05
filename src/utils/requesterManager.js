import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import axios from 'axios';
import fingerprintRequester from '../requester.js';
import config from '../config/config.js';
import logger from './logger.js';
import { buildAxiosRequestConfig } from './httpClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 统一请求器管理类
 *
 * - 根据 config.useNativeAxios 决定使用 TLS 指纹请求器还是 axios
 * - 支持热重载：调用 reload() 后下次请求时重新初始化
 * - TLS 请求器初始化失败时自动降级到 axios
 * - sendLog 等需要发送二进制 body 的场景，请直接使用 axios（TLS 请求器暂不支持二进制 body）
 */
class RequesterManager {
  constructor() {
    this._tlsRequester = null;
    this._tlsInitFailed = false;
    this._initPromise = null;
  }

  // ==================== 初始化 ====================

  _ensureInit() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    if (config.useNativeAxios === true) {
      this._tlsInitFailed = true;
      logger.info('[RequesterManager] 使用原生 axios 请求');
      return;
    }

    try {
      const isPkg = typeof process.pkg !== 'undefined';
      const configPath = isPkg
        ? path.join(path.dirname(process.execPath), 'bin', 'tls_config.json')
        : path.join(__dirname, '..', 'bin', 'tls_config.json');

      const requester = fingerprintRequester.create({
        configPath,
        timeout: config.timeout ? Math.ceil(config.timeout / 1000) : 30,
        proxy: config.proxy || null,
      });

      // 主动探测二进制文件是否可执行（捕获架构不匹配、文件损坏等运行时错误）
      await this._probeBinary(requester.binaryPath);

      this._tlsRequester = requester;
      logger.info('[RequesterManager] 使用 FingerprintRequester（TLS 指纹）请求');
    } catch (error) {
      logger.warn('[RequesterManager] FingerprintRequester 初始化失败，自动降级使用 axios:', error.message);
      this._tlsInitFailed = true;
    }
  }

  /**
   * 主动 spawn 二进制文件做可执行性探测，立即关闭进程
   * 若 spawn 失败（UNKNOWN / ENOENT 等）则抛出错误，触发降级
   */
  _probeBinary(binaryPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn(binaryPath);
      proc.on('error', (err) => {
        reject(new Error(`二进制文件无法执行: ${err.message}`));
      });
      // 进程成功启动后立即关闭，不需要等待它完成
      proc.on('spawn', () => {
        proc.kill();
        resolve();
      });
      // 兼容旧版 Node（无 'spawn' 事件）：stdout 有数据也说明进程已启动
      proc.stdout.once('data', () => {
        proc.kill();
        resolve();
      });
      proc.stdin.end();
    });
  }

  get _useAxios() {
    return this._tlsInitFailed || !this._tlsRequester;
  }

  /**
   * 热重载：重置请求器，下次请求时按最新 config 重新初始化
   */
  reload() {
    if (this._tlsRequester) {
      try { this._tlsRequester.close(); } catch { /* ignore */ }
    }
    this._tlsRequester = null;
    this._tlsInitFailed = false;
    this._initPromise = null;
    logger.info('[RequesterManager] 请求器已重置，将在下次请求时按新配置重新初始化');
  }

  /**
   * 关闭所有活跃进程（进程退出时调用）
   */
  close() {
    if (this._tlsRequester) {
      try { this._tlsRequester.close(); } catch { /* ignore */ }
    }
  }

  // ==================== 核心请求方法 ====================

  /**
   * 发送普通 JSON 请求（非流式）
   *
   * @param {string} url
   * @param {object} options
   * @param {string}  [options.method='POST']
   * @param {object}  [options.headers={}]
   * @param {*}       [options.body=null]  - JSON 对象或字符串；二进制 body 请直接使用 axios
   * @param {number[]} [options.okStatus]  - 认为成功的状态码列表，默认 [200]
   * @returns {Promise<{ status: number, data: any }>}
   *   data 为解析后的 JSON 对象（axios 路径）或原始文本（解析失败时）
   */
  async fetch(url, { method = 'POST', headers = {}, body = null, okStatus = [200] } = {}) {
    await this._ensureInit();

    if (this._useAxios) {
      return this._axiosFetch(url, { method, headers, body, okStatus });
    }

    try {
      return await this._tlsFetch(url, { method, headers, body, okStatus });
    } catch (error) {
      if (!this._shouldFallbackToAxios(error)) {
        throw error;
      }
      logger.warn('[RequesterManager] FingerprintRequester 请求失败，自动降级使用 axios:', error.message);
      this._tlsInitFailed = true;
      return this._axiosFetch(url, { method, headers, body, okStatus });
    }
  }

  /**
   * 发送流式 SSE 请求
   *
   * @param {string} url
   * @param {object} options
   * @param {string}  [options.method='POST']
   * @param {object}  [options.headers={}]
   * @param {*}       [options.body=null]
   * @returns {Promise<StreamResponse | AxiosStreamResponse>}
   *   两者均实现 onStart/onData/onEnd/onError 链式调用接口
   */
  async fetchStream(url, { method = 'POST', headers = {}, body = null } = {}) {
    await this._ensureInit();

    if (this._useAxios) {
      return this._axiosFetchStream(url, { method, headers, body });
    }

    try {
      return this._tlsFetchStream(url, { method, headers, body });
    } catch (error) {
      if (!this._shouldFallbackToAxios(error)) {
        throw error;
      }
      logger.warn('[RequesterManager] FingerprintRequester 流式请求启动失败，自动降级使用 axios:', error.message);
      this._tlsInitFailed = true;
      return this._axiosFetchStream(url, { method, headers, body });
    }
  }

  _shouldFallbackToAxios(error) {
    const code = error?.code || error?.cause?.code;
    if (code === 'ERR_CONFIG') return false;
    if (code === 'ECONNABORTED' || code === 'ERR_NETWORK') return true;
    const message = error?.message || '';
    return message.includes('dial tcp') ||
      message.includes('missing address') ||
      message.includes('no such host') ||
      message.includes('connection refused') ||
      message.includes('timeout');
  }

  // ==================== TLS 路径 ====================

  async _tlsFetch(url, { method, headers, body, okStatus }) {
    const reqConfig = this._buildTlsConfig(method, headers, body);
    const response = await this._tlsRequester.antigravity_fetch(url, reqConfig);

    if (!okStatus.includes(response.status)) {
      const errorBody = await response.text();
      throw { status: response.status, message: errorBody };
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, data };
  }

  _tlsFetchStream(url, { method, headers, body }) {
    const reqConfig = this._buildTlsConfig(method, headers, body);
    return this._tlsRequester.antigravity_fetchStream(url, reqConfig);
  }

  _buildTlsConfig(method, headers, body) {
    const reqConfig = {
      method,
      headers,
      timeout_ms: config.timeout,
      proxy: config.proxy || null,
    };
    if (body !== null) {
      // Buffer / Uint8Array 直接传递（但 TLS 请求器目前不支持二进制 body，调用方应使用 axios）
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        reqConfig.body = body;
      } else {
        reqConfig.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
    }
    return reqConfig;
  }

  // ==================== axios 路径 ====================

  async _axiosFetch(url, { method, headers, body, okStatus }) {
    const axiosConfig = buildAxiosRequestConfig({
      method,
      url,
      headers,
      data: body,
      timeout: config.timeout,
    });

    // 对于非 2xx 状态码，axios 默认会抛错；这里统一处理
    axiosConfig.validateStatus = (status) => true;

    const response = await axios(axiosConfig);

    if (!okStatus.includes(response.status)) {
      const errorBody = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data);
      throw { status: response.status, message: errorBody };
    }

    return { status: response.status, data: response.data };
  }

  /**
   * axios 流式 SSE 路径
   * 返回一个实现了 onStart/onData/onEnd/onError 接口的对象，与 TLS StreamResponse 兼容
   */
  _axiosFetchStream(url, { method, headers, body }) {
    const streamResponse = new AxiosStreamResponse();

    const axiosConfig = buildAxiosRequestConfig({
      method,
      url,
      headers,
      data: body,
      timeout: config.timeout,
    });
    axiosConfig.responseType = 'stream';

    axios(axiosConfig)
      .then((response) => {
        const status = response.status;
        streamResponse._status = status;
        if (streamResponse._onStart) {
          streamResponse._onStart({ status, headers: response.headers });
        }

        response.data.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          if (streamResponse._onData) {
            streamResponse._onData(text);
          }
        });

        response.data.on('end', () => {
          if (streamResponse._onEnd) {
            streamResponse._onEnd();
          }
        });

        response.data.on('error', (err) => {
          if (streamResponse._onError) {
            streamResponse._onError(err);
          }
        });
      })
      .catch((err) => {
        if (streamResponse._onError) {
          streamResponse._onError(err);
        }
      });

    return streamResponse;
  }
}

// ==================== AxiosStreamResponse ====================

/**
 * axios 流式响应包装，接口与 src/requester.js 中的 StreamResponse 保持一致
 */
class AxiosStreamResponse {
  constructor() {
    this._status = null;
    this._onStart = null;
    this._onData = null;
    this._onEnd = null;
    this._onError = null;
  }

  get status() { return this._status; }

  onStart(callback) { this._onStart = callback; return this; }
  onData(callback)  { this._onData  = callback; return this; }
  onEnd(callback)   { this._onEnd   = callback; return this; }
  onError(callback) { this._onError = callback; return this; }
}

// ==================== 单例导出 ====================

export default new RequesterManager();
