/**
 * Anthropic Claude API Provider
 *
 * 支持 Claude 3.5 Sonnet、Claude 3 Opus、Claude 3 Haiku 等模型
 *
 * API 文档: https://docs.anthropic.com/claude/reference
 */

const https = require('https');
const http = require('http');

class AnthropicProvider {
  constructor (config = {}) {
    this.name = 'anthropic';
    this.displayName = 'Anthropic Claude';
    this.description = 'Anthropic Claude 系列模型 (claude-3-5-sonnet, claude-3-opus, claude-3-haiku)';

    // 配置
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.baseURL = config.baseURL || 'https://api.anthropic.com';
    this.model = config.model || process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20240620';
    this.maxTokens = config.maxTokens || 4096;
    this.timeout = config.timeout || 120000;

    // 可用模型列表
    this.availableModels = [
      'claude-3-5-sonnet-20240620',
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
      'claude-3-opus-20240120',
      'claude-3-sonnet-20240229',
      'claude-3-sonnet-20240120',
      'claude-3-haiku-20240307',
      'claude-3-haiku-20240229',
      'claude-2.1',
      'claude-2',
      'claude-instant-1'
    ];
  }

  /**
   * 获取 HTTP 请求选项
   */
  _getRequestOptions (path, method = 'POST') {
    const url = new URL(path, this.baseURL);

    return {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      timeout: this.timeout
    };
  }

