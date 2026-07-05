const https = require('https');
const http = require('http');
const BaseProvider = require('./BaseProvider');
const { safeJsonParse } = require('../utils/SafeParser');
const { NetworkError, TimeoutError, HttpError, JsonParseError } = require('../utils/AppError');

class OpenAIProvider extends BaseProvider {
  constructor (config = {}) {
    super(config);
    this.name = 'openai';
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = config.baseUrl || config.baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this.model = config.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  }

  _request (path, data, timeout = 300000) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const fullURL = url.href;
      const postData = JSON.stringify(data);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout
      };

      if (this.apiKey) {
        options.headers.Authorization = `Bearer ${this.apiKey}`;
      }

      let settled = false; // 🚨 安全：确保 Promise 只 settle 一次

      const settleOnce = (isResolve, value) => {
        if (!settled) {
          settled = true;
          if (isResolve) {
            resolve(value);
          } else {
            reject(value);
          }
        }
      };

      const req = httpModule.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = safeJsonParse(body, { raw: body });

            // ── HTTP 错误状态码处理 ──
            if (res.statusCode >= 400) {
              const errMsg = parsed.error?.message || `HTTP ${res.statusCode}: ${body.substring(0, 200)}`;
              settleOnce(false, new HttpError(`OpenAI API 错误: ${errMsg}`, {
                url: fullURL,
                method: 'POST',
                status: res.statusCode,
                statusText: res.statusMessage || '',
                responseData: parsed,
                responseHeaders: res.headers
              }));
              return;
            }

            settleOnce(true, parsed);
          } catch (e) {
            // JSON 解析失败
            settleOnce(false, new JsonParseError(`OpenAI 响应 JSON 解析失败: ${e.message}`, {
              url: fullURL,
              rawText: body.substring(0, 500),
              cause: e
            }));
          }
        });
      });

      req.on('error', (e) => {
        // 区分超时和网络错误
        if (e.code === 'ECONNRESET' || e.code === 'ERR_SOCKET_CONNECTION_TIMEOUT') {
          settleOnce(false, new TimeoutError(`OpenAI 连接超时 (${timeout}ms)`, {
            url: fullURL,
            method: 'POST',
            timeout,
            cause: e
          }));
        } else {
          settleOnce(false, new NetworkError(`OpenAI 连接失败: ${e.message}`, {
            url: fullURL,
            method: 'POST',
            cause: e
          }));
        }
      });

      req.on('timeout', () => {
        req.destroy();
        settleOnce(false, new TimeoutError(`OpenAI 请求超时 (${timeout}ms)`, {
          url: fullURL,
          method: 'POST',
          timeout
        }));
      });

      req.write(postData);
      req.end();
    });
  }

  async chat (messages, options = {}) {
    const model = options.model || this.model;
    const payload = {
      model,
      messages,
      temperature: options.temperature !== undefined ? options.temperature : 0.7,
      max_tokens: options.maxTokens || 8192
    };

    if (options.systemPrompt) {
      payload.messages = [
        { role: 'system', content: options.systemPrompt },
        ...messages
      ];
    }

    try {
      const result = await this._request('/chat/completions', payload);
      if (result.error) {
        throw new Error(result.error.message || 'OpenAI API 错误');
      }
      return {
        content: result.choices?.[0]?.message?.content || '',
        role: result.choices?.[0]?.message?.role || 'assistant',
        model: result.model || model,
        usage: result.usage,
        raw: result
      };
    } catch (e) {
      throw new Error(`OpenAI chat 失败: ${e.message}`);
    }
  }

  async generate (prompt, options = {}) {
    const messages = [{ role: 'user', content: prompt }];
    return this.chat(messages, options);
  }

  /**
   * G2: 流式聊天补全
   * @param {Array} messages - 消息列表
   * @param {Object} options - 选项（同 chat）
   * @param {Function} onChunk - 接收每个文本块的回调 (delta, fullContent) => void
   * @returns {Object} 最终结果 { content, model, role }
   */
  async chatStream (messages, options = {}, onChunk) {
    if (typeof options === 'function') {
      onChunk = options;
      options = {};
    }
    const model = options.model || this.model;
    const payload = {
      model,
      messages: options.systemPrompt
        ? [{ role: 'system', content: options.systemPrompt }, ...messages]
        : messages,
      temperature: options.temperature !== undefined ? options.temperature : 0.7,
      max_tokens: options.maxTokens || 8192,
      stream: true
    };

    return new Promise((resolve, reject) => {
      const url = new URL('/chat/completions', this.baseUrl);
      const postData = JSON.stringify(payload);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const reqOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: options.timeout || 300000
      };

      if (this.apiKey) {
        reqOptions.headers.Authorization = `Bearer ${this.apiKey}`;
      }

      let fullContent = '';
      let settled = false;

      const req = httpModule.request(reqOptions, (res) => {
        if (res.statusCode >= 400) {
          let body = '';
          res.on('data', (c) => {
            body += c;
          });
          res.on('end', () => {
            if (!settled) {
              settled = true;
              reject(new Error(`OpenAI stream HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
            }
          });
          return;
        }

        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') {
              if (!settled) {
                settled = true;
                resolve({ content: fullContent, model, role: 'assistant' });
              }
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content || '';
              if (delta) {
                fullContent += delta;
                if (onChunk) onChunk(delta, fullContent);
              }
            } catch (_) {}
          }
        });

        res.on('end', () => {
          if (!settled) {
            settled = true;
            resolve({ content: fullContent, model, role: 'assistant' });
          }
        });
      });

      req.on('error', (e) => {
        if (!settled) {
          settled = true;
          reject(new Error(`OpenAI stream 失败: ${e.message}`));
        }
      });

      req.on('timeout', () => {
        req.destroy();
        if (!settled) {
          settled = true;
          reject(new Error(`OpenAI stream 超时 (${reqOptions.timeout}ms)`));
        }
      });

      req.write(postData);
      req.end();
    });
  }

  async listModels () {
    try {
      const result = await this._request('/models', {}, 'GET');
      return result.data || [];
    } catch (e) {
      return [];
    }
  }
}

module.exports = OpenAIProvider;
