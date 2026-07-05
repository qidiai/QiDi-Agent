'use strict';

const {
  NetworkError,
  TimeoutError,
  HttpError,
  JsonParseError
} = require('./AppError');

/**
 * HttpClient —— 轻量 HTTP 客户端
 *
 * 提供基于 fetch 的统一 get/post/put/delete 请求接口，支持：
 *   - 超时控制
 *   - 请求/响应拦截器
 *   - 自动重试
 *   - 请求取消（AbortController）
 *   - 配置化（baseURL、默认 headers、超时等）
 *
 * @example
 *   const client = new HttpClient({ baseURL: 'https://api.example.com', timeout: 5000 });
 *   const res = await client.get('/users', { params: { page: 1 } });
 *   console.log(res.data);
 */

// ─── 类型定义（JSDoc） ─────────────────────────────────────────

/**
 * @typedef {Object} RequestConfig
 * @property {string}  url             - 请求路径（若不以 http(s) 开头则拼接 baseURL）
 * @property {'GET'|'POST'|'PUT'|'DELETE'|'PATCH'} [method='GET'] - HTTP 方法
 * @property {Object<string,string>} [headers]    - 请求头
 * @property {Object<string,any>}    [params]     - URL 查询参数
 * @property {*}                     [data]        - 请求体（JSON 对象会被自动序列化）
 * @property {number}                [timeout]     - 超时毫秒数，覆盖实例默认值
 * @property {AbortSignal}           [signal]      - 外部取消信号
 * @property {'json'|'text'|'blob'|'arraybuffer'} [responseType='json'] - 响应解析类型
 * @property {boolean}               [retry]       - 是否重试（覆盖实例默认值）
 * @property {number}                [retryDelay]  - 重试间隔 ms
 * @property {number}                [retryCount]  - 最大重试次数
 */

/**
 * @typedef {Object} HttpResponse
 * @property {number}                status     - HTTP 状态码
 * @property {string}                statusText - 状态文本
 * @property {Object<string,string>} headers    - 响应头（小写键）
 * @property {*}                     data       - 解析后的响应体
 * @property {RequestConfig}         config     - 发起请求时的配置
 * @property {number}                duration   - 请求耗时 (ms)
 */

/**
 * @typedef {Object} HttpClientConfig
 * @property {string}                [baseURL]          - 基础 URL，会拼接到相对路径前
 * @property {Object<string,string>} [headers]           - 全局默认请求头
 * @property {number}                [timeout=10000]     - 默认超时毫秒数
 * @property {'json'|'text'|'blob'|'arraybuffer'} [responseType='json'] - 默认响应解析类型
 * @property {boolean}               [retry=false]       - 是否自动重试失败请求
 * @property {number}                [retryCount=2]      - 最大重试次数
 * @property {number}                [retryDelay=1000]   - 重试间隔 ms
 * @property {function[]}            [requestInterceptors]  - 请求拦截器链
 * @property {function[]}            [responseInterceptors] - 响应拦截器链
 * @property {boolean}               [validateStatus=true]   - 是否校验状态码（< 400 视为成功）
 */

// ─── 工具函数 ─────────────────────────────────────────────────

/** 拼接完整 URL */
function _buildURL (baseURL, url, params) {
  let full = '';
  if (/^https?:\/\//i.test(url)) {
    full = url;
  } else {
    full = (baseURL || '').replace(/\/+$/, '') + '/' + url.replace(/^\/+/, '');
  }

  if (params && Object.keys(params).length > 0) {
    const qs = Object.entries(params)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    if (qs) full += (full.includes('?') ? '&' : '?') + qs;
  }

  return full;
}

/** 合并请求头（默认 headers + 本次 headers），后者覆盖前者 */
function _mergeHeaders (defaultHeaders, requestHeaders) {
  return { ...defaultHeaders, ...requestHeaders };
}

/** 延迟指定毫秒 */
function _sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── HttpClient 类 ────────────────────────────────────────────

class HttpClient {
  /**
   * @param {HttpClientConfig} config - 客户端全局配置
   */
  constructor (config = {}) {
    /** @type {HttpClientConfig} */
    this.defaults = {
      baseURL: config.baseURL || '',
      headers: { 'Content-Type': 'application/json', ...config.headers },
      timeout: config.timeout ?? 10000,
      responseType: config.responseType || 'json',
      retry: config.retry ?? false,
      retryCount: config.retryCount ?? 2,
      retryDelay: config.retryDelay ?? 1000,
      validateStatus: config.validateStatus !== false,
      requestInterceptors: [...(config.requestInterceptors || [])],
      responseInterceptors: [...(config.responseInterceptors || [])]
    };
  }

  // ─── 拦截器管理 ────────────────────────────────────────────

  /**
   * 注册请求拦截器
   * @param {function(RequestConfig, HttpClientConfig): (RequestConfig|Promise<RequestConfig>)} fn
   * @returns {number} 拦截器 id（用于移除）
   */
  useRequestInterceptor (fn) {
    return this.defaults.requestInterceptors.push(fn);
  }

