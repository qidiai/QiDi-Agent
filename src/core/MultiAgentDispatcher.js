const AgentHub = require('./AgentHub');
const TaskOrchestrator = require('./TaskOrchestrator');
const AgentFactory = require('../agents');
const MergeEngine = require('../agents/MergeEngine');
const TaskRouter = require('./TaskRouter');
const createLogger = require('../utils/Logger');

const logger = createLogger('MultiAgentDispatcher');

/**
 * 多 Agent 智能分派器。
 * 支持：并行/顺序/选择最佳/级联/合并 5 种模式，以及隐私路由模式。
 */
class MultiAgentDispatcher {
  constructor (options = {}) {
    this.hub = new AgentHub({
      configDir: options.configDir || './config'
    });
    this.options = {
      mode: options.mode || 'parallel',
      timeout: options.timeout || 300000,
      compareResults: options.compareResults !== false,
      selectBest: options.selectBest !== false,
      parallelLimit: options.parallelLimit || 3,
      retryCount: options.retryCount || 1,
      enableQualityComparison: options.enableQualityComparison !== false,
      enableMerge: options.enableMerge !== false, // 新增：是否启用合并
      mergeMode: options.mergeMode || 'auto', // 'auto', 'always', 'never'
      outputDir: options.outputDir || './workspace/multi-agent',
      // ═══════════════ 隐私模式配置 ═══════════════
      privacyMode: options.privacyMode !== false, // 默认开启隐私模式
      routingStrategy: options.routingStrategy || 'round_robin', // 路由策略
      manualRouting: options.manualRouting || {}, // 手动路由表
      ...options
    };
    this.results = new Map();
    this.stats = {
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      byAgent: {},
      startTime: null,
      endTime: null,
      duration: 0
    };
    this.mergeEngine = null; // 延迟初始化，需要 provider
    this.taskRouter = null; // 延迟初始化
  }

  /**
   * 获取任务路由器实例
   */
  _getTaskRouter (adapters = []) {
    if (!this.taskRouter) {
      this.taskRouter = new TaskRouter(adapters, {
        strategy: this.options.routingStrategy,
        manualRouting: this.options.manualRouting,
        privacyMode: this.options.privacyMode
      });
    }
    return this.taskRouter;
  }

  async initialize () {
    await this.hub.initialize();
    return this;
  }

  async dispatch (taskDescription, options = {}) {
    const mode = options.mode || this.options.mode;
    const targetAgents = options.agents || this._getDefaultAgents();

    this.results.clear();
    this.stats.totalTasks = targetAgents.length;
    this.stats.completedTasks = 0;
    this.stats.failedTasks = 0;
    this.stats.startTime = Date.now();

    logger.info('\n🚀 多 Agent 智能分派');
    logger.info(`📋 任务: ${taskDescription.substring(0, 80)}${taskDescription.length > 80 ? '...' : ''}`);
    logger.info(`🤖 目标 Agent: ${targetAgents.join(', ')}`);
    logger.info(`⚙️ 模式: ${mode}`);
    logger.info(`🔒 隐私模式: ${this.options.privacyMode ? '开启' : '关闭'}`);
    logger.info(`📡 路由策略: ${this.options.routingStrategy}`);
    logger.info(`⏱️ 超时: ${this.options.timeout / 1000}秒\n`);

    let result;
    switch (mode) {
    case 'parallel':
      result = await this._dispatchParallel(taskDescription, targetAgents, options);
      break;
    case 'sequential':
      result = await this._dispatchSequential(taskDescription, targetAgents, options);
      break;
    case 'select':
      result = await this._dispatchSelectBest(taskDescription, targetAgents, options);
      break;
    case 'cascade':
      result = await this._dispatchCascade(taskDescription, targetAgents, options);
      break;
    case 'merge':
      result = await this._dispatchMerge(taskDescription, targetAgents, options);
      break;
    case 'privacy': // 隐私路由模式
      result = await this._dispatchPrivacy(taskDescription, targetAgents, options);
      break;
    default:
      result = await this._dispatchParallel(taskDescription, targetAgents, options);
    }

    this.stats.endTime = Date.now();
    this.stats.duration = this.stats.endTime - this.stats.startTime;
    logger.info(`\n⏱️ 总耗时: ${(this.stats.duration / 1000).toFixed(2)}秒`);

    return result;
  }

