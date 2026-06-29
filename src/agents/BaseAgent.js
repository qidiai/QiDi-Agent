const Ajv = require('ajv');
const ajv = new Ajv();

class BaseAgent {
  constructor(provider, options = {}) {
    this.provider = provider;
    this.name = options.name || 'BaseAgent';
    this.role = options.role || 'assistant';
    this.systemPrompt = options.systemPrompt || '';
    this.temperature = options.temperature !== undefined ? options.temperature : 0.7;
    this.maxTokens = options.maxTokens || 2048;
    this.history = [];
    this.maxRetries = options.maxRetries || 3;
    this.enableThinkingChain = options.enableThinkingChain !== false;
    this.enableStructuredOutput = options.enableStructuredOutput !== false;
    this.schema = options.schema || null;

    this.modelOptimizationConfig = {
      haiku: {
        temperature: 0.3,
        thinkingEnabled: false,
        strategy: 'skip',
        description: '轻量模型，跳过思考以提升响应速度'
      },
      sonnet: {
        temperature: 0.5,
        thinkingEnabled: true,
        strategy: 'adaptive',
        budgetTokens: 32000,
        description: '平衡模型，启用自适应思考'
      },
      opus: {
        temperature: 0.7,
        thinkingEnabled: true,
        strategy: 'adaptive',
        budgetTokens: 32000,
        description: '高端模型，启用深度思考'
      },
      gpt4: {
        temperature: 0.7,
        thinkingEnabled: true,
        strategy: 'adaptive',
        budgetTokens: 32000,
        description: 'GPT-4系列，启用深度思考'
      },
      gpt3: {
        temperature: 0.6,
        thinkingEnabled: true,
        strategy: 'legacy',
        budgetTokens: 16384,
        description: 'GPT-3系列，启用标准思考'
      },
      qwen: {
        temperature: 0.6,
        thinkingEnabled: true,
        strategy: 'legacy',
        budgetTokens: 16384,
        description: 'Qwen系列，启用标准思考'
      },
      llama: {
        temperature: 0.5,
        thinkingEnabled: true,
        strategy: 'legacy',
        budgetTokens: 16384,
        description: 'Llama系列，启用标准思考'
      },
      mistral: {
        temperature: 0.5,
        thinkingEnabled: true,
        strategy: 'legacy',
        budgetTokens: 16384,
        description: 'Mistral系列，启用标准思考'
      }
    };
  }

  _buildSystemPrompt() {
    let prompt = this.systemPrompt;
    if (this.enableThinkingChain) {
      prompt += `

思考链要求：
1. 在输出最终结果前，请先输出你的思考过程（用 <thinking>...</thinking> 包裹）
2. 思考过程应包含：问题分析、关键决策点、可能的方案对比
3. 最终结果必须基于思考过程得出，不得凭空捏造
4. 思考过程仅用于辅助理解，不会作为最终结果使用`;
    }
    if (this.enableStructuredOutput && this.schema) {
      prompt += `

结构化输出要求：
1. 必须严格按照以下JSON Schema输出：
${JSON.stringify(this.schema, null, 2)}
2. 输出必须是合法的JSON格式，不能包含额外文字
3. 如果无法生成符合Schema的输出，请明确说明原因`;
    }
    return prompt;
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

  async sendWithRetry(message, options = {}) {
    const maxAttempts = options.maxRetries || this.maxRetries;
    const modelName = options.modelName || (this.provider && this.provider.model) || null;
    const modelOpt = this.getModelOptimization(modelName);

    let temperatures;
    if (modelOpt && modelOpt.strategy === 'skip') {
      temperatures = [modelOpt.temperature, modelOpt.temperature, modelOpt.temperature];
    } else if (modelOpt) {
      temperatures = [modelOpt.temperature, Math.max(0.2, modelOpt.temperature - 0.3), Math.max(0.3, modelOpt.temperature - 0.2)];
    } else {
      temperatures = [this.temperature, 0.2, 0.5];
    }
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const optimizedOptions = this.buildOptimizedOptions(modelName, {
          ...options,
          temperature: temperatures[attempt % temperatures.length]
        });

        const result = await this.sendOnce(message, optimizedOptions);

        if (this.enableStructuredOutput) {
          const parsed = this._extractJson(result.content);
          if (parsed && this.schema) {
            const validate = ajv.compile(this.schema);
            const valid = validate(parsed);
            if (valid) {
              return { ...result, parsed, modelOptimization: modelOpt };
            }
          }
        } else {
          return { ...result, modelOptimization: modelOpt };
        }
      } catch (e) {
        if (attempt === maxAttempts - 1) throw e;
      }
    }