  /**
   * 发送 HTTP 请求
   */
  _request (options, body) {
    return new Promise((resolve, reject) => {
      const protocol = options.port === 443 ? https : http;

      const req = protocol.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ data: parsed, status: res.statusCode });
            } else {
              reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}: ${data}`));
            }
          } catch (e) {
            reject(new Error(`解析响应失败: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('请求超时'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /**
   * 检查 API 连接
   */
  async checkConnection () {
    if (!this.apiKey) {
      return { success: false, message: 'ANTHROPIC_API_KEY 未设置' };
    }

    try {
      const options = this._getRequestOptions('/v1/messages', 'POST');
      const response = await this._request(options, {
        model: this.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }]
      });

      return { success: true, message: 'Anthropic API 连接成功', model: this.model };
    } catch (e) {
      return { success: false, message: `连接失败: ${e.message}` };
    }
  }

  /**
   * 聊天补全（核心方法）
   *
   * @param {Object} options
   * @param {Array} options.messages - 消息历史 [{role: 'user'|'assistant', content: '...'}]
   * @param {string} options.model - 模型名称（可选）
   * @param {number} options.maxTokens - 最大 token 数（可选）
   * @param {number} options.temperature - 温度参数（可选）
   * @param {Object} options.system - 系统提示（可选）
   * @param {Array} options.tools - 工具定义（可选）
   * @returns {Promise<Object>}
   */
  async chat (options = {}) {
    const {
      messages = [],
      model = this.model,
      maxTokens = this.maxTokens,
      temperature = 1,
      system = null,
      tools = null,
      stopSequences = null,
      topP = null,
      topK = null
    } = options;

    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY 未设置');
    }

    // 构建请求体
    const requestBody = {
      model,
      max_tokens: maxTokens,
      system: system || null,
      temperature
    };

    // 完善角色映射：Anthropic 支持 system/user/assistant/tool 四种角色
    if (messages && messages.length > 0) {
      const mappedMessages = [];
      let systemBlock = null;

      // 先收集 system 角色消息
      const systemMsg = messages.find(m => m.role === 'system');
      if (systemMsg) {
        systemBlock = systemMsg.content;
      }

      // 映射其余消息，正确处理 tool 角色
      for (const msg of messages) {
        if (msg.role === 'system') continue; // 已在上面处理

        if (msg.role === 'tool') {
          // tool 角色 → 作为 assistant 的 tool_result 块
          // Anthropic 要求 tool_use 和 tool_result 成对出现
          mappedMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: msg.tool_use_id || '',
              content: msg.content
            }]
          });
        } else if (msg.role === 'tool_use') {
          // tool_use 角色（来自 API 响应的结构化输出）→ assistant 的 tool_use 块
          mappedMessages.push({
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: msg.id || '',
              name: msg.name || '',
              input: msg.input || {}
            }]
          });
        } else if (msg.role === 'assistant') {
          // assistant 角色：支持文本块和 tool_use 块的混合
          if (Array.isArray(msg.content)) {
            // 已经是结构化格式，直接使用
            mappedMessages.push({
              role: 'assistant',
              content: msg.content
            });
          } else {
            // 纯文本 → 转为文本块
            mappedMessages.push({
              role: 'assistant',
              content: [{ type: 'text', text: msg.content }]
            });
          }
        } else {
          // user 角色：支持文本或结构化内容
          if (Array.isArray(msg.content)) {
            mappedMessages.push({
              role: 'user',
              content: msg.content
            });
          } else {
            mappedMessages.push({
              role: 'user',
              content: [{ type: 'text', text: msg.content }]
            });
          }
        }
      }

      requestBody.messages = mappedMessages;
      // system 优先放在 requestBody 顶层（Anthropic API 推荐方式）
      if (systemBlock) {
        requestBody.system = systemBlock;
      }
    }

    // 添加工具定义
    if (tools && tools.length > 0) {
      requestBody.tools = tools.map(tool => this._convertTool(tool));
    }

    // 可选参数
    if (stopSequences) {
      requestBody.stop_sequences = stopSequences;
    }
    if (topP !== null) {
      requestBody.top_p = topP;
    }
    if (topK !== null) {
      requestBody.top_k = topK;
    }

    try {
      const reqOptions = this._getRequestOptions('/v1/messages');
      const response = await this._request(reqOptions, requestBody);

      return this._formatResponse(response.data);
    } catch (e) {
      throw new Error(`Anthropic API 调用失败: ${e.message}`);
    }
  }

  /**
   * 流式聊天补全
   *
   * @param {Object} options - 同 chat()
   * @param {Function} onChunk - 接收每个 chunk 的回调
   */
  async chatStream (options = {}, onChunk) {
    const {
      messages = [],
      model = this.model,
      maxTokens = this.maxTokens,
      temperature = 1,
      system = null,
      tools = null
    } = options;

    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY 未设置');
    }

    const mappedMessages = [];
    let streamSystemBlock = system || null;
    const systemMsg = messages.find(m => m.role === 'system');
    if (systemMsg) {
      streamSystemBlock = systemMsg.content;
    }

    for (const msg of messages) {
      if (msg.role === 'system') continue;
      if (msg.role === 'tool') {
        mappedMessages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: msg.tool_use_id || '', content: msg.content }]
        });
      } else if (msg.role === 'tool_use') {
        mappedMessages.push({
          role: 'assistant',
          content: [{ type: 'tool_use', id: msg.id || '', name: msg.name || '', input: msg.input || {} }]
        });
      } else if (msg.role === 'assistant') {
        mappedMessages.push({
          role: 'assistant',
          content: Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
        });
      } else {
        mappedMessages.push({
          role: 'user',
          content: Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
        });
      }
    }

    const requestBody = {
      model,
      max_tokens: maxTokens,
      messages: mappedMessages,
      temperature,
      stream: true
    };

    if (streamSystemBlock) {
      requestBody.system = streamSystemBlock;
    }

    if (tools && tools.length > 0) {
      requestBody.tools = tools.map(tool => this._convertTool(tool));
    }

    return new Promise((resolve, reject) => {
      const url = new URL('/v1/messages', this.baseURL);
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        timeout: this.timeout
      };

      const protocol = https;
      const req = protocol.request(options, (res) => {
        let buffer = '';

        res.on('data', (chunk) => {
          buffer += chunk.toString();

          // 处理 SSE 格式的行
          const lines = buffer.split('\n');
          buffer = lines.pop(); // 保留未完成的行

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                continue;
              }
              try {
                const parsed = JSON.parse(data);
                const formatted = this._formatStreamChunk(parsed);
                if (formatted && onChunk) {
                  onChunk(formatted);
                }
              } catch (e) {
                // 忽略解析错误
              }
            }
          }
        });

        res.on('end', () => {
          resolve();
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('流式请求超时'));
      });

      req.write(JSON.stringify(requestBody));
      req.end();
    });
  }

  /**
   * 生成文本（简单模式）
   */
  async generate (prompt, options = {}) {
    return this.chat({
      messages: [{ role: 'user', content: prompt }],
      ...options
    });
  }

  /**
   * 获取模型信息
   */
  getModelInfo (modelName = this.model) {
    return {
      name: modelName,
      provider: 'anthropic',
      displayName: this._getModelDisplayName(modelName),
      contextWindow: this._getContextWindow(modelName),
      maxOutputTokens: this._getMaxOutput(modelName),
      description: this._getModelDescription(modelName)
    };
  }

  /**
   * 列出所有可用模型
   */
  listModels () {
    return this.availableModels.map(model => this.getModelInfo(model));
  }

  /**
   * 转换 OpenAI 格式的工具为 Anthropic 格式
   */
  _convertTool (tool) {
    // Anthropic 的工具格式与 OpenAI 不同
    if (tool.type === 'function') {
      return {
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters || { type: 'object', properties: {} }
      };
    }
    return tool;
  }

  /**
   * 格式化响应
   */
  _formatResponse (data) {
    const response = {
      id: data.id,
      model: data.model,
      role: 'assistant',
      content: '',
      finishReason: data.stop_reason,
      usage: {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
        totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
      },
      raw: data
    };

    // 解析 content
    if (data.content) {
      if (typeof data.content === 'string') {
        response.content = data.content;
      } else if (Array.isArray(data.content)) {
        // 处理多模态内容
        const textParts = data.content.filter(c => c.type === 'text').map(c => c.text);
        response.content = textParts.join('\n');

        // 保存工具调用
        const toolUses = data.content.filter(c => c.type === 'tool_use');
        if (toolUses.length > 0) {
          response.toolCalls = toolUses.map(t => ({
            id: t.id,
            name: t.name,
            input: t.input
          }));
        }
      }
    }

    return response;
  }

  /**
   * 格式化流式 chunk
   */
  _formatStreamChunk (data) {
    if (data.type === 'content_block_start') {
      return { type: 'start', content: '' };
    }

    if (data.type === 'content_block_delta') {
      if (data.delta.type === 'text_delta') {
        return { type: 'content', content: data.delta.text };
      }
      if (data.delta.type === 'input_json_delta') {
        return { type: 'tool', name: '', input: data.delta.partial_json };
      }
    }

    if (data.type === 'content_block_stop') {
      return { type: 'stop' };
    }

    if (data.type === 'message_delta') {
      return {
        type: 'usage',
        usage: {
          outputTokens: data.usage?.output_tokens || 0
        }
      };
    }

    return null;
  }

  /**
   * 获取模型显示名称
   */
  _getModelDisplayName (model) {
    const names = {
      'claude-3-5-sonnet-20240620': 'Claude 3.5 Sonnet (最新)',
      'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet (大版本)',
      'claude-3-opus-20240229': 'Claude 3 Opus',
      'claude-3-sonnet-20240229': 'Claude 3 Sonnet',
      'claude-3-haiku-20240307': 'Claude 3 Haiku (最新)',
      'claude-3-haiku-20240229': 'Claude 3 Haiku'
    };
    return names[model] || model;
  }

  /**
   * 获取模型上下文窗口大小
   */
  _getContextWindow (model) {
    // Claude 3.5 系列 200K，其他 200K
    if (model.includes('3-5') || model.includes('claude-3-5')) {
      return 200000;
    }
    if (model.includes('claude-3')) {
      return 200000;
    }
    if (model.includes('claude-2')) {
      return 100000;
    }
    if (model.includes('claude-instant')) {
      return 100000;
    }
    return 100000;
  }

  /**
   * 获取模型最大输出 token
   */
  _getMaxOutput (model) {
    if (model.includes('3-5-sonnet') || model.includes('3-opus')) {
      return 8192;
    }
    if (model.includes('claude-3')) {
      return 4096;
    }
    if (model.includes('claude-2')) {
      return 4096;
    }
    if (model.includes('claude-instant')) {
      return 4096;
    }
    return 4096;
  }

  /**
   * 获取模型描述
   */
  _getModelDescription (model) {
    if (model.includes('3-5-sonnet')) {
      return '最智能的 Claude 模型，适合复杂任务和编程';
    }
    if (model.includes('3-opus')) {
      return '最强大的 Claude 模型，适合最复杂的任务';
    }
    if (model.includes('3-sonnet')) {
      return '平衡性能和速度的 Claude 3 模型';
    }
    if (model.includes('3-haiku')) {
      return '最快最轻量的 Claude 3 模型';
    }
    if (model.includes('claude-2')) {
      return 'Claude 2 系列模型';
    }
    if (model.includes('claude-instant')) {
      return '轻量快速的 Claude 模型';
    }
    return 'Anthropic Claude 模型';
  }

  /**
   * 验证 API Key 格式
   */
  static validateApiKey (apiKey) {
    if (!apiKey) return false;
    // Anthropic API Key 格式: sk-ant-...
    return apiKey.startsWith('sk-ant-') && apiKey.length > 20;
  }
}

module.exports = AnthropicProvider;