  /**
   * 注册响应拦截器
   * @param {function(HttpResponse, HttpClientConfig): (HttpResponse|Promise<HttpResponse>)} fn
   * @returns {number} 拦截器 id
   */
  useResponseInterceptor (fn) {
    return this.defaults.responseInterceptors.push(fn);
  }

  /**
   * 移除拦截器
   * @param {'request'|'response'} type
   * @param {number} id
   */
  ejectInterceptor (type, id) {
    const key = type === 'request' ? 'requestInterceptors' : 'responseInterceptors';
    if (this.defaults[key][id - 1] != null) {
      this.defaults[key][id - 1] = null;
    }
  }

  // ─── 核心请求方法 ──────────────────────────────────────────

  /**
   * 发送 HTTP 请求（底层核心方法）
   *
   * @param {string}  urlOrPath - 完整 URL 或相对路径
   * @param {RequestConfig} [config] - 请求配置
   * @returns {Promise<HttpResponse>}
   * @throws {Error} 超时 / 网络错误 / 非 2xx 状态（validateStatus=true 时）
   */
  async request (urlOrPath, config = {}) {
    /** @type {RequestConfig} */
    const mergedConfig = {
      ...this.defaults,
      ...config,
      headers: _mergeHeaders(this.defaults.headers, config.headers || {})
    };
    mergedConfig.url = urlOrPath;

    // ── 运行请求拦截器 ──
    let chainConfig = mergedConfig;
    for (const interceptor of this.defaults.requestInterceptors) {
      if (typeof interceptor === 'function') {
        chainConfig = await interceptor(chainConfig, this.defaults);
      }
    }

    // ── 构建请求参数 ──
    const { url, method = 'GET', data, params, responseType } = chainConfig;
    const fullURL = _buildURL(this.defaults.baseURL, url, params);
    const startTime = Date.now();

    // 每次请求独立的 AbortController（支持 signal + 超时双重取消）
    const controller = new AbortController();
    const timeout = chainConfig.timeout ?? this.defaults.timeout;
    let timeoutHandle = null;

    if (timeout > 0) {
      timeoutHandle = setTimeout(() => {
        controller.abort(
          new TimeoutError(`请求超时 (${timeout}ms): ${method} ${fullURL}`, {
            url: fullURL,
            method,
            timeout
          })
        );
      }, timeout);
    }

    // 如果外部传入了 signal，在外部 signal abort 时同步中止内部 controller
    const externalSignal = chainConfig.signal;
    let onExternalAbort = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        onExternalAbort = () => controller.abort(externalSignal.reason);
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    try {
      return await this._executeWithRetry(chainConfig, fullURL, controller.signal, startTime, responseType);
    } finally {
      // 清理资源
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  /**
   * 带重试的请求执行
   * @private
   */
  async _executeWithRetry (config, fullURL, signal, startTime, responseType) {
    const maxRetries = config.retry ? (config.retryCount ?? this.defaults.retryCount) : 0;
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this._doFetch(config, fullURL, signal);

        // ── 运行响应拦截器 ──
        let processed = response;
        for (const interceptor of this.defaults.responseInterceptors) {
          if (typeof interceptor === 'function') {
            processed = await interceptor(processed, this.defaults);
          }
        }

        // ── 状态码校验 ──
        if (this.defaults.validateStatus && processed.status >= 400) {
          const respData = processed.data;
          const err = new HttpError(
            `HTTP ${processed.status}: ${processed.statusText} — ${config.method || 'GET'} ${fullURL}`,
            {
              url: fullURL,
              method: config.method || 'GET',
              status: processed.status,
              statusText: processed.statusText,
              responseData: respData,
              responseHeaders: processed.headers
            }
          );
          throw err;
        }

        return processed;
      } catch (err) {
        lastError = err;
        // 请求被取消 / 中止 —— 不再重试
        if (err.name === 'AbortError' || sigAborted(signal)) throw err;
        // 最后一次尝试 —— 不再重试
        if (attempt >= maxRetries) throw err;
        // 等待后重试
        await _sleep(config.retryDelay ?? this.defaults.retryDelay);
      }
    }

    // unreachable
    throw lastError;
  }