  // ─────────────────────── 隐私路由模式（新增）───────────────────────
  /**
   * 隐私路由模式：
   * - Provider 只负责拆分任务
   * - 每个子任务根据路由策略分配给不同工具
   * - 工具之间互不知道其他工具的产出
   * - 最终合并各工具产出
   */
  async _dispatchPrivacy (taskDescription, agentNames, options = {}) {
    logger.info('🔒 隐私路由模式: 根据路由策略分配任务给不同工具\n');

    // 1. 获取工具适配器
    const toolAdapters = this._getToolAdapters();
    if (toolAdapters.length === 0) {
      logger.warn('没有可用工具适配器，降级到传统模式');
      return await this._dispatchParallel(taskDescription, agentNames, options);
    }

    logger.info(`📡 可用工具: ${toolAdapters.map(a => a.displayName).join(', ')}`);
    logger.info(`📡 路由策略: ${this.options.routingStrategy}`);

    // 2. 创建任务编排器（传入隐私模式配置）
    const firstAgent = this.hub.getEnabledAgents()[0];
    const provider = firstAgent?.provider || this.hub.getAgent('ollama')?.provider;

    if (!provider) {
      throw new Error('无可用的 Provider');
    }

    const orchestrator = new TaskOrchestrator(provider, {
      workspaceDir: `${this.options.outputDir}/privacy`,
      enableCache: options.enableCache !== false,
      enableCompression: options.enableCompression !== false,
      enableModelRouting: false,
      // 隐私模式配置
      privacyMode: this.options.privacyMode,
      routingStrategy: this.options.routingStrategy,
      manualRouting: this.options.manualRouting,
      // 工具适配器
      toolAdapters
    });

    await orchestrator.initialize();

    // 3. 执行任务（TaskOrchestrator 会自动使用隐私路由）
    const startTime = Date.now();
    const result = await orchestrator.runTask(taskDescription, options.context);
    const duration = Date.now() - startTime;

    // 4. 获取路由统计
    const router = orchestrator._getTaskRouter();
    const routingStats = router.getRoutingStats([]);
    const capabilities = orchestrator.getToolCapabilities();

    // 5. 整理结果
    const finalResult = {
      success: true,
      mode: 'privacy',
      privacyMode: this.options.privacyMode,
      routingStrategy: this.options.routingStrategy,
      result,
      routingStats: {
        ...routingStats,
        toolCount: toolAdapters.length,
        availableTools: toolAdapters.map(a => ({ name: a.name, displayName: a.displayName }))
      },
      toolCapabilities: capabilities,
      duration,
      stats: this.stats
    };

    logger.info('\n🔒 隐私路由执行完成');
    logger.info(`   路由策略: ${this.options.routingStrategy}`);
    logger.info(`   工具数量: ${toolAdapters.length}`);

    return finalResult;
  }

  /**
   * 获取工具适配器列表
   */
  _getToolAdapters () {
    const adapters = [];
    for (const agentName of this.hub.getEnabledAgents().map(a => a.name)) {
      const agentInfo = this.hub.getAgent(agentName);
      if (agentInfo?.toolAdapter && agentInfo.toolAdapter.isAvailable && agentInfo.toolAdapter.isAvailable()) {
        adapters.push(agentInfo.toolAdapter);
      }
    }
    return adapters;
  }

  // ─────────────────────── 并行模式（带限流分批）───────────────────────
  async _dispatchParallel (taskDescription, agentNames, options = {}) {
    logger.info(`⚡ 并行模式: 同时执行 ${agentNames.length} 个 Agent\n`);

    const limit = this.options.parallelLimit;
    const chunks = [];
    for (let i = 0; i < agentNames.length; i += limit) {
      chunks.push(agentNames.slice(i, i + limit));
    }

    let successful = 0; let failed = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunks.length > 1) {
        logger.info(`📦 第 ${i + 1}/${chunks.length} 批: ${chunk.join(', ')}`);
      }
      const promises = chunk.map(name => this._dispatchWithRetry(name, taskDescription, options));
      const results = await Promise.allSettled(promises);

