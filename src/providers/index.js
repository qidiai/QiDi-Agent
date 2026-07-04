const OllamaProvider = require('./OllamaProvider');
const OpenAIProvider = require('./OpenAIProvider');
const AnthropicProvider = require('./AnthropicProvider');

class ProviderFactory {
  static create (type = null, config = {}) {
    const providerType = type || process.env.MODEL_PROVIDER || 'ollama';

    switch (providerType.toLowerCase()) {
    case 'ollama':
      return new OllamaProvider(config);
    case 'openai':
    case 'openai_compatible':
      return new OpenAIProvider(config);
    case 'deepseek':
      return new OpenAIProvider({
        apiKey: config.apiKey || process.env.DEEPSEEK_API_KEY,
        baseUrl: config.baseUrl || process.env.DEEPSEEK_BASE_URL,
        model: config.model || process.env.DEEPSEEK_MODEL
      });
    case 'anthropic':
    case 'claude':
      return new AnthropicProvider(config);
    default:
      throw new Error(`未知的模型提供商: ${providerType}。支持: ollama, openai, deepseek, anthropic`);
    }
  }

  static async detectAvailable () {
    const available = [];

    // 检测 Ollama
    try {
      const ollama = new OllamaProvider();
      if (await ollama.checkConnection()) {
        available.push({
          type: 'ollama',
          name: 'Ollama (本地)',
          provider: ollama
        });
      }
    } catch (e) {
      // Ollama 不可用
    }

    // 检测 OpenAI
    if (process.env.OPENAI_API_KEY) {
      available.push({ type: 'openai', name: 'OpenAI API' });
    }

    // 检测 DeepSeek
    if (process.env.DEEPSEEK_API_KEY) {
      available.push({ type: 'deepseek', name: 'DeepSeek API' });
    }

    // 检测 Anthropic
    if (process.env.ANTHROPIC_API_KEY) {
      const anthropic = new AnthropicProvider();
      const result = await anthropic.checkConnection();
      if (result.success) {
        available.push({
          type: 'anthropic',
          name: 'Anthropic Claude',
          model: result.model
        });
      }
    }

    return available;
  }

  /**
   * 获取所有支持的 Provider 类型
   */
  static getSupportedTypes () {
    return [
      {
        type: 'ollama',
        name: 'Ollama (本地)',
        description: '本地运行的 LLM 模型，无需 API Key',
        requiresApiKey: false,
        models: '自定义（qwen2.5, llama3, mistral 等）'
      },
      {
        type: 'openai',
        name: 'OpenAI API',
        description: 'GPT-4、GPT-3.5 等模型',
        requiresApiKey: true,
        models: 'gpt-4, gpt-4-turbo, gpt-3.5-turbo'
      },
      {
        type: 'deepseek',
        name: 'DeepSeek API',
        description: 'DeepSeek 云端模型',
        requiresApiKey: true,
        models: 'deepseek-chat, deepseek-r1'
      },
      {
        type: 'anthropic',
        name: 'Anthropic Claude',
        description: 'Claude 3.5 Sonnet、Claude 3 Opus 等模型',
        requiresApiKey: true,
        models: 'claude-3-5-sonnet, claude-3-opus, claude-3-haiku'
      }
    ];
  }
}

module.exports = ProviderFactory;
