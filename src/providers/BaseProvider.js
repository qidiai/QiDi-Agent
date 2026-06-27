class BaseProvider {
  constructor(config = {}) {
    this.config = config;
    this.name = 'base';
  }

  async chat(messages, options = {}) {
    throw new Error('chat() 必须由子类实现');
  }

  async generate(prompt, options = {}) {
    const messages = [{ role: 'user', content: prompt }];
    return this.chat(messages, options);
  }

  async checkConnection() {
    try {
      const result = await this.generate('你好，请回复"OK"', { maxTokens: 10 });
      return result && result.content && result.content.length > 0;
    } catch (e) {
      return false;
    }
  }
}

module.exports = BaseProvider;
