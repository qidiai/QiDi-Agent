const crypto = require('crypto');

class TokenCounter {
  constructor (options = {}) {
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
    this.encoder = null;
    this._tryLoadEncoder();
  }

  _tryLoadEncoder () {
    try {
      const { Tiktoken } = require('tiktoken');
      this.encoder = new Tiktoken('cl100k_base');
    } catch (e) {}
  }

  estimateTokens (text) {
    if (text == null) return 0;

    const textStr = typeof text === 'string' ? text : '';
    if (!textStr) return 0;

    if (this.encoder) {
      try {
        return this.encoder.encode(textStr).length;
      } catch (e) {}
    }

    return this._estimateFallback(textStr);
  }

  _estimateFallback (text) {
    const len = text.length;
    if (len > 100000) {
      return this._estimateLargeText(text);
    }

    let cjkChars = 0;
    let wordChars = 0;
    let numbers = 0;
    let inNumber = false;
    let whitespace = 0;
    let punctuation = 0;
    let codeChars = 0;

    const codePunctuation = '{}[]();,.<>';
    const punctuationSet = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
    const keywords = new Set(['function', 'def', 'class', 'import', 'from', 'export', 'return', 'if', 'else', 'for', 'while', 'try', 'catch', 'throw', 'const', 'let', 'var', 'async', 'await']);

    let currentWord = '';

    for (let i = 0; i < len; i++) {
      const char = text[i];
      const code = char.charCodeAt(0);

      if (code >= 0x4e00 && code <= 0x9fff) {
        cjkChars++;
        currentWord = '';
      } else if (code >= 0x3400 && code <= 0x4dbf) {
        cjkChars++;
        currentWord = '';
      } else if (code >= 0xac00 && code <= 0xd7af) {
        cjkChars++;
        currentWord = '';
      } else if (code >= 0x3040 && code <= 0x30ff) {
        cjkChars++;
        currentWord = '';
      } else if ((code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a)) {
        wordChars++;
        currentWord += char.toLowerCase();
      } else if (code >= 0x30 && code <= 0x39) {
        if (!inNumber) {
          numbers++;
          inNumber = true;
        }
        currentWord = '';
      } else if (code === 0x20 || code === 0x9 || code === 0xa || code === 0xd) {
        whitespace++;
        this._checkKeyword(currentWord, keywords, codeChars);
        currentWord = '';
        inNumber = false;
      } else if (punctuationSet.has(char)) {
        punctuation++;
        if (codePunctuation.includes(char)) {
          codeChars++;
        }
        this._checkKeyword(currentWord, keywords, codeChars);
        currentWord = '';
        inNumber = false;
      } else {
        currentWord = '';
        inNumber = false;
      }
    }

    this._checkKeyword(currentWord, keywords, codeChars);

    const avgWordLength = wordChars > 0 ? Math.max(2, Math.round(wordChars / (wordChars / 4))) : 4;
    const wordTokens = Math.ceil(wordChars / avgWordLength);
    const numberTokens = Math.ceil(numbers * 0.5);
    const whitespaceTokens = Math.ceil(whitespace / 4);
    const punctuationTokens = Math.ceil(punctuation / 3);
    const codeTokens = Math.round(codeChars * 0.5);

    const totalCJK = Math.ceil((cjkChars * 1.5) + codeTokens);
    const totalNonCJK = wordTokens + numberTokens + whitespaceTokens + punctuationTokens;

    return Math.max(totalCJK, totalNonCJK, Math.ceil(len / 4));
  }

  _checkKeyword (word, keywords, codeChars) {
    if (word.length > 2 && word.length < 20 && keywords.has(word)) {
      codeChars += 2;
    }
  }

  _estimateLargeText (text) {
    const len = text.length;
    const sampleSize = 50000;
    const numSamples = Math.min(10, Math.ceil(len / sampleSize));
    let totalTokens = 0;

    for (let i = 0; i < numSamples; i++) {
      const start = (i * len) / numSamples;
      const end = Math.min(start + sampleSize, len);
      const sample = text.substring(start, end);
      totalTokens += this._estimateFallback(sample);
    }

    return Math.round((totalTokens / numSamples) * (len / sampleSize));
  }

  record (agentName, taskId, prompt, response, options = {}) {
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

  recordCacheHit (agentName, taskId) {
    this.stats.cacheHits++;
    if (!this.stats.byAgent[agentName]) {
      this.stats.byAgent[agentName] = { total: 0, prompt: 0, completion: 0, calls: 0, cacheHits: 0 };
    }
    this.stats.byAgent[agentName].cacheHits++;
  }

  recordCacheMiss (agentName, taskId) {
    this.stats.cacheMisses++;
  }

  getStats () {
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

  getReport () {
    const stats = this.getStats();

    let report = '\n📊 Token 使用报告\n';
    report += '═══════════════════════════════════════════\n';
    report += `总消耗: ${stats.total.toLocaleString()} tokens\n`;
    report += `  - 输入: ${stats.prompt.toLocaleString()} tokens\n`;
    report += `  - 输出: ${stats.completion.toLocaleString()} tokens\n`;
    report += `平均每次: ${stats.avgTokensPerCall} tokens\n`;
    report += `缓存命中率: ${stats.cacheRate}%\n`;
    report += '═══════════════════════════════════════════\n';

    report += '\n各 Agent 消耗:\n';
    for (const [agent, data] of Object.entries(stats.byAgent)) {
      report += `  ${agent}: ${data.total.toLocaleString()} tokens (${data.calls} 次调用)\n`;
      if (data.cacheHits) {
        report += `    缓存命中: ${data.cacheHits} 次\n`;
      }
    }

    return report;
  }

  reset () {
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

  estimatePromptSize (promptObj) {
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

  shouldCompress (text, threshold = 2000) {
    const tokens = this.estimateTokens(text);
    return tokens > threshold;
  }
}

module.exports = TokenCounter;
