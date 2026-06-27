const fs = require('fs');
const path = require('path');
const createLogger = require('../utils/Logger');

const logger = createLogger('AgentHub');

class AgentHub {
  constructor(options = {}) {
    this.configDir = options.configDir || './config';
    this.agents = new Map();
    this.config = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      return this.agents;
    }

    const configPath = path.join(this.configDir, 'agents.json');
    
    if (!fs.existsSync(configPath)) {
      await this._createDefaultConfig(configPath);
    }

    this.config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    
    for (const [name, agentConfig] of Object.entries(this.config.agents)) {
      if (agentConfig.enabled !== false) {
        const provider = this._createProvider(agentConfig);
        this.agents.set(name, {
          config: agentConfig,
          provider: provider,
          status: 'ready'
        });
      }
    }

    this.initialized = true;
    return this.agents;
  }

  async _createDefaultConfig(configPath) {
    const defaultConfig = {
      version: '1.0',
      description: '多 Agent 配置文件',
      defaultAgent: 'ollama',
      agents: {
        ollama: {
          enabled: true,
          provider: 'ollama',
          name: 'Ollama 本地模型',
          description: '本地部署的 Ollama 模型，支持多种开源模型',
          config: {
            baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
            model: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
            timeout: 120000
          }
        },
        openai: {
          enabled: false,
          provider: 'openai',
          name: 'OpenAI GPT',
          description: 'OpenAI GPT 系列模型',
          config: {
            apiKey: process.env.OPENAI_API_KEY || '',
            baseURL: 'https://api.openai.com/v1',
            model: process.env.OPENAI_MODEL || 'gpt-4',
            timeout: 60000
          }
        },
        anthropic: {
          enabled: false,
          provider: 'anthropic',
          name: 'Claude',
          description: 'Anthropic Claude 系列模型',
          config: {
            apiKey: process.env.ANTHROPIC_API_KEY || '',
            model: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet',
            timeout: 60000
          }
        },
        deepseek: {
          enabled: false,
          provider: 'openai',
          name: 'DeepSeek',
          description: 'DeepSeek 系列模型',
          config: {
            apiKey: process.env.DEEPSEEK_API_KEY || '',
            baseURL: 'https://api.deepseek.com/v1',
            model: 'deepseek-coder',
            timeout: 60000
          }
        }
      },
      dispatch: {
        mode: 'parallel',
        timeout: 300000,
        compareResults: true,
        selectBest: true
      }
    };

    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
    logger.info(`✅ 配置文件已创建: ${configPath}`);
    logger.info('📝 请编辑配置文件启用需要的 Agent');
  }

  _createProvider(agentConfig) {
    const ProviderFactory = require('../providers');
    
    try {
      const provider = ProviderFactory.create(agentConfig.provider, agentConfig.config);
      return provider;
    } catch (e) {
      logger.error(`❌ 创建 Provider ${agentConfig.provider} 失败: ${e.message}`);
      return null;
    }
  }

  getAgent(name) {
    return this.agents.get(name);
  }

  getAllAgents() {
    return Array.from(this.agents.entries()).map(([name, agent]) => ({
      name,
      provider: agent.config.provider,
      name_display: agent.config.name,
      description: agent.config.description,
      status: agent.status,
      enabled: agent.config.enabled
    }));
  }

  getEnabledAgents() {
    return Array.from(this.agents.entries())
      .filter(([name, agent]) => agent.config.enabled !== false && agent.provider)
      .map(([name, agent]) => ({
        name,
        provider: agent.provider,
        config: agent.config
      }));
  }

  async checkAllConnections() {
    const results = {};
    
    for (const [name, agent] of this.agents.entries()) {
      if (!agent.provider) {
        results[name] = { status: 'error', message: 'Provider 未初始化' };
        continue;
      }

      try {
        const connected = await agent.provider.checkConnection();
        results[name] = {
          status: connected ? 'online' : 'offline',
          provider: agent.config.provider
        };
      } catch (e) {
        results[name] = {
          status: 'error',
          message: e.message
        };
      }
    }

    return results;
  }

  getConfig() {
    return this.config;
  }

  updateAgentConfig(name, updates) {
    if (this.agents.has(name)) {
      const agent = this.agents.get(name);
      agent.config = { ...agent.config, ...updates };
      
      const configPath = path.join(this.configDir, 'agents.json');
      this.config.agents[name] = agent.config;
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2), 'utf-8');
      
      return true;
    }
    return false;
  }

  enableAgent(name) {
    return this.updateAgentConfig(name, { enabled: true });
  }

  disableAgent(name) {
    return this.updateAgentConfig(name, { enabled: false });
  }

  reload() {
    this.agents.clear();
    this.initialized = false;
    return this.initialize();
  }
}

module.exports = AgentHub;