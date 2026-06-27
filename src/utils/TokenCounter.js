const crypto = require('crypto');

class TokenCounter {
  constructor(options = {}) {
    this.options = options;
    this.stats = {
      total: 0,
      prompt: 0,
      completion: 0,
      byAgent: {},
      byTask: {},
      cacheHits: 0,
      cacheMisses: 0
    };
    this.history = [];
    this.maxHistory = options.maxHistory || 100;
  }

  estimateTokens(text) {
    if (!text) return 0;
    
    const textStr = typeof text === 'string' ? text : JSON.stringify(text);
    
    const chineseChars = (textStr.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishWords = (textStr.match(/[a-zA-Z]+/g) || []).length;
    const codeChars = textStr.length - chineseChars - (textStr.match(/[a-zA-Z\s]+/g) || []).join('').length;
    
    const tokens = Math.ceil(chineseChars * 1.5 + englishWords + codeChars * 0.5);
    
    return tokens;
  }

  record(agentName, taskId, prompt, response, options = {}) {
    const promptTokens = this.estimateTokens(prompt);
    const responseTokens = this.estimateTokens(response);
    const totalTokens = promptTokens + responseTokens;

    this.stats.total += totalTokens;
    this.stats.prompt += promptTokens;
    this.stats.completion += responseTokens;

    if (!this.stats.byAgent[agentName]) {
      this.stats.byAgent[agentName] = { total: 0, prompt: 0, completion: 0, calls: 0 };
    }
    this.stats.byAgent[agentName].total += totalTokens;
    this.stats.byAgent[agentName].prompt += promptTokens;
    this.stats.byAgent[agentName].completion += responseTokens;
    this.stats.byAgent[agentName].calls++;

    if (taskId) {
      if (!this.stats.byTask[taskId]) {
        this.stats.byTask[taskId] = { total: 0, calls: 0 };
      }
      this.stats.byTask[taskId].total += totalTokens;
      this.stats.byTask[taskId].calls++;
    }

    const record = {
      timestamp: Date.now(),
      agent: agentName,
      taskId,
      promptTokens,
      responseTokens,
      totalTokens,
      cached: options.cached || false,
      model: options.model || 'unknown'
    };

    this.history.push(record);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    return record;
  }

  recordCacheHit(agentName, taskId) {
    this.stats.cacheHits++;
    if (!this.stats.byAgent[agentName]) {
      this.stats.byAgent[agentName] = { total: 0, prompt: 0, completion: 0, calls: 0, cacheHits: 0 };
    }
    this.stats.byAgent[agentName].cacheHits++;
  }

  recordCacheMiss(agentName, taskId) {
    this.stats.cacheMisses++;
  }

  getStats() {
    return {
      ...this.stats,
      cacheRate: this.stats.cacheHits > 0 
        ? Math.round((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 100)
        : 0,
      avgTokensPerCall: this.stats.total > 0 && Object.values(this.stats.byAgent).reduce((sum, a) => sum + a.calls, 0) > 0
        ? Math.round(this.stats.total / Object.values(this.stats.byAgent).reduce((sum, a) => sum + a.calls, 0))
        : 0
    };
  }

  getReport() {
    const stats = this.getStats();
    
    let report = `\n📊 Token 使用报告\n`;
    report += `═══════════════════════════════════════════\n`;
    report += `总消耗: ${stats.total.toLocaleString()} tokens\n`;
    report += `  - 输入: ${stats.prompt.toLocaleString()} tokens\n`;
    report += `  - 输出: ${stats.completion.toLocaleString()} tokens\n`;
    report += `平均每次: ${stats.avgTokensPerCall} tokens\n`;
    report += `缓存命中率: ${stats.cacheRate}%\n`;
    report += `═══════════════════════════════════════════\n`;
    
    report += `\n各 Agent 消耗:\n`;
    for (const [agent, data] of Object.entries(stats.byAgent)) {
      report += `  ${agent}: ${data.total.toLocaleString()} tokens (${data.calls} 次调用)\n`;
      if (data.cacheHits) {
        report += `    缓存命中: ${data.cacheHits} 次\n`;
      }
    }
    
    return report;
  }

  reset() {
    this.stats = {
      total: 0,
      prompt: 0,
      completion: 0,
      byAgent: {},
      byTask: {},
      cacheHits: 0,
      cacheMisses: 0
    };
    this.history = [];
  }

  estimatePromptSize(promptObj) {
    let total = 0;
    for (const [key, value] of Object.entries(promptObj)) {
      if (typeof value === 'string') {
        total += this.estimateTokens(value);
      } else if (Array.isArray(value)) {
        value.forEach(item => {
          total += this.estimateTokens(item);
        });
      }
    }
    return total;
  }

  shouldCompress(text, threshold = 2000) {
    const tokens = this.estimateTokens(text);
    return tokens > threshold;
  }
}

module.exports = TokenCounter;