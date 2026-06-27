const http = require('http');
const BaseProvider = require('./BaseProvider');

class OllamaProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'ollama';
    this.baseUrl = config.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.model = config.model || process.env.OLLAMA_MODEL || 'qwen2.5:7b';
    this.modelSmall = config.modelSmall || process.env.OLLAMA_MODEL_SMALL || this.model;
  }

  _request(path, data, timeout = 300000) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
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
        timeout: timeout
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve({ raw: body });
          }
        });
      });

      req.on('error', (e) => {
        reject(new Error(`Ollama 连接失败: ${e.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Ollama 请求超时'));
      });

      req.write(postData);
      req.end();
    });
  }

  async chat(messages, options = {}) {
    const model = options.useSmallModel ? this.modelSmall : this.model;
    const payload = {
      model: model,
      messages: messages,
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

  async generate(prompt, options = {}) {
    const model = options.useSmallModel ? this.modelSmall : this.model;
    const payload = {
      model: model,
      prompt: prompt,
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

  async listModels() {
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
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data.models || []);
          } catch (e) {
            resolve([]);
          }
        });
      });

      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
      req.end();
    });
  }
}

module.exports = OllamaProvider;
