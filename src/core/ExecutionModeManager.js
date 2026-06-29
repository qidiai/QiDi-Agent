/**
 * 执行模式管理器
 *
 * 三种核心模式：
 *
 * 1. 隐私模式 (privacy) - 安全第一
 *    - 拆分：本地 Ollama
 *    - 代码生成：云端工具各拿碎片（路由分发）
 *    - 质检：本地模型 AI 打分 + 本地工具链
 *    - 合并：接口契约拼装（唯一使用契约的模式）
 *
 * 2. 高质量模式 (quality) - 质量第一
 *    - 拆分：云端 API（DeepSeek/Claude 等）
 *    - 代码生成：云端工具各拿碎片（能力匹配分发）
 *    - 质检：云端模型 AI 打分 + 本地工具链
 *    - 合并：AI 智能合并（不使用契约）
 *
 * 3. 效率模式 (efficiency) - 分布式并行协作
 *    - 拆分：云端最强模型（最多20个子任务）
 *    - 代码生成：广播并行（所有工具同时尝试不同方案）
 *    - 质检：本地 Ollama 快速初筛 + 本地工具链
 *    - 合并：AI 智能合并（不使用契约）
 */

class ExecutionModeManager {
  constructor () {
    this.modes = this._defineModes();
    this.currentMode = 'privacy';
    this.autoModeEnabled = true;
    this.modeHistory = [];
    this.modeSuccessRates = {
      privacy: { total: 0, success: 0, avgQuality: 0 },
      quality: { total: 0, success: 0, avgQuality: 0 },
      efficiency: { total: 0, success: 0, avgQuality: 0 },
      multi: { total: 0, success: 0, avgQuality: 0 }
    };
  }

