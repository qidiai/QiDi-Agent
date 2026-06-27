const TokenCounter = require('./TokenCounter');

class ModelRouter {
  constructor(options = {}) {
    this.options = options;
    this.tokenCounter = new TokenCounter();
    
    this.models = {
      large: {
        name: options.largeModel || process.env.OLLAMA_MODEL || 'qwen2.5:7b',
        costFactor: 1.0,
        capabilities: ['complex', 'creative', 'review', 'planning', 'integration']
      },
      small: {
        name: options.smallModel || process.env.OLLAMA_MODEL_SMALL || 'qwen2.5:3b',
        costFactor: 0.4,
        capabilities: ['simple', 'routine', 'formatting', 'extraction']
      }
    };

    this.taskProfiles = {
      splitter: {
        defaultSize: 'large',
        reason: '任务拆分需要复杂推理'
      },
      codeWriter: {
        defaultSize: 'large',
        adaptive: true,
        threshold: 1500,
        reason: '代码编写需要创造性'
      },
      codeReviewer: {
        defaultSize: 'large',
        reason: '代码审查需要深度分析'
      },
      tester: {
        defaultSize: 'small',
        reason: '测试用例设计相对简单'
      },
      qualityChecker: {
        defaultSize: 'large',
        reason: '质量审核需要深度分析'
      }
    };

    this.stats = {
      largeCalls: 0,
      smallCalls: 0,
      savedTokens: 0
    };
  }

  selectModel(agentName, task, context = {}) {
    const profile = this.taskProfiles[agentName] || { defaultSize: 'large' };

    const estimatedPromptTokens = this._estimatePromptTokens(task, context);
    const taskComplexity = this._estimateTaskComplexity(task);
    const hasComplexDependencies = context.previousCode && 
      this.tokenCounter.estimateTokens(context.previousCode) > 2000;

    let selectedSize = profile.defaultSize;

    if (profile.adaptive) {
      if (estimatedPromptTokens < profile.threshold && taskComplexity === 'low') {
        selectedSize = 'small';
      }
    }

    if (hasComplexDependencies) {
      selectedSize = 'large';
    }

    if (taskComplexity === 'high' || task.estimatedComplexity === 'high') {
      selectedSize = 'large';
    }

    if (context.constraints && Object.keys(context.constraints).length > 3) {
      selectedSize = 'large';
    }

    const model = this.models[selectedSize];
    
    this.stats[selectedSize === 'large' ? 'largeCalls' : 'smallCalls']++;
    if (selectedSize === 'small') {
      this.stats.savedTokens += Math.round(estimatedPromptTokens * 0.6);
    }

    return {
      model: model.name,
      size: selectedSize,
      costFactor: model.costFactor,
      reason: this._getSelectionReason(selectedSize, estimatedPromptTokens, taskComplexity)
    };
  }

  _estimatePromptTokens(task, context) {
    let total = 0;
    
    total += this.tokenCounter.estimateTokens(task.title || '');
    total += this.tokenCounter.estimateTokens(task.description || '');
    total += this.tokenCounter.estimateTokens(task.acceptanceCriteria || '');
    
    if (context.previousCode) {
      total += this.tokenCounter.estimateTokens(context.previousCode);
    }
    
    if (context.constraints) {
      total += this.tokenCounter.estimateTokens(JSON.stringify(context.constraints));
    }

    return total;
  }

  _estimateTaskComplexity(task) {
    const desc = (task.description || '').toLowerCase();
    
    const highKeywords = ['集成', '整合', '系统', '架构', '重构', '优化', '复杂', '综合'];
    const mediumKeywords = ['实现', '设计', '编写', '开发', '功能'];
    const lowKeywords = ['定义', '初始化', '简单', '基础', '生成'];

    if (highKeywords.some(k => desc.includes(k))) {
      return 'high';
    }
    
    if (lowKeywords.some(k => desc.includes(k))) {
      return 'low';
    }
    
    return 'medium';
  }

  _getSelectionReason(size, tokens, complexity) {
    if (size === 'small') {
      return `简单任务 (${complexity}), 输入约 ${tokens} tokens`;
    } else {
      return `复杂任务 (${complexity}), 输入约 ${tokens} tokens`;
    }
  }

  shouldUseSmallModel(task, context = {}) {
    const tokens = this._estimatePromptTokens(task, context);
    const complexity = this._estimateTaskComplexity(task);
    
    return tokens < 1000 && complexity === 'low';
  }

  getStats() {
    return {
      ...this.stats,
      totalCalls: this.stats.largeCalls + this.stats.smallCalls,
      smallModelRate: Math.round(
        (this.stats.smallCalls / (this.stats.largeCalls + this.stats.smallCalls)) * 100
      ) || 0
    };
  }

  getReport() {
    const stats = this.getStats();
    
    let report = `\n📊 模型选择报告\n`;
    report += `═══════════════════════════════════════════\n`;
    report += `大模型调用: ${stats.largeCalls} 次\n`;
    report += `小模型调用: ${stats.smallCalls} 次\n`;
    report += `小模型比例: ${stats.smallModelRate}%\n`;
    report += `节省 tokens: ${stats.savedTokens.toLocaleString()}\n`;
    report += `═══════════════════════════════════════════\n`;
    
    return report;
  }

  reset() {
    this.stats = {
      largeCalls: 0,
      smallCalls: 0,
      savedTokens: 0
    };
  }

  setModel(size, model) {
    if (this.models[size]) {
      this.models[size].name = model;
    }
  }

  setProfile(agentName, profile) {
    this.taskProfiles[agentName] = profile;
  }

  getAvailableModels() {
    return Object.entries(this.models).map(([size, model]) => ({
      size,
      name: model.name,
      costFactor: model.costFactor
    }));
  }
}

module.exports = ModelRouter;