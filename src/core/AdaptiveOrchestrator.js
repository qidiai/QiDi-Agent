/**
 * 自适应智能编排器（AdaptiveOrchestrator）
 *
 * 核心理念：让系统自动学习"什么任务用什么工具/策略最好"，
 * 用户可选择启用此模式（auto），或选择手动搭配工具（manual）。
 *
 * 三种编排模式：
 *  - auto:     系统自动分析任务特征 → 推荐工具组合 + 策略 + 模式
 *  - manual:   用户自选工具列表 + 策略 + 模式（完全自定义）
 *  - hybrid:   系统推荐 + 用户确认（推荐方案 + 允许覆盖）
 *
 * 推荐依据：
 *  1. 任务特征（语言、复杂度、类型、规模、领域）
 *  2. 工具能力档案（AgentCapabilityTree 10级评估）
 *  3. 历史执行记录（ToolLearning 学习数据）
 *  4. 当前工具在线状态（实时探测）
 *  5. 用户偏好（隐私敏感度、质量要求、效率要求）
 */

const AgentCapabilityTree = require('./AgentCapabilityTree');
const ToolLearning = require('./ToolLearning');

class AdaptiveOrchestrator {
  constructor (options = {}) {
    this.options = options;
    this.capabilityTree = options.capabilityTree || new AgentCapabilityTree();
    this.toolLearning = options.toolLearning || new ToolLearning({
      learningDir: options.learningDir || './config/tool_learning'
    });

    // 编排模式：auto（自适应）/ manual（手动）/ hybrid（混合）
    this.orchestrationMode = options.orchestrationMode || 'hybrid';

    // 用户偏好（默认值，可被覆盖）
    this.userPreferences = {
      privacySensitivity: options.privacySensitivity || 'medium', // low/medium/high
      qualityPriority: options.qualityPriority || 'high', // low/medium/high
      efficiencyPriority: options.efficiencyPriority || 'medium', // low/medium/high
      maxParallelTools: options.maxParallelTools || 3,
      preferredTools: options.preferredTools || [], // 用户偏好工具
      excludedTools: options.excludedTools || [] // 排除的工具
    };

    // 历史推荐记录（用于自我学习）
    this.recommendationHistory = [];
    this.maxHistorySize = 100;

    // 任务特征→工具的映射规则（启发式知识库）
    this.heuristicRules = this._initHeuristicRules();
  }

  /**
   * 初始化启发式规则库
   * 基于工具能力档案的先验知识
   */
  _initHeuristicRules () {
    return {
      // 按语言推荐工具
      byLanguage: {
        c: ['openclaw', 'claude-code', 'atom-code'],
        cpp: ['openclaw', 'claude-code', 'atom-code'],
        rust: ['claude-code', 'openclaw'],
        go: ['claude-code', 'qoder'],
        python: ['claude-code', 'qoder', 'hermes-agent'],
        javascript: ['qoder', 'claude-code', 'trae', 'mimo-code'],
        typescript: ['qoder', 'claude-code', 'trae'],
        java: ['claude-code', 'qoder', 'atom-code'],
        frontend: ['qoder', 'trae', 'zcode'],
        backend: ['claude-code', 'openclaw', 'hermes-agent']
      },
      // 按任务类型推荐工具
      byTaskType: {
        algorithm: ['openclaw', 'claude-code', 'atom-code'],
        ui_design: ['qoder', 'trae', 'zcode'],
        api: ['claude-code', 'qoder', 'hermes-agent'],
        database: ['claude-code', 'qoder'],
        devops: ['hermes-agent', 'openclaw'],
        testing: ['claude-code', 'atom-code'],
        refactoring: ['claude-code', 'qoder'],
        bugfix: ['claude-code', 'openclaw', 'atom-code'],
        feature: ['qoder', 'claude-code', 'trae'],
        optimization: ['claude-code', 'openclaw']
      },
      // 按复杂度推荐策略
      byComplexity: {
        simple: { strategy: 'round_robin', toolCount: 1, mode: 'privacy' },
        medium: { strategy: 'top_n', toolCount: 2, mode: 'quality' },
        complex: { strategy: 'top_n', toolCount: 3, mode: 'efficiency' },
        very_complex: { strategy: 'broadcast', toolCount: 3, mode: 'efficiency' }
      }
    };
  }