  /**
   * 定义两种完整模式配置
   */
  _defineModes () {
    return {
      privacy: {
        name: 'privacy',
        displayName: '隐私模式',
        slogan: '安全第一',
        description: '敏感代码、合规要求场景。拆分和质检在本地完成，云端工具只看到碎片任务。',
        icon: '🔒',

        // 拆分配置
        splitter: {
          location: 'local', // local | cloud
          providerType: 'ollama', // 使用本地 Ollama
          enableSelfCheck: true, // 开启自检（本地执行，不涉及隐私）
          maxSubtasks: 12,
          enableCoverageCheck: true, // 覆盖度检查
          enableDependencyCheck: true // 依赖检查
        },

        // 代码生成配置
        codeGeneration: {
          location: 'cloud_tools', // 云端工具执行
          routingStrategy: 'round_robin', // 轮询分发
          broadcastMode: false, // 不广播，各拿碎片
          providerParticipates: false, // Provider 不参与代码生成
          toolOnlyMode: true, // 仅工具执行
          maxRetries: 2
        },

        // 质量检查配置
        qualityCheck: {
          location: 'local', // local | cloud | hybrid
          enableAI: true, // ✅ 开启本地模型打分（代码不离开本地！）
          aiProvider: 'ollama', // 本地 Ollama 负责打分
          enableStaticCheck: true, // 本地静态分析
          enableCompilation: true, // 本地编译检查
          enableLint: true, // 本地 Lint
          enableTest: false, // 测试执行（可选）
          minQualityScore: 60,
          dimensions: ['correctness', 'consistency', 'completeness', 'security']
        },

        // 合并配置
        merging: {
          strategy: 'contract', // contract | ai | hybrid
          aiEnabled: false, // 关闭云端 AI 合并
          localModelAssist: true, // ✅ 启用本地模型辅助契约提取
          localModelProvider: 'ollama', // 本地 Ollama 辅助
          contractStrict: true, // 契约严格模式
          autoAdapt: true, // 自动适配
          conflictResolution: 'first_wins' // 冲突解决策略
        },

        // 路由配置
        routing: {
          defaultStrategy: 'round_robin',
          strategies: ['round_robin', 'capability', 'manual'],
          privacyLevel: 'high'
        },

        // 隐私相关设置
        privacy: {
          enabled: true,
          dataRetention: 'minimal', // 最小化数据留存
          contextSharing: 'isolated', // 上下文隔离
          providerSeesFullCode: false, // Provider 看不到完整代码
          toolSeesFullTask: false, // 工具看不到完整任务
          logSensitiveData: false // 不记录敏感数据
        },

        // 适用场景
        useCases: [
          '公司核心代码',
          '商业机密项目',
          '合规要求严格的项目',
          '个人隐私数据相关'
        ]
      },

      quality: {
        name: 'quality',
        displayName: '高质量模式',
        slogan: '质量第一',
        description: '追求最佳代码质量。使用云端最强模型拆分、质检和合并，工具各拿碎片保证效率。',
        icon: '✨',

        // 拆分配置
        splitter: {
          location: 'cloud', // 云端拆分
          providerType: 'openai', // 使用 OpenAI 兼容云端（DeepSeek/Claude 等）
          enableSelfCheck: true, // AI 自检
          maxSubtasks: 15,
          enableCoverageCheck: true,
          enableDependencyCheck: true
        },

        // 代码生成配置
        codeGeneration: {
          location: 'cloud_tools',
          routingStrategy: 'capability', // 能力匹配分发
          broadcastMode: false, // 不广播，各拿碎片
          providerParticipates: true, // Provider 参与代码生成（可选）
          toolOnlyMode: false,
          maxRetries: 3
        },

        // 质量检查配置
        qualityCheck: {
          location: 'cloud',
          enableAI: true, // 开启 AI 打分
          enableStaticCheck: true, // 静态分析
          enableCompilation: true, // 编译检查
          enableLint: true, // Lint
          enableTest: true, // 测试执行
          minQualityScore: 75, // 更高的质量要求
          dimensions: ['correctness', 'consistency', 'completeness', 'readability', 'security', 'maintainability']
        },

        // 合并配置
        merging: {
          strategy: 'ai', // AI 智能合并
          aiEnabled: true, // 启用 AI 合并
          contractStrict: false,
          autoAdapt: true,
          conflictResolution: 'ai_decides'
        },

        // 路由配置
        routing: {
          defaultStrategy: 'capability',
          strategies: ['capability', 'round_robin', 'manual', 'broadcast'],
          privacyLevel: 'medium'
        },

        // 隐私相关设置
        privacy: {
          enabled: false,
          dataRetention: 'standard',
          contextSharing: 'full', // 完整上下文共享
          providerSeesFullCode: true, // Provider 可以看到完整代码
          toolSeesFullTask: false, // 工具仍然只看碎片（保护工具账号不泄露全貌）
          logSensitiveData: true
        },

        // 适用场景
        useCases: [
          '开源项目',
          '非敏感业务代码',
          '追求最高代码质量',
          '需要 AI 深度参与'
        ]
      },

      efficiency: {
        name: 'efficiency',
        displayName: '效率模式',
        slogan: '分布式并行协作',
        description: '复杂任务自动拆解，云端拆分→广播并行→本地质检→AI合并，避免重复造轮子和内耗。',
        icon: '⚡',

        // 拆分配置
        splitter: {
          location: 'cloud', // 云端拆分（用最强模型拆解复杂任务）
          providerType: 'openai', // 使用 DeepSeek/Claude 等
          enableSelfCheck: true,
          maxSubtasks: 20, // 支持更多子任务
          enableCoverageCheck: true,
          enableDependencyCheck: true
        },

        // 代码生成配置
        codeGeneration: {
          location: 'broadcast', // 广播模式 — 所有工具并行尝试
          routingStrategy: 'broadcast', // 广播分发
          broadcastMode: true, // 开启广播
          providerParticipates: true,
          toolOnlyMode: false,
          maxRetries: 3
        },

        // 质量检查配置
        qualityCheck: {
          location: 'hybrid', // 混合质检
          enableAI: true,
          aiProvider: 'ollama', // 本地 Ollama 快速初筛
          enableStaticCheck: true,
          enableCompilation: true,
          enableLint: true,
          enableTest: true,
          minQualityScore: 70,
          dimensions: ['correctness', 'consistency', 'completeness', 'readability', 'performance']
        },

        // 合并配置 — 效率模式不使用契约，直接 AI 合并
        merging: {
          strategy: 'ai', // AI 智能合并（不使用契约）
          aiEnabled: true,
          contractStrict: false, // ❌ 不使用契约
          autoAdapt: true,
          conflictResolution: 'ai_decides'
        },

        // 路由配置
        routing: {
          defaultStrategy: 'broadcast',
          strategies: ['broadcast', 'capability', 'round_robin', 'manual'],
          privacyLevel: 'low'
        },

        // 隐私相关设置
        privacy: {
          enabled: false,
          dataRetention: 'standard',
          contextSharing: 'full',
          providerSeesFullCode: true,
          toolSeesFullTask: false,
          logSensitiveData: true
        },

        // 适用场景
        useCases: [
          '大型复杂项目',
          '多模块并行开发',
          '需要多种技术方案对比',
          '追求最高效率'
        ]
      },

      multi: {
        name: 'multi',
        displayName: '多模型并行模式',
        slogan: '多Provider并行产出',
        description: '在无外部编程工具时，用多个LLM Provider并行生成代码，重新激活合并能力。拆分→多Provider并行→质检→AI智能合并。',
        icon: '🔀',

        // 拆分配置
        splitter: {
          location: 'cloud',
          providerType: 'openai',
          enableSelfCheck: true,
          maxSubtasks: 10,
          enableCoverageCheck: true,
          enableDependencyCheck: true
        },

        // 代码生成配置
        codeGeneration: {
          location: 'multi_provider',
          routingStrategy: 'broadcast',
          broadcastMode: true,
          providerParticipates: true,
          toolOnlyMode: false,
          maxRetries: 3,
          multiProviderMode: true,
          parallelLimit: 3
        },

        // 质量检查配置
        qualityCheck: {
          location: 'hybrid',
          enableAI: true,
          aiProvider: 'ollama',
          enableStaticCheck: true,
          enableCompilation: true,
          enableLint: true,
          enableTest: true,
          minQualityScore: 70,
          dimensions: ['correctness', 'consistency', 'completeness', 'readability', 'security']
        },

        // 合并配置
        merging: {
          strategy: 'ai',
          aiEnabled: true,
          contractStrict: false,
          autoAdapt: true,
          conflictResolution: 'ai_decides',
          enableMultiProviderMerge: true
        },

        // 路由配置
        routing: {
          defaultStrategy: 'broadcast',
          strategies: ['broadcast', 'capability', 'round_robin', 'manual'],
          privacyLevel: 'low'
        },

        // 隐私相关设置
        privacy: {
          enabled: false,
          dataRetention: 'standard',
          contextSharing: 'full',
          providerSeesFullCode: true,
          toolSeesFullTask: false,
          logSensitiveData: true
        },

        // 适用场景
        useCases: [
          '无外部编程工具的单机环境',
          '需要多方案对比',
          '追求代码多样性',
          '单软件编程增强场景'
        ]
      }
    };
  }

