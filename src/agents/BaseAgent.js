class BaseAgent {
  constructor(provider, options = {}) {
    this.provider = provider;
    this.name = options.name || 'BaseAgent';
    this.role = options.role || 'assistant';
    this.systemPrompt = options.systemPrompt || '';
    this.temperature = options.temperature !== undefined ? options.temperature : 0.7;
    this.maxTokens = options.maxTokens || 2048;
    this.history = [];
  }

  _buildSystemPrompt() {
    return this.systemPrompt;
  }

  async send(message, options = {}) {
    const messages = [...this.history, { role: 'user', content: message }];
    const systemPrompt = this._buildSystemPrompt();

    const result = await this.provider.chat(messages, {
      systemPrompt: systemPrompt,
      temperature: options.temperature !== undefined ? options.temperature : this.temperature,
      maxTokens: options.maxTokens || this.maxTokens,
      useSmallModel: options.useSmallModel || false
    });

    if (options.keepHistory !== false) {
      this.history.push({ role: 'user', content: message });
      this.history.push({ role: 'assistant', content: result.content });
    }

    return result;
  }

  async sendOnce(message, options = {}) {
    return this.send(message, { ...options, keepHistory: false });
  }

  clearHistory() {
    this.history = [];
  }

  _extractJson(text) {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (e) {}
    }

    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]);
      } catch (e) {}
    }

    return null;
  }
}

module.exports = BaseAgent;