  /**
   * 分析任务特征
   * @param {string} taskDescription - 任务描述
   * @param {Object} context - 上下文
   * @returns {Object} 任务特征
   */
  analyzeTask (taskDescription, context = {}) {
    const desc = (taskDescription || '').toLowerCase();

    // 1. 语言检测（注意：不使用 \b，对中文不生效）
    let language = 'unknown';
    const langPatterns = [
      { lang: 'c', pattern: /(c语言|c\s*代码|\.c[^a-z]|gcc|clang|嵌入式|stm32|arduino)/ },
      { lang: 'cpp', pattern: /(c\+\+|cpp|\.cpp|\.hpp|qt|opencv)/ },
      { lang: 'rust', pattern: /(rust|cargo|\.rs[^a-z])/ },
      { lang: 'go', pattern: /(golang|go语言|\.go[^a-z])/ },
      { lang: 'python', pattern: /(python|django|flask|pandas|numpy|\.py[^a-z])/ },
      { lang: 'javascript', pattern: /(javascript|js语言|node\.?js|express|npm)/ },
      { lang: 'typescript', pattern: /(typescript|tsx?|deno)/ },
      { lang: 'java', pattern: /(java|spring|maven|gradle|jvm)/ },
      { lang: 'frontend', pattern: /(前端|vue|react|css|html|页面|界面|ui)/ },
      { lang: 'backend', pattern: /(后端|服务端|server|数据库|database)/ }
    ];
    for (const { lang, pattern } of langPatterns) {
      if (pattern.test(desc)) {
        language = lang; break;
      }
    }

    // 2. 任务类型检测（注意：顺序很重要，更具体的先匹配）
    let taskType = 'feature';
    const typePatterns = [
      { type: 'refactoring', pattern: /(重构|refactor|优化结构|清理代码|重写)/ },
      { type: 'bugfix', pattern: /(bug|修复|fix|错误|异常|问题|报错)/ },
      { type: 'optimization', pattern: /(优化|性能|performance|加速|缓存|提升速度)/ },
      { type: 'testing', pattern: /(测试|test|单元测试|集成测试|覆盖率|用例)/ },
      { type: 'algorithm', pattern: /(算法|排序|搜索|动态规划|dp|leetcode|数据结构)/ },
      { type: 'ui_design', pattern: /(界面|ui设计|组件|页面|布局|样式|交互|前端界面)/ },
      { type: 'api', pattern: /(api|接口|restful|graphql|endpoint|后端接口)/ },
      { type: 'database', pattern: /(数据库|sql|建表|索引|查询|mysql|postgres|mongodb|redis)/ },
      { type: 'devops', pattern: /(docker|k8s|部署|ci\/cd|运维|监控|容器)/ },
      { type: 'feature', pattern: /(功能|feature|新增|添加|实现|开发)/ }
    ];
    for (const { type, pattern } of typePatterns) {
      if (pattern.test(desc)) {
        taskType = type; break;
      }
    }

    // 3. 复杂度评估（基于关键词信号 + 长度）
    const complexitySignals = [
      /复杂/, /complex/, /困难/, /difficult/, /大型/, /企业级/, /微服务/, /多模块/,
      /架构/, /高并发/, /分布式/, /高可用/, /多线程/, /异步/, /事务/
    ];
    let signalCount = 0;
    for (const sig of complexitySignals) {
      if (sig.test(desc)) signalCount++;
    }
    const lengthScore = Math.min(desc.length / 300, 1);
    const signalScore = Math.min(signalCount / 3, 1);
    const complexityScore = (lengthScore * 0.4 + signalScore * 0.6);

    let complexity = 'simple';
    if (complexityScore > 0.6 || signalCount >= 4) complexity = 'very_complex';
    else if (complexityScore > 0.4 || signalCount >= 2) complexity = 'complex';
    else if (complexityScore > 0.2 || signalCount >= 1) complexity = 'medium';

    // 4. 规模评估
    let scale = 'small';
    if (/(大项目|大型|企业级|微服务|大规模|海量)/.test(desc)) scale = 'large';
    else if (/(中项目|中型|多模块|多服务)/.test(desc)) scale = 'medium';

    // 5. 隐私敏感度
    let privacyLevel = 'medium';
    if (/(机密|核心|商业|隐私|private|secret|confidential|内部)/.test(desc)) privacyLevel = 'high';
    else if (/(开源|open\s*source|公开|demo|示例|example|public)/.test(desc)) privacyLevel = 'low';

    return {
      language,
      taskType,
      complexity,
      scale,
      privacyLevel,
      complexityScore,
      signalCount,
      description: taskDescription,
      raw: { length: desc.length, signals: signalCount }
    };
  }