  /**
   * 获取所有模式列表
   */
  getAllModes () {
    return Object.values(this.modes).map(m => ({
      name: m.name,
      displayName: m.displayName,
      slogan: m.slogan,
      description: m.description,
      icon: m.icon,
      useCases: m.useCases,
      privacyLevel: m.routing.privacyLevel
    }));
  }

  /**
   * 获取当前模式
   */
  getCurrentMode () {
    return this.currentMode;
  }

  /**
   * 设置当前模式
   */
  setMode (modeName) {
    if (!this.modes[modeName]) {
      throw new Error(`未知模式: ${modeName}。可选: ${Object.keys(this.modes).join(', ')}`);
    }

    this.modeHistory.push({
      timestamp: Date.now(),
      from: this.currentMode,
      to: modeName
    });

    this.currentMode = modeName;
    return this.modes[modeName];
  }

  /**
   * 获取模式完整配置
   */
  getModeConfig (modeName = this.currentMode) {
    return this.modes[modeName] || this.modes.privacy;
  }

  /**
   * 获取拆分器配置
   */
  getSplitterConfig (modeName = this.currentMode) {
    return this.getModeConfig(modeName).splitter;
  }

  /**
   * 获取代码生成配置
   */
  getCodeGenerationConfig (modeName = this.currentMode) {
    return this.getModeConfig(modeName).codeGeneration;
  }

