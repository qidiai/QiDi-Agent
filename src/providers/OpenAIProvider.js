const https = require('https');
const http = require('http');
const BaseProvider = require('./BaseProvider');

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
            settleOnce(true, JSON.parse(body));
          } catch (e) {
            settleOnce(true, { raw: body, statusCode: res.statusCode });
          }
        });
      });

      req.on('error', (e) => {
        settleOnce(false, new Error(`OpenAI 连接失败: ${e.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        settleOnce(false, new Error('OpenAI 请求超时'));
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
      max_tokens: options.maxTokens || 2048
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