      results.forEach((result, j) => {
        const agentName = chunk[j];
        this._recordResult(agentName, result);
        if (result.status === 'fulfilled') {
          successful++; logger.info(`✅ ${agentName} 完成`);
        } else {
          failed++; logger.warn(`❌ ${agentName} 失败: ${result.reason.message}`);
        }
      });
    }

    return this._formatResults(agentNames, { successful, failed });
  }

  // ─────────────────────── 顺序模式 ───────────────────────
  async _dispatchSequential (taskDescription, agentNames, options = {}) {
    logger.info(`📜 顺序模式: 依次执行 ${agentNames.length} 个 Agent\n`);
    let successful = 0; let failed = 0;

    for (let i = 0; i < agentNames.length; i++) {
      const agentName = agentNames[i];
      logger.info(`\n[${i + 1}/${agentNames.length}] 执行 Agent: ${agentName}`);
      try {
        const result = await this._dispatchWithRetry(agentName, taskDescription, options);
        this.results.set(agentName, result);
        successful++; this.stats.completedTasks++;
        logger.info(`✅ ${agentName} 完成`);
      } catch (e) {
        this.results.set(agentName, { error: e.message });
        failed++; this.stats.failedTasks++;
        logger.warn(`❌ ${agentName} 失败: ${e.message}`);
      }
      this._updateStats(agentName, this.results.get(agentName));
    }
    return this._formatResults(agentNames, { successful, failed });
  }

  // ─────────────────────── 选择最佳模式 ───────────────────────
  async _dispatchSelectBest (taskDescription, agentNames, options = {}) {
    logger.info('🏆 选择最佳模式: 测试所有 Agent 并选择最优结果\n');
    const results = [];

    for (let i = 0; i < agentNames.length; i++) {
      const agentName = agentNames[i];
      logger.info(`\n[${i + 1}/${agentNames.length}] 测试 Agent: ${agentName}...`);
      try {
        const result = await this._dispatchWithRetry(agentName, taskDescription, options);
        this.results.set(agentName, result);
        const qualityScore = this._calculateQualityScore(result);
        results.push({ agentName, result, qualityScore });
        logger.info(`✅ ${agentName} 完成 (质量: ${qualityScore}分)`);
      } catch (e) {
        logger.warn(`❌ ${agentName} 失败: ${e.message}`);
        this.results.set(agentName, { error: e.message });
      }
    }

    if (results.length === 0) {
      return { error: '所有 Agent 都失败了', results: {} };
    }

    results.sort((a, b) => b.qualityScore - a.qualityScore);
    const best = results[0];

    logger.info(`\n🏆 最佳结果来自: ${best.agentName} (质量: ${best.qualityScore}分)`);
    logger.info('📊 排名:');
    results.forEach((r, i) => {
      logger.info(`   ${i + 1}. ${r.agentName} - ${r.qualityScore}分`);
    });

    return {
      best: { agent: best.agentName, result: best.result, qualityScore: best.qualityScore },
      ranking: results.map(r => ({ agent: r.agentName, qualityScore: r.qualityScore })),
      allResults: Object.fromEntries(this.results),
      compared: results,
      stats: this.stats
    };
  }

  // ─────────────────────── 级联模式（失败接管 + 质量接管）───────────────────────
  async _dispatchCascade (taskDescription, agentNames, options = {}) {
    logger.info('🔄 级联模式: 依次执行，失败则由下一个 Agent 接管\n');
    let lastResult = null; let successfulAgent = null;
    const failAnalysis = [];

    for (let i = 0; i < agentNames.length; i++) {
      const agentName = agentNames[i];
      logger.info(`\n[${i + 1}/${agentNames.length}] 尝试 Agent: ${agentName}`);
      try {
        const result = await this._dispatchWithRetry(agentName, taskDescription, options);
        this.results.set(agentName, result);
        const qualityScore = this._calculateQualityScore(result);

        if (qualityScore >= (options.minQuality || 70)) {
          lastResult = result; successfulAgent = agentName;
          logger.info(`✅ ${agentName} 完成 (质量: ${qualityScore}分) - 达到合格线`);
          break;
        } else {
          logger.warn(`${agentName} 质量不足 (${qualityScore}分) - 继续下一个`);
          failAnalysis.push({ agent: agentName, reason: `质量不足: ${qualityScore}分`, qualityScore });
        }
      } catch (e) {
        logger.warn(`${agentName} 失败: ${e.message} - 继续下一个`);
        this.results.set(agentName, { error: e.message });
        failAnalysis.push({ agent: agentName, reason: e.message, qualityScore: 0 });
      }
    }

    if (!successfulAgent) {
      return {
        error: '级联失败，所有 Agent 均未达到质量要求',
        failAnalysis,
        results: Object.fromEntries(this.results)
      };
    }

    return {
      successfulAgent,
      result: lastResult,
      qualityScore: this._calculateQualityScore(lastResult),
      failAnalysis,
      allResults: Object.fromEntries(this.results),
      stats: this.stats
    };
  }

  // ─────────────────────── 合并模式（新增）───────────────────────
  async _dispatchMerge (taskDescription, agentNames, options = {}) {
    logger.info('🧩 合并模式: 执行所有 Agent 并融合最佳部分\n');

    // 1. 先并行执行所有 Agent
    const parallelResult = await this._dispatchParallel(taskDescription, agentNames, options);

    const successfulResults = {};
    for (const [name, result] of this.results.entries()) {
      if (result && result.success) {
        successfulResults[name] = result;
      }
    }

    const successfulCount = Object.keys(successfulResults).length;
    if (successfulCount === 0) {
      return { ...parallelResult, mergeResult: null, error: '没有可合并的结果' };
    }

    if (successfulCount === 1) {
      const onlyAgent = Object.keys(successfulResults)[0];
      logger.info(`\n⚠️ 仅 ${onlyAgent} 成功，无需合并`);
      return { ...parallelResult, mergeResult: null, singleResult: successfulResults[onlyAgent] };
    }

    // 2. 使用 MergeEngine 合并
    logger.info(`\n🧩 开始合并 ${successfulCount} 个 Agent 的产出...`);
    const mergeEngine = this._getMergeEngine(options);
    const mergeResult = await mergeEngine.merge(successfulResults, options.constraints || {});

    logger.info('\n✅ 合并完成！');
    logger.info(`   文件数: ${Object.keys(mergeResult.mergedFiles || {}).length}`);
    logger.info(`   冲突数: ${mergeResult.conflicts?.length || 0}`);
    logger.info(`   改进数: ${mergeResult.improvements?.length || 0}`);
    logger.info(`   整体质量: ${mergeResult.qualityAssessment?.overall || 'N/A'}分`);

    // 3. 如果一致性问题严重，额外提示
    if (mergeResult.consistencyCheck?.issues?.length > 0) {
      logger.warn('\n⚠️ 一致性问题:');
      mergeResult.consistencyCheck.issues.forEach(issue => logger.warn(`   - ${issue}`));
    }

    // 4. 保存合并结果
    const fs = require('fs');
    const path = require('path');
    const mergeDir = path.join(this.options.outputDir, 'merged');
    if (!fs.existsSync(mergeDir)) fs.mkdirSync(mergeDir, { recursive: true });
    for (const [filePath, code] of Object.entries(mergeResult.mergedFiles || {})) {
      fs.writeFileSync(path.join(mergeDir, filePath.replace(/\//g, '_')), code, 'utf-8');
    }

    return {
      ...parallelResult,
      mergeResult,
      mergedFiles: mergeResult.mergedFiles,
      mergedCode: mergeResult.mergedCode,
      mergeQuality: mergeResult.qualityAssessment,
      mergeDir
    };
  }

  _getMergeEngine (options) {
    if (!this.mergeEngine) {
      // 使用第一个成功结果的 provider 作为合并引擎的 provider
      const firstAgent = this.hub.getEnabledAgents()[0];
      const provider = firstAgent?.provider || this.hub.getAgent('ollama')?.provider;
      this.mergeEngine = new MergeEngine(provider, { conflictResolution: this.options.conflictResolution });
    }
    return this.mergeEngine;
  }

  // ─────────────────────── 辅助方法 ───────────────────────
  async _dispatchWithRetry (agentName, taskDescription, options = {}) {
    const maxRetries = this.options.retryCount;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) logger.info(`   🔄 第 ${attempt} 次重试...`);
        return await this._dispatchToAgent(agentName, taskDescription, options);
      } catch (e) {
        lastError = e;
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
    throw lastError;
  }

  async _dispatchToAgent (agentName, taskDescription, options = {}) {
    const agentInfo = this.hub.getAgent(agentName);
    if (!agentInfo || !agentInfo.provider) {
      throw new Error(`Agent ${agentName} 未找到或未启用`);
    }

    const startTime = Date.now();
    const orchestrator = new TaskOrchestrator(agentInfo.provider, {
      workspaceDir: options.workspaceDir || `${this.options.outputDir}/${agentName}`,
      enableCache: options.enableCache !== false,
      enableCompression: options.enableCompression !== false,
      enableModelRouting: false
    });

    await orchestrator.initialize();
    const result = await orchestrator.runTask(taskDescription, options.context);

    const report = orchestrator.reportGenerator.generateReport(result);
    const filePath = orchestrator.reportGenerator.saveReport(report);
    const duration = Date.now() - startTime;

    this._ensureStats(agentName);
    this.stats.byAgent[agentName].duration += duration;

    return {
      success: true,
      agent: agentName,
      result,
      reportId: report.id,
      reportPath: filePath,
      outputDir: result.outputDir,
      duration,
      tokenUsage: result.tokenStats || {}
    };
  }

  _recordResult (agentName, result) {
    if (result.status === 'fulfilled') {
      this.results.set(agentName, result.value);
      this.stats.completedTasks++;
    } else {
      this.results.set(agentName, { error: result.reason.message });
      this.stats.failedTasks++;
    }
    this._updateStats(agentName, result.status === 'fulfilled' ? result.value : { error: result.reason.message });
  }

  _updateStats (agentName, result) {
    this._ensureStats(agentName);
    if (result && result.success) {
      this.stats.byAgent[agentName].success++;
    } else {
      this.stats.byAgent[agentName].failed++;
    }
  }

  _ensureStats (agentName) {
    if (!this.stats.byAgent[agentName]) {
      this.stats.byAgent[agentName] = { success: 0, failed: 0, duration: 0 };
    }
  }

  _calculateQualityScore (result) {
    if (!result || !result.success) return 0;
    const taskResult = result.result;
    if (!taskResult) return 0;

    let score = 0;
    if (taskResult.quality?.qualityScore) {
      score = taskResult.quality.qualityScore;
    } else if (taskResult.tasks) {
      const scores = taskResult.tasks.filter(t => t.qualityScore).map(t => t.qualityScore);
      score = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 60;
    } else {
      score = 60;
    }

    if (taskResult.successRate !== undefined) {
      score = Math.round(score * 0.7 + taskResult.successRate * 0.3);
    }
    if (result.duration) {
      const durationSec = result.duration / 1000;
      if (durationSec < 30) score += 5;
      else if (durationSec > 300) score -= 5;
    }
    return Math.max(0, Math.min(100, score));
  }

  _getDefaultAgents () {
    return this.hub.getEnabledAgents().map(a => a.name);
  }

  _formatResults (agentNames, stats) {
    const results = {};
    for (const [name, result] of this.results.entries()) {
      results[name] = result;
    }
    return {
      results,
      stats: this.stats,
      summary: {
        total: stats.successful + stats.failed,
        successful: stats.successful,
        failed: stats.failed,
        successRate: Math.round((stats.successful / (stats.successful + stats.failed)) * 100) || 0,
        duration: this.stats.duration
      }
    };
  }

  getHub () {
    return this.hub;
  }

  getStats () {
    return this.stats;
  }

  getResults () {
    return Object.fromEntries(this.results);
  }

  /** 委托方法：代理到 AgentHub */
  async listAgents () {
    return this.hub.getAllAgents();
  }

  async checkAgents () {
    return this.hub.checkAllConnections();
  }

  enableAgent (name) {
    return this.hub.enableAgent(name);
  }

  disableAgent (name) {
    return this.hub.disableAgent(name);
  }

  getModes () {
    return [
      { name: 'parallel', description: '并行模式 - 同时执行所有 Agent' },
      { name: 'sequential', description: '顺序模式 - 依次执行每个 Agent' },
      { name: 'select', description: '选择最佳 - 执行所有 Agent 并选择质量最高的结果' },
      { name: 'cascade', description: '级联模式 - 依次执行，失败或质量不足则由下一个接管' },
      { name: 'merge', description: '合并模式 - 执行所有 Agent 并融合最佳部分' },
      { name: 'privacy', description: '隐私模式 - 本地拆分+质检，云端工具各拿碎片，契约拼装' },
      { name: 'quality', description: '高质量模式 - 云端拆分+质检+AI合并，工具各拿碎片，追求最佳质量' }
    ];
  }

  /**
   * 获取路由策略列表
   */
  getRoutingStrategies () {
    const router = this._getTaskRouter();
    return router.getStrategies();
  }

  /**
   * 获取工具能力表
   */
  getToolCapabilities () {
    const router = this._getTaskRouter();
    return router.options.capabilities;
  }

  /**
   * 设置路由策略
   */
  setRoutingStrategy (strategy, manualRouting = {}) {
    this.options.routingStrategy = strategy;
    this.options.manualRouting = manualRouting;
    this.taskRouter = null; // 重置路由器
  }

  /**
   * 设置隐私模式
   */
  setPrivacyMode (enabled) {
    this.options.privacyMode = enabled;
  }

  /**
   * 设置手动路由表
   */
  setManualRouting (routingTable) {
    this.options.manualRouting = routingTable;
    if (this.taskRouter) {
      this.taskRouter.setManualRouting(routingTable);
    }
  }
}

module.exports = MultiAgentDispatcher;