  /**
   * 推荐工具组合（核心方法）
   * @param {string} taskDescription - 任务描述
   * @param {Array} availableTools - 可用工具列表
   * @param {Object} context - 上下文
   * @returns {Object} 推荐结果
   */
  recommend (taskDescription, availableTools = [], context = {}) {
    const features = this.analyzeTask(taskDescription, context);

    // 过滤可用工具（排除黑名单 + 仅保留在线工具）
    const candidates = availableTools.filter(tool => {
      if (this.userPreferences.excludedTools.includes(tool.name)) return false;
      if (tool.status && tool.status !== 'online' && tool.status !== 'ready') return false;
      return true;
    });

    // 1. 基于启发式规则选工具
    const heuristicTools = this._selectByHeuristics(features, candidates);

    // 2. 基于历史学习数据排序
    const learnedTools = this._selectByLearning(features, heuristicTools, candidates);

    // 3. 应用用户偏好过滤
    const preferredTools = this._applyUserPreferences(learnedTools, features);

    // 4. 推荐策略与模式
    const strategy = this._recommendStrategy(features, preferredTools);

    // 5. 计算置信度
    const confidence = this._calculateConfidence(features, preferredTools, candidates);

    // 6. 生成推荐理由
    const reasoning = this._generateReasoning(features, preferredTools, strategy, confidence);

    const recommendation = {
      features,
      tools: preferredTools.map(t => ({
        name: t.name,
        displayName: t.displayName || t.name,
        score: t._score || 0,
        reason: t._reason || ''
      })),
      strategy: strategy.strategy,
      mode: strategy.mode,
      toolCount: strategy.toolCount,
      confidence,
      reasoning,
      orchestrationMode: this.orchestrationMode
    };

    // 记录推荐历史（用于自我学习）
    this._recordRecommendation(recommendation);

    return recommendation;
  }

  /**
   * 基于启发式规则选择工具
   */
  _selectByHeuristics (features, candidates) {
    const { language, taskType } = features;
    const scored = candidates.map(tool => {
      let score = 0;
      const reasons = [];

      // 按语言匹配
      const langTools = this.heuristicRules.byLanguage[language] || [];
      const langIdx = langTools.indexOf(tool.name);
      if (langIdx >= 0) {
        score += (langTools.length - langIdx) * 10;
        reasons.push(`擅长${language}`);
      }

      // 按任务类型匹配
      const typeTools = this.heuristicRules.byTaskType[taskType] || [];
      const typeIdx = typeTools.indexOf(tool.name);
      if (typeIdx >= 0) {
        score += (typeTools.length - typeIdx) * 8;
        reasons.push(`适合${taskType}任务`);
      }

      return { ...tool, _score: score, _reason: reasons.join('、') };
    });

    return scored.sort((a, b) => b._score - a._score);
  }

  /**
   * 基于历史学习数据选择工具
   */
  _selectByLearning (features, heuristicTools, allCandidates) {
    // 尝试用 ToolLearning 推荐最佳工具
    try {
      const taskInfo = {
        type: features.taskType,
        language: features.language,
        complexity: features.complexity,
        frameworks: [],
        role: 'code_writer'
      };

      const availableTools = allCandidates.map(t => t.name);
      const recommendation = this.toolLearning.recommendBestTool(taskInfo, availableTools);

      if (recommendation && recommendation.toolName) {
        // 合并学习得分
        const learnedScore = recommendation.confidence * 15;
        const tool = heuristicTools.find(t => t.name === recommendation.toolName);
        if (tool) {
          tool._score += learnedScore;
          tool._reason += (tool._reason ? '、' : '') + `历史表现优秀(${Math.round(recommendation.confidence * 100)}%)`;
        } else {
          // 学习推荐了候选外的工具
          const newTool = allCandidates.find(t => t.name === recommendation.toolName);
          if (newTool) {
            heuristicTools.push({
              ...newTool,
              _score: learnedScore,
              _reason: `历史表现优秀(${Math.round(recommendation.confidence * 100)}%)`
            });
          }
        }
      }
    } catch (_) {}

    return heuristicTools.sort((a, b) => b._score - a._score);
  }