  /**
   * 获取质量检查配置
   */
  getQualityCheckConfig (modeName = this.currentMode) {
    return this.getModeConfig(modeName).qualityCheck;
  }

  /**
   * 获取合并配置
   */
  getMergingConfig (modeName = this.currentMode) {
    return this.getModeConfig(modeName).merging;
  }

  /**
   * 获取路由配置
   */
  getRoutingConfig (modeName = this.currentMode) {
    return this.getModeConfig(modeName).routing;
  }

  /**
   * 获取隐私配置
   */
  getPrivacyConfig (modeName = this.currentMode) {
    return this.getModeConfig(modeName).privacy;
  }

  /**
   * 比较两种模式差异
   */
  compareModes (mode1 = 'privacy', mode2 = 'quality') {
    const m1 = this.modes[mode1];
    const m2 = this.modes[mode2];

    return {
      dimensions: [
        {
          name: '任务拆分',
          [mode1]: m1.splitter.location === 'local' ? `🔒 本地 Ollama（安全，最多${m1.splitter.maxSubtasks}个子任务）` : `☁️ 云端 API（最多${m1.splitter.maxSubtasks}个子任务）`,
          [mode2]: m2.splitter.location === 'local' ? `🔒 本地 Ollama（安全，最多${m2.splitter.maxSubtasks}个子任务）` : `☁️ 云端 API（最多${m2.splitter.maxSubtasks}个子任务）`,
          same: m1.splitter.location === m2.splitter.location
        },
        {
          name: '代码生成',
          [mode1]: m1.codeGeneration.broadcastMode ? '📡 广播并行（所有工具尝试）' : '🔀 路由分发（各拿碎片）',
          [mode2]: m2.codeGeneration.broadcastMode ? '📡 广播并行（所有工具尝试）' : '🔀 路由分发（各拿碎片）',
          same: m1.codeGeneration.broadcastMode === m2.codeGeneration.broadcastMode
        },
        {
          name: '质量检查',
          [mode1]: m1.qualityCheck.location === 'local' ? `🔒 本地 Ollama 打分（${m1.qualityCheck.dimensions.length}维）` : m1.qualityCheck.location === 'cloud' ? `☁️ 云端 AI 打分（${m1.qualityCheck.dimensions.length}维）` : `🔄 混合质检（${m1.qualityCheck.dimensions.length}维）`,
          [mode2]: m2.qualityCheck.location === 'local' ? `🔒 本地 Ollama 打分（${m2.qualityCheck.dimensions.length}维）` : m2.qualityCheck.location === 'cloud' ? `☁️ 云端 AI 打分（${m2.qualityCheck.dimensions.length}维）` : `🔄 混合质检（${m2.qualityCheck.dimensions.length}维）`,
          same: m1.qualityCheck.location === m2.qualityCheck.location
        },
        {
          name: '代码合并',
          [mode1]: m1.merging.strategy === 'contract' ? '📋 接口契约拼装' : m1.merging.strategy === 'hybrid' ? '🔄 混合合并（契约+AI）' : '🤖 AI 智能合并',
          [mode2]: m2.merging.strategy === 'contract' ? '📋 接口契约拼装' : m2.merging.strategy === 'hybrid' ? '🔄 混合合并（契约+AI）' : '🤖 AI 智能合并',
          same: m1.merging.strategy === m2.merging.strategy
        },
        {
          name: '路由策略',
          [mode1]: m1.routing.defaultStrategy === 'broadcast' ? '📡 广播并行' : m1.routing.defaultStrategy === 'capability' ? '🎯 能力匹配' : m1.routing.defaultStrategy === 'round_robin' ? '🔀 轮询分发' : m1.routing.defaultStrategy,
          [mode2]: m2.routing.defaultStrategy === 'broadcast' ? '📡 广播并行' : m2.routing.defaultStrategy === 'capability' ? '🎯 能力匹配' : m2.routing.defaultStrategy === 'round_robin' ? '🔀 轮询分发' : m2.routing.defaultStrategy,
          same: m1.routing.defaultStrategy === m2.routing.defaultStrategy
        },
        {
          name: '适用场景',
          [mode1]: m1.useCases.join('、'),
          [mode2]: m2.useCases.join('、'),
          same: false
        },
        {
          name: '一句话',
          [mode1]: m1.slogan,
          [mode2]: m2.slogan,
          same: false
        }
      ]
    };
  }

