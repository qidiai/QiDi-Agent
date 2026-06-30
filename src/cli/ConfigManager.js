const fs = require('fs');
const path = require('path');

class ConfigManager {
  constructor () {
    this.configDir = path.join(process.env.HOME || process.env.USERPROFILE, '.qidi');
    this.configFile = path.join(this.configDir, 'config.json');
    this.defaultConfig = {
      executionMode: 'privacy',
      provider: 'ollama',
      model: '',
      apiKey: '',
      apiBase: '',
      scanOnStart: true,
      autoModeEnabled: false,
      rejectThreshold: 3,
      thinkingEnabled: true,
      maxRetries: 3,
      temperature: 0.7
    };
  }

  getConfig () {
    try {
      if (fs.existsSync(this.configFile)) {
        const content = fs.readFileSync(this.configFile, 'utf-8');
        const config = JSON.parse(content);
        return { ...this.defaultConfig, ...config };
      }
    } catch (e) {
      console.warn('[ConfigManager] 读取配置文件失败:', e.message);
    }
    return { ...this.defaultConfig };
  }

  saveConfig (config) {
    try {
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }
      const cleanConfig = { ...this.defaultConfig, ...config };
      fs.writeFileSync(this.configFile, JSON.stringify(cleanConfig, null, 2), 'utf-8');
      return true;
    } catch (e) {
      console.error('[ConfigManager] 保存配置文件失败:', e.message);
      return false;
    }
  }

  clearConfig () {
    try {
      if (fs.existsSync(this.configFile)) {
        fs.unlinkSync(this.configFile);
      }
      return true;
    } catch (e) {
      console.error('[ConfigManager] 清除配置文件失败:', e.message);
      return false;
    }
  }

  hasValidConfig () {
    const config = this.getConfig();
    if (config.provider === 'ollama') {
      return true;
    }
    if (config.provider === 'openai' || config.provider === 'anthropic' ||
        config.provider === 'doubao' || config.provider === 'qianfan' ||
        config.provider === 'qwen' || config.provider === 'deepseek' ||
        config.provider === 'moonshot' || config.provider === 'minimax') {
      return config.apiKey && config.apiKey.length > 0;
    }
    return false;
  }

  updateConfig (key, value) {
    const config = this.getConfig();
    config[key] = value;
    return this.saveConfig(config);
  }

  getConfigSummary () {
    const config = this.getConfig();
    const summary = {
      executionMode: config.executionMode,
      provider: config.provider,
      model: config.model || '未设置',
      apiKey: config.apiKey ? '已设置' : '未设置',
      apiBase: config.apiBase || '默认',
      scanOnStart: config.scanOnStart
    };
    return summary;
  }

  getModeLabel (mode) {
    const labels = {
      privacy: '🔒 隐私模式',
      quality: '✨ 高质量模式',
      efficiency: '⚡ 高效模式'
    };
    return labels[mode] || mode;
  }

  getProviderLabel (provider) {
    const labels = {
      ollama: '🖥️ Ollama (本地)',
      openai: '☁️ OpenAI',
      anthropic: '☁️ Anthropic Claude',
      doubao: '☁️ 字节跳动 豆包',
      qianfan: '☁️ 百度千帆',
      qwen: '☁️ 阿里通义千问',
      deepseek: '☁️ DeepSeek',
      moonshot: '☁️ Moonshot',
      minimax: '☁️ MiniMax'
    };
    return labels[provider] || provider;
  }
}

module.exports = ConfigManager;