  /**
   * 应用用户偏好
   */
  _applyUserPreferences (tools, features) {
    // 用户偏好的工具优先级提升
    const preferred = this.userPreferences.preferredTools;
    if (preferred.length > 0) {
      tools.forEach(t => {
        if (preferred.includes(t.name)) {
          t._score += 20;
          t._reason += (t._reason ? '、' : '') + '用户偏好';
        }
      });
    }

    // 隐私敏感度高 → 优先隐私模式工具
    if (features.privacyLevel === 'high' || this.userPreferences.privacySensitivity === 'high') {
      const privacyFriendly = ['openclaw', 'claude-code', 'atom-code'];
      tools.forEach(t => {
        if (privacyFriendly.includes(t.name)) {
          t._score += 10;
        } else {
          t._score -= 5;
        }
      });
    }

    // 限制工具数量
    const maxTools = this.userPreferences.maxParallelTools;
    return tools.sort((a, b) => b._score - a._score).slice(0, maxTools);
  }

  /**
   * 推荐策略和模式
   */
  _recommendStrategy (features, tools) {
    const { complexity } = features;
    const rule = this.heuristicRules.byComplexity[complexity] || this.heuristicRules.byComplexity.medium;

    let strategy = rule.strategy;
    let mode = rule.mode;
    const toolCount = Math.min(rule.toolCount, tools.length);

    // 用户偏好覆盖
    if (this.userPreferences.qualityPriority === 'high' && mode === 'privacy') {
      mode = 'quality';
    }
    if (this.userPreferences.efficiencyPriority === 'high' && complexity === 'very_complex') {
      strategy = 'broadcast';
      mode = 'efficiency';
    }
    if (this.userPreferences.privacySensitivity === 'high') {
      mode = 'privacy';
    }

    return { strategy, mode, toolCount };
  }

  /**
   * 计算置信度
   */
  _calculateConfidence (features, tools, allCandidates) {
    let confidence = 0.5;

    // 工具匹配度高 → 置信度提升
    const topTool = tools[0];
    if (topTool && topTool._score > 30) confidence += 0.3;
    else if (topTool && topTool._score > 15) confidence += 0.15;

    // 历史数据丰富 → 置信度提升
    try {
      const stats = this.toolLearning.getLearningStats();
      if (stats.totalExecutions > 10) confidence += 0.1;
      if (stats.totalExecutions > 50) confidence += 0.1;
    } catch (_) {}

    return Math.min(confidence, 0.95);
  }

  /**
   * 生成推荐理由
   */
  _generateReasoning (features, tools, strategy, confidence) {
    const reasons = [];

    reasons.push(`任务特征: ${features.language}/${features.taskType}/${features.complexity}`);

    if (tools.length > 0) {
      reasons.push(`推荐工具: ${tools.map(t => `${t.displayName || t.name}(${t._reason || '通用'})`).join(' + ')}`);
    }

    reasons.push(`策略: ${strategy.strategy} / 模式: ${strategy.mode} / 工具数: ${strategy.toolCount}`);

    const confidencePct = Math.round(confidence * 100);
    reasons.push(`置信度: ${confidencePct}%`);

    if (confidencePct < 60) {
      reasons.push('⚠️ 置信度较低，建议手动确认或调整');
    }

    return reasons.join('\n');
  }

  /**
   * 记录推荐历史
   */
  _recordRecommendation (recommendation) {
    const timestamp = Date.now();
    recommendation.timestamp = timestamp;
    this.recommendationHistory.push({
      timestamp,
      ...recommendation
    });
    if (this.recommendationHistory.length > this.maxHistorySize) {
      this.recommendationHistory.shift();
    }
  }