  /**
   * 根据任务类型推荐模式
   */
  recommendMode (taskDescription) {
    const lowerDesc = taskDescription.toLowerCase();

    const privacyKeywords = [
      '私密', '隐私', '机密', '敏感', '内部', '核心', '商业', '保密',
      'private', 'secret', 'confidential', 'internal', 'core'
    ];

    const qualityKeywords = [
      '高质量', '最佳', '优化', '重构', '重要', '关键',
      'quality', 'best', 'optimize', 'refactor', 'critical'
    ];

    const efficiencyKeywords = [
      '效率', '并行', '并发', '分布式', '多工具', '批量',
      '大规模', '复杂任务', '大项目', '拆解', '分发',
      'efficiency', 'parallel', 'distributed', 'batch', 'large',
      'complex task', 'multi-tool'
    ];

    const multiKeywords = [
      '多模型', '多个模型', '多Provider', '并行产出', '方案对比',
      '多样性', '单软件', '单机', '无工具',
      'multi-model', 'multi-provider', 'multi agent'
    ];

    let privacyScore = 0;
    let qualityScore = 0;
    let efficiencyScore = 0;
    let multiScore = 0;

    for (const kw of privacyKeywords) {
      if (lowerDesc.includes(kw)) privacyScore++;
    }

    for (const kw of qualityKeywords) {
      if (lowerDesc.includes(kw)) qualityScore++;
    }

    for (const kw of efficiencyKeywords) {
      if (lowerDesc.includes(kw)) efficiencyScore++;
    }

    for (const kw of multiKeywords) {
      if (lowerDesc.includes(kw)) multiScore++;
    }

    // 优先级：隐私 > 多模型 > 效率 > 高质量
    if (privacyScore > 0) {
      return { mode: 'privacy', confidence: privacyScore, reason: '检测到敏感关键词，推荐隐私模式' };
    }

    if (multiScore > 0) {
      return { mode: 'multi', confidence: multiScore, reason: '检测到多模型关键词，推荐多模型并行模式' };
    }

    if (efficiencyScore > qualityScore) {
      return { mode: 'efficiency', confidence: efficiencyScore, reason: '检测到效率关键词，推荐效率模式（分布式并行协作）' };
    }

    if (qualityScore > 0) {
      return { mode: 'quality', confidence: qualityScore, reason: '检测到质量关键词，推荐高质量模式' };
    }

    return { mode: 'privacy', confidence: 0, reason: '默认推荐隐私模式（安全优先）' };
  }

  /**
   * 自动决定执行模式（Auto Mode）
   * 根据任务特征 + 历史成功率自动设置模式，无需人工确认
   * @param {string} taskDescription - 任务描述
   * @param {Object} options - 选项
   * @returns {Object} 决策结果
   */
  autoDecideMode (taskDescription, options = {}) {
    if (!this.autoModeEnabled && !options.force) {
      return {
        mode: this.currentMode,
        changed: false,
        reason: '自动模式已禁用',
        autoModeEnabled: false
      };
    }

    const recommendation = this.recommendMode(taskDescription);
    let finalMode = recommendation.mode;

    const historicalFactor = this._evaluateHistoricalPerformance(finalMode);
    if (historicalFactor.shouldOverride && historicalFactor.bestMode) {
      finalMode = historicalFactor.bestMode;
    }

    const changed = finalMode !== this.currentMode;
    if (changed) {
      this.setMode(finalMode);
    }

    return {
      mode: finalMode,
      changed,
      reason: changed
        ? `自动切换模式: ${recommendation.reason}${historicalFactor.shouldOverride ? '（历史性能覆盖）' : ''}`
        : `保持当前模式: ${this.modes[finalMode].displayName}`,
      autoModeEnabled: this.autoModeEnabled,
      recommendation,
      historicalFactor
    };
  }