    throw new Error(`发送失败，已重试 ${maxAttempts} 次`);
  }

  async sendStructured(message, schema, options = {}) {
    const originalSchema = this.schema;
    this.schema = schema;
    
    try {
      const result = await this.sendWithRetry(message, options);
      
      if (result.parsed) {
        return result.parsed;
      }
      
      const parsed = this._extractJson(result.content);
      if (parsed) {
        return parsed;
      }

      if (this.maxRetries > 0) {
        const repairResult = await this._repairOutput(result.content, schema);
        if (repairResult) {
          return repairResult;
        }
      }

      throw new Error('无法解析结构化输出');
    } finally {
      this.schema = originalSchema;
    }
  }

  async _repairOutput(content, schema) {
    try {
      const repairPrompt = `以下输出不符合预期的JSON Schema，请修复：

原始输出：
${content}

目标Schema：
${JSON.stringify(schema, null, 2)}

请分析问题并输出符合Schema的JSON，只输出JSON，不要其他文字。`;

      const result = await this.sendOnce(repairPrompt, { temperature: 0.1 });
      return this._extractJson(result.content);
    } catch (e) {
      return null;
    }
  }

  clearHistory() {
    this.history = [];
  }

  detectModelFamily(modelName) {
    if (!modelName) return null;
    const lower = modelName.toLowerCase();
    
    if (lower.includes('haiku')) return 'haiku';
    if (lower.includes('sonnet')) return 'sonnet';
    if (lower.includes('opus')) return 'opus';
    if (lower.includes('gpt-4') || lower.includes('gpt4')) return 'gpt4';
    if (lower.includes('gpt-3') || lower.includes('gpt3') || lower.includes('turbo')) return 'gpt3';
    if (lower.includes('qwen')) return 'qwen';
    if (lower.includes('llama')) return 'llama';
    if (lower.includes('mistral')) return 'mistral';
    
    return null;
  }

  getModelOptimization(modelName) {
    const family = this.detectModelFamily(modelName);
    if (family && this.modelOptimizationConfig[family]) {
      return this.modelOptimizationConfig[family];
    }
    return null;
  }

  buildOptimizedOptions(modelName, options = {}) {
    const opt = this.getModelOptimization(modelName);
    if (!opt) return options;

    const optimized = { ...options };
    
    if (opt.strategy === 'skip') {
      optimized.temperature = opt.temperature;
      optimized.thinkingEnabled = false;
    } else if (opt.strategy === 'adaptive') {
      optimized.temperature = opt.temperature;
      optimized.thinkingEnabled = true;
      optimized.budgetTokens = opt.budgetTokens;
      optimized.maxTokens = opt.budgetTokens * 2;
    } else if (opt.strategy === 'legacy') {
      optimized.temperature = opt.temperature;
      optimized.thinkingEnabled = true;
      optimized.budgetTokens = opt.budgetTokens;
      optimized.maxTokens = opt.budgetTokens * 2;
    }

    return optimized;
  }

  _extractJson(text) {
    const thinkingMatch = text.match(/<thinking>[\s\S]*?<\/thinking>/);
    let cleanText = thinkingMatch ? text.replace(thinkingMatch[0], '') : text;

    const jsonMatch = cleanText.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (e) {}
    }

    const braceMatch = cleanText.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]);
      } catch (e) {}
    }

    const bracketMatch = cleanText.match(/\[[\s\S]*\]/);
    if (bracketMatch) {
      try {
        return JSON.parse(bracketMatch[0]);
      } catch (e) {}
    }

    return null;
  }

  _extractThinking(text) {
    const thinkingMatch = text.match(/<thinking>([\s\S]*?)<\/thinking>/);
    return thinkingMatch ? thinkingMatch[1].trim() : null;
  }

  async generateThinkingChain(prompt) {
    const thinkingPrompt = `请分析以下问题并输出思考过程：

${prompt}

请输出详细的思考过程，包括：
1. 问题分析
2. 关键决策点
3. 可能的方案对比
4. 最终结论的理由

用 <thinking>...</thinking> 包裹你的思考过程。`;

    const result = await this.sendOnce(thinkingPrompt, { temperature: 0.3 });
    return this._extractThinking(result.content) || result.content;
  }
}

module.exports = BaseAgent;
module.exports.ajv = ajv;