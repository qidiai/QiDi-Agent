const http = require('http');
const BaseProvider = require('./BaseProvider');
const { safeJsonParse } = require('../utils/SafeParser');
const { NetworkError, TimeoutError, HttpError, JsonParseError } = require('../utils/AppError');

class OllamaProvider extends BaseProvider {
  constructor (config = {}) {
    super(config);
    this.name = 'ollama';
    this.baseUrl = config.baseUrl || config.baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.model = config.model || process.env.OLLAMA_MODEL || 'qwen2.5:7b';
    this.modelSmall = config.modelSmall || process.env.OLLAMA_MODEL_SMALL || this.model;
  }

  _request (path, data, timeout = 300000) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const fullURL = url.href;
      const postData = JSON.stringify(data);

      const options = {
        hostname: url.hostname,
        port: url.port || 11434,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = safeJsonParse(body, { raw: body });

            // ── HTTP 错误状态码处理 ──
            if (res.statusCode >= 400) {
              const errMsg = parsed.error || parsed.message || `HTTP ${res.statusCode}: ${body.substring(0, 200)}`;
              reject(new HttpError(`Ollama API 错误: ${errMsg}`, {
                url: fullURL,
                method: 'POST',
                status: res.statusCode,
                statusText: res.statusMessage || '',
                responseData: parsed,
                responseHeaders: res.headers
              }));
              return;
            }

            resolve(parsed);
          } catch (e) {
            reject(new JsonParseError(`Ollama 响应 JSON 解析失败: ${e.message}`, {
              url: fullURL,
              rawText: body.substring(0, 500),
              cause: e
            }));
          }
        });
      });

      req.on('error', (e) => {
        if (e.code === 'ECONNRESET' || e.code === 'ERR_SOCKET_CONNECTION_TIMEOUT') {
          reject(new TimeoutError(`Ollama 连接超时 (${timeout}ms)`, {
            url: fullURL,
            method: 'POST',
            timeout,
            cause: e
          }));
        } else {
          reject(new NetworkError(`Ollama 连接失败: ${e.message}`, {
            url: fullURL,
            method: 'POST',
            cause: e
          }));
        }
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new TimeoutError(`Ollama 请求超时 (${timeout}ms)`, {
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
    const model = options.useSmallModel ? this.modelSmall : this.model;
    const payload = {
      model,
      messages,
      stream: false,
      options: {
        temperature: options.temperature !== undefined ? options.temperature : 0.7,
        num_predict: options.maxTokens || 2048
      }
    };

    if (options.systemPrompt) {
      payload.messages = [
        { role: 'system', content: options.systemPrompt },
        ...messages
      ];
    }

    try {
      const result = await this._request('/api/chat', payload);
      return {
        content: result.message?.content || '',
        role: result.message?.role || 'assistant',
        model: result.model || model,
        raw: result
      };
    } catch (e) {
      throw new Error(`Ollama chat 失败: ${e.message}`);
    }
  }

  async generate (prompt, options = {}) {
    const model = options.useSmallModel ? this.modelSmall : this.model;
    const payload = {
      model,
      prompt,
      stream: false,
      options: {
        temperature: options.temperature !== undefined ? options.temperature : 0.7,
        num_predict: options.maxTokens || 2048
      }
    };

    if (options.systemPrompt) {
      payload.system = options.systemPrompt;
    }

    try {
      const result = await this._request('/api/generate', payload);
      return {
        content: result.response || '',
        model: result.model || model,
        raw: result
      };
    } catch (e) {
      throw new Error(`Ollama generate 失败: ${e.message}`);
    }
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
    const model = options.useSmallModel ? this.modelSmall : this.model;
    const payload = {
      model,
      messages: options.systemPrompt
        ? [{ role: 'system', content: options.systemPrompt }, ...messages]
        : messages,
      stream: true,
      options: {
        temperature: options.temperature !== undefined ? options.temperature : 0.7,
        num_predict: options.maxTokens || 2048
      }
    };

    return new Promise((resolve, reject) => {
      const url = new URL('/api/chat', this.baseUrl);
      const postData = JSON.stringify(payload);

      const reqOptions = {
        hostname: url.hostname,
        port: url.port || 11434,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: options.timeout || 300000
      };

      let fullContent = '';
      let settled = false;

      const req = http.request(reqOptions, (res) => {
        if (res.statusCode >= 400) {
          let body = '';
          res.on('data', (c) => {
            body += c;
          });
          res.on('end', () => {
            if (!settled) {
              settled = true;
              reject(new Error(`Ollama stream HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
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
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              const delta = parsed.message?.content || '';
              if (delta) {
                fullContent += delta;
                if (onChunk) onChunk(delta, fullContent);
              }
              if (parsed.done) {
                if (!settled) {
                  settled = true;
                  resolve({
                    content: fullContent,
                    model: parsed.model || model,
                    role: 'assistant'
                  });
                }
                return;
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
          reject(new Error(`Ollama stream 失败: ${e.message}`));
        }
      });

      req.on('timeout', () => {
        req.destroy();
        if (!settled) {
          settled = true;
          reject(new Error(`Ollama stream 超时 (${reqOptions.timeout}ms)`));
        }
      });

      req.write(postData);
      req.end();
    });
  }

  async listModels () {
    return new Promise((resolve, reject) => {
      const url = new URL('/api/tags', this.baseUrl);
      const options = {
        hostname: url.hostname,
        port: url.port || 11434,
        path: url.pathname,
        method: 'GET',
        timeout: 5000
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const data = safeJsonParse(body, {});
            resolve(data.models || []);
          } catch (e) {
            resolve([]);
          }
        });
      });

      req.on('error', () => resolve([]));
      req.on('timeout', () => {
        req.destroy(); resolve([]);
      });
      req.end();
    });
  }
}

module.exports = OllamaProvider;