  /**
   * 执行真正的 fetch 调用
   * @private
   */
  async _doFetch (config, fullURL, signal) {
    const { method = 'GET', headers } = config;
    const startTime = Date.now();

    /** @type {Object} */
    const fetchInit = {
      method,
      headers,
      signal
    };

    // 序列化请求体
    if (config.data != null && method !== 'GET' && method !== 'HEAD') {
      if (typeof config.data === 'object' && !(config.data instanceof FormData) && !(config.data instanceof URLSearchParams)) {
        fetchInit.body = JSON.stringify(config.data);
      } else {
        fetchInit.body = config.data;
      }
      // 如果用户没有设置 Content-Type，自动补 application/json
      if (!headers['Content-Type'] && !this.defaults.headers['Content-Type']) {
        fetchInit.headers['Content-Type'] = 'application/json';
      }
    }

    let raw;
    try {
      raw = await fetch(fullURL, fetchInit);
    } catch (err) {
      // 如果 fetch 因超时中止，透传 TimeoutError
      if (err.name === 'TimeoutError') {
        throw err;
      }
      // 检查 AbortController 的 reason 是否为 TimeoutError（Node ≥ 18 行为）
      if (err.name === 'AbortError') {
        try {
          const signal = fetchInit.signal;
          if (signal && signal.reason instanceof TimeoutError) {
            throw signal.reason;
          }
        } catch (_) { /* 无法获取 reason 时回退到 NetworkError */ }
      }
      // 网络错误（DNS / 连接拒绝 / TLS 等）
      const netErr = new NetworkError(`网络请求失败: ${err.message}`, {
        url: fullURL,
        method,
        cause: err
      });
      throw netErr;
    }

    // 构造响应对象
    const responseType = config.responseType ?? this.defaults.responseType;
    const respHeaders = {};
    raw.headers.forEach((v, k) => {
      respHeaders[k.toLowerCase()] = v;
    });

    /** @type {HttpResponse} */
    const httpResponse = {
      status: raw.status,
      statusText: raw.statusText,
      headers: respHeaders,
      data: null,
      config,
      duration: Date.now() - startTime
    };

    // 解析响应体
    if (raw.status === 204 || raw.status === 304) {
      httpResponse.data = null;
    } else {
      try {
        switch (responseType) {
        case 'text':
          httpResponse.data = await raw.text();
          break;
        case 'blob':
          httpResponse.data = await raw.blob();
          break;
        case 'arraybuffer':
          httpResponse.data = await raw.arrayBuffer();
          break;
        case 'json':
        default:
          httpResponse.data = await raw.json();
          break;
        }
      } catch (parseErr) {
        // 解析失败时保留原始文本，并附加诊断信息
        const rawText = await raw.text().catch(() => null);
        httpResponse.data = rawText;
        if (this.defaults.validateStatus && rawText !== null) {
          const jsonErr = new JsonParseError(
            `JSON 解析失败: ${parseErr.message} — ${method} ${fullURL}`,
            {
              url: fullURL,
              rawText: rawText.length > 500 ? rawText.substring(0, 500) + '...' : rawText,
              cause: parseErr
            }
          );
          // 附加到响应上，方便调用方感知
          httpResponse.parseError = jsonErr;
        }
      }
    }

    return httpResponse;
  }

  // ─── 便捷方法 ──────────────────────────────────────────────

  /**
   * GET 请求
   *
   * @param {string}  url   - 请求路径或完整 URL
   * @param {Object}  [options]
   * @param {Object<string,any>} [options.params]  - URL 查询参数
   * @param {Object<string,string>} [options.headers] - 请求头
   * @param {number}  [options.timeout]  - 超时 ms
   * @param {AbortSignal} [options.signal] - 取消信号
   * @returns {Promise<HttpResponse>}
   *
   * @example
   *   const res = await client.get('/users', { params: { page: 1, limit: 20 } });
   *   // res.data => 响应体, res.status => 200
   */
  async get (url, options = {}) {
    return this.request(url, { ...options, method: 'GET' });
  }

  /**
   * POST 请求
   *
   * @param {string}  url   - 请求路径或完整 URL
   * @param {*}       [data]  - 请求体（Object 自动 JSON 序列化）
   * @param {Object}  [options]
   * @param {Object<string,any>} [options.params]  - URL 查询参数
   * @param {Object<string,string>} [options.headers] - 请求头
   * @param {number}  [options.timeout]  - 超时 ms
   * @param {AbortSignal} [options.signal] - 取消信号
   * @returns {Promise<HttpResponse>}
   *
   * @example
   *   const res = await client.post('/users', { name: 'Alice' });
   *   // res.data => 创建后的用户对象
   */
  async post (url, data, options = {}) {
    return this.request(url, { ...options, method: 'POST', data });
  }

  /**
   * PUT 请求
   *
   * @param {string}  url   - 请求路径或完整 URL
   * @param {*}       [data]  - 请求体
   * @param {Object}  [options] - 其余选项同 post
   * @returns {Promise<HttpResponse>}
   */
  async put (url, data, options = {}) {
    return this.request(url, { ...options, method: 'PUT', data });
  }

  /**
   * DELETE 请求
   *
   * @param {string}  url   - 请求路径或完整 URL
   * @param {Object}  [options] - 选项（同 get）
   * @returns {Promise<HttpResponse>}
   */
  async delete (url, options = {}) {
    return this.request(url, { ...options, method: 'DELETE' });
  }

  /**
   * 创建一个新实例（继承当前配置）
   *
   * @param {HttpClientConfig} [override] - 覆盖的配置
   * @returns {HttpClient}
   */
  clone (override = {}) {
    return new HttpClient({
      ...this.defaults,
      ...override,
      headers: { ...this.defaults.headers, ...override.headers },
      requestInterceptors: [...this.defaults.requestInterceptors],
      responseInterceptors: [...this.defaults.responseInterceptors]
    });
  }
}

// ─── 辅助：判断 AbortSignal 是否已中止 ────────────────────────

function sigAborted (signal) {
  return signal && signal.aborted;
}

// ─── 导出 ─────────────────────────────────────────────────────

module.exports = HttpClient;
module.exports.HttpClient = HttpClient;