  /**
   * 记录推荐结果（用于自我学习）
   * @param {string} recommendationId - 推荐ID
   * @param {boolean} success - 是否成功
   * @param {number} qualityScore - 质量分
   * @param {Object} metadata - 额外元数据（任务类型、语言、耗时等）
   */
  recordOutcome (recommendationId, success, qualityScore, metadata = {}) {
    const record = this.recommendationHistory.find(r => r.timestamp === recommendationId);
    if (record) {
      record.outcome = {
        success,
        qualityScore,
        recordedAt: Date.now(),
        ...metadata
      };
    }

    // 学习闭环：将成功结果回写到 ToolLearning，让后续推荐受益
    if (record && record.tools && record.tools.length > 0) {
      try {
        const toolNames = record.tools.map(t => t.name || t);
        const taskType = record.features?.taskType || metadata.taskType || 'unknown';
        const language = record.features?.language || metadata.language || 'unknown';

        // 成功的工具增强信心；失败的工具降低信心
        for (const toolName of toolNames) {
          if (success) {
            this.toolLearning.recordSuccess(toolName, taskType, qualityScore);
          } else {
            this.toolLearning.recordFailure(toolName, taskType);
          }
          // 同时记录语言偏好
          if (language !== 'unknown') {
            this.toolLearning.recordLanguageMatch(toolName, language, success);
          }
        }
      } catch (_) {}
    }
  }

  /**
   * 获取学习统计（用于可观测性）
   */
  getLearningStats () {
    const total = this.recommendationHistory.length;
    const withOutcome = this.recommendationHistory.filter(r => r.outcome).length;
    const successes = this.recommendationHistory.filter(r => r.outcome && r.outcome.success).length;
    const avgQuality = withOutcome > 0
      ? this.recommendationHistory.reduce((sum, r) => sum + (r.outcome?.qualityScore || 0), 0) / withOutcome
      : 0;

    return {
      totalRecommendations: total,
      recordedOutcomes: withOutcome,
      successRate: withOutcome > 0 ? successes / withOutcome : 0,
      averageQualityScore: parseFloat(avgQuality.toFixed(3)),
      topTools: this._getTopPerformingTools(),
      orchestrationMode: this.orchestrationMode
    };
  }

  /**
   * 获取表现最好的工具（基于历史数据）
   */
  _getTopPerformingTools () {
    const toolStats = new Map();
    for (const rec of this.recommendationHistory) {
      if (!rec.outcome) continue;
      const tools = rec.tools || [];
      for (const tool of tools) {
        const name = typeof tool === 'string' ? tool : tool.name;
        if (!toolStats.has(name)) {
          toolStats.set(name, { name, count: 0, success: 0, totalQuality: 0 });
        }
        const s = toolStats.get(name);
        s.count++;
        if (rec.outcome.success) s.success++;
        s.totalQuality += rec.outcome.qualityScore || 0;
      }
    }
    const arr = Array.from(toolStats.values()).map(s => ({
      name: s.name,
      count: s.count,
      successRate: s.count > 0 ? s.success / s.count : 0,
      avgQuality: s.count > 0 ? parseFloat((s.totalQuality / s.count).toFixed(2)) : 0
    }));
    arr.sort((a, b) => b.successRate - a.successRate || b.avgQuality - a.avgQuality);
    return arr.slice(0, 5);
  }

  /**
   * 设置编排模式
   * @param {string} mode - auto / manual / hybrid
   */
  setOrchestrationMode (mode) {
    if (!['auto', 'manual', 'hybrid'].includes(mode)) {
      throw new Error(`未知编排模式: ${mode}。可选: auto / manual / hybrid`);
    }
    this.orchestrationMode = mode;
    return { success: true, mode };
  }

  /**
   * 更新用户偏好
   */
  updatePreferences (preferences) {
    this.userPreferences = { ...this.userPreferences, ...preferences };
    return { success: true, preferences: this.userPreferences };
  }

  /**
   * 获取编排状态
   */
  getStatus () {
    return {
      orchestrationMode: this.orchestrationMode,
      userPreferences: this.userPreferences,
      recommendationHistorySize: this.recommendationHistory.length,
      heuristicRulesCount: Object.keys(this.heuristicRules.byLanguage).length +
                            Object.keys(this.heuristicRules.byTaskType).length +
                            Object.keys(this.heuristicRules.byComplexity).length
    };
  }

  /**
   * 获取推荐历史
   */
  getHistory (limit = 10) {
    return this.recommendationHistory.slice(-limit);
  }
}

module.exports = AdaptiveOrchestrator;