  /**
   * 评估历史性能，用于模式决策
   */
  _evaluateHistoricalPerformance (candidateMode) {
    const candidateStats = this.modeSuccessRates[candidateMode];
    if (!candidateStats || candidateStats.total < 3) {
      return { shouldOverride: false, bestMode: null, reason: '历史数据不足' };
    }

    const successRate = candidateStats.total > 0
      ? candidateStats.success / candidateStats.total
      : 0;
    const avgQuality = candidateStats.avgQuality;

    if (successRate >= 0.8 && avgQuality >= 75) {
      return { shouldOverride: false, bestMode: candidateMode, reason: '候选模式表现良好' };
    }

    let bestMode = candidateMode;
    let bestScore = successRate * 0.6 + (avgQuality / 100) * 0.4;

    for (const [mode, stats] of Object.entries(this.modeSuccessRates)) {
      if (stats.total < 3) continue;

      const modeSuccessRate = stats.success / stats.total;
      const modeScore = modeSuccessRate * 0.6 + (stats.avgQuality / 100) * 0.4;

      if (modeScore > bestScore && modeSuccessRate >= 0.6) {
        bestScore = modeScore;
        bestMode = mode;
      }
    }

    if (bestMode !== candidateMode) {
      return {
        shouldOverride: true,
        bestMode,
        reason: `${this.modes[bestMode].displayName}历史表现更好(成功率:${Math.round(bestScore * 100)}%)`
      };
    }

    return { shouldOverride: false, bestMode: candidateMode, reason: '候选模式已是最佳' };
  }

  /**
   * 记录任务执行结果，用于更新历史成功率
   */
  recordTaskResult (mode, success, qualityScore) {
    if (!this.modeSuccessRates[mode]) {
      this.modeSuccessRates[mode] = { total: 0, success: 0, avgQuality: 0 };
    }

    const stats = this.modeSuccessRates[mode];
    stats.total++;

    if (success) {
      stats.success++;
    }

    if (qualityScore) {
      stats.avgQuality = Math.round(
        (stats.avgQuality * (stats.total - 1) + qualityScore) / stats.total
      );
    }

    return { success: true, stats: { ...stats } };
  }

  /**
   * 获取模式统计信息
   */
  getModeStatistics () {
    const result = {};
    for (const [mode, stats] of Object.entries(this.modeSuccessRates)) {
      const successRate = stats.total > 0
        ? Math.round((stats.success / stats.total) * 100)
        : 0;
      result[mode] = {
        ...stats,
        successRate,
        displayName: this.modes[mode]?.displayName || mode,
        usageCount: this.modeHistory.filter(h => h.to === mode).length
      };
    }
    return result;
  }

  /**
   * 启用/禁用自动模式
   */
  setAutoModeEnabled (enabled) {
    this.autoModeEnabled = enabled;
    return { success: true, autoModeEnabled: enabled };
  }

  /**
   * 获取自动模式状态
   */
  getAutoModeStatus () {
    return {
      autoModeEnabled: this.autoModeEnabled,
      currentMode: this.currentMode,
      modeHistory: this.modeHistory.slice(-10),
      modeStatistics: this.getModeStatistics()
    };
  }

  /**
   * 重置历史统计
   */
  resetStatistics () {
    this.modeSuccessRates = {
      privacy: { total: 0, success: 0, avgQuality: 0 },
      quality: { total: 0, success: 0, avgQuality: 0 },
      efficiency: { total: 0, success: 0, avgQuality: 0 },
      multi: { total: 0, success: 0, avgQuality: 0 }
    };
    this.modeHistory = [];
    return { success: true, message: '历史统计已重置' };
  }
}

module.exports = ExecutionModeManager;
