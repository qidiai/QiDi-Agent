const EventEmitter = require('events');
const AgentFactory = require('../agents');
const FileManager = require('../utils/FileManager');
const MemoryStore = require('./MemoryStore');
const TokenCounter = require('../utils/TokenCounter');
const ContextCompressor = require('../utils/ContextCompressor');
const CacheStore = require('../utils/CacheStore');
const ModelRouter = require('../utils/ModelRouter');
const ExperimentReportGenerator = require('../utils/ExperimentReportGenerator');
const TaskRouter = require('./TaskRouter');
const ContractAssembler = require('./ContractAssembler');
const ExecutionModeManager = require('./ExecutionModeManager');
const TaskScheduler = require('./TaskScheduler');
const TaskExecutor = require('./TaskExecutor');

/**
 * 任务编排器（门面）：负责完整的任务生命周期管理。
 * 包括：分解 → 执行（含缓存/压缩/路由/质检）→ 合并 → 报告。
 *
 * 职责拆分：
 * - TaskScheduler: 任务状态管理、依赖调度、执行循环、重试逻辑
 * - TaskExecutor:  单任务执行、工具分派、缓存/压缩/路由、质量检查
 * - TaskOrchestrator: 配置聚合、事件发射、生命周期协调
 */
class TaskOrchestrator extends EventEmitter {
  constructor(provider, options = {}) {
    super();
    this.provider = provider;
    this.options = options;

    // ═══════════════ 基础设施 ═══════════════
    this.fileManager = new FileManager(options.workspaceDir);
    this.memory = new MemoryStore({
      persistDir: options.memoryDir || './memory',
      persistFile: `session_${Date.now()}.json`
    });
    this.tokenCounter = new TokenCounter({ maxHistory: options.maxTokenHistory || 200 });
    this.contextCompressor = new ContextCompressor({
      maxContextTokens: options.maxContextTokens || 1500,
      keepSignatures: true, keepComments: false
    });
    this.cacheStore = new CacheStore({
      maxSize: options.cacheSize || 100,
      maxAge: options.cacheAge || 3600000,
      similarityThreshold: 0.75
    });
    this.modelRouter = new ModelRouter({
      largeModel: options.largeModel || process.env.OLLAMA_MODEL || 'qwen2.5:7b',
      smallModel: options.smallModel || process.env.OLLAMA_MODEL_SMALL || 'qwen2.5:3b'
    });
    this.reportGenerator = new ExperimentReportGenerator({
      reportDir: options.reportDir || './reports',
      maxReports: options.maxReports || 50
    });

    this.toolAdapters = options.toolAdapters || [];
    this.enableFinalQualityGate = options.enableFinalQualityGate !== false;
    this.strictMode = options.strictMode !== false;
    this.maxResplits = options.maxResplits || 2;

    // ═══════════════ 执行模式 ═══════════════
    this.modeManager = new ExecutionModeManager();
    if (options.executionMode) {
      this.modeManager.setMode(options.executionMode);
    }

    const modeConfig = this.modeManager.getModeConfig();
    this.privacyMode = modeConfig.privacy.enabled;
    this.routingStrategy = options.routingStrategy || modeConfig.routing.defaultStrategy;
    this.manualRouting = options.manualRouting || {};
    this.toolRouter = null;

    // ═══════════════ Agents ═══════════════
    const qualityConfig = modeConfig.qualityCheck;
    this.agents = AgentFactory.createAll(provider, {
      splitter: {
        enableSelfCheck: modeConfig.splitter.enableSelfCheck,
        maxSubtasks: modeConfig.splitter.maxSubtasks
      },
      qualityChecker: {
        enableStaticCheck: qualityConfig.enableStaticCheck,
        enableCompilation: qualityConfig.enableCompilation,
        enableLint: qualityConfig.enableLint,
        enableTest: qualityConfig.enableTest,
        minQualityScore: qualityConfig.minQualityScore,
        enableAI: qualityConfig.enableAI,
        dimensions: qualityConfig.dimensions
      }
    });

    // ═══════════════ 契约拼装 ═══════════════
    const mergingConfig = modeConfig.merging;
    this.contractAssembler = new ContractAssembler({
      strictMode: options.contractStrictMode ?? mergingConfig.contractStrict,
      autoAdapt: options.contractAutoAdapt ?? mergingConfig.autoAdapt,
      supportedLanguages: options.contractLanguages || ['c', 'python', 'javascript', 'typescript', 'java', 'go', 'rust'],
      enableAIAssist: mergingConfig.localModelAssist ?? true,
      localModel: mergingConfig.localModelAssist ? this.provider : null
    });
    this.enableContractAssembly = options.enableContractAssembly ?? mergingConfig.strategy === 'contract';

    // ═══════════════ 子模块 ═══════════════
    this.scheduler = new TaskScheduler({
      strictMode: this.strictMode,
      maxRetries: options.maxRetries || 2
    });

    this.executor = new TaskExecutor({
      privacyMode: this.privacyMode,
      routingStrategy: this.routingStrategy,
      maxRetries: options.maxRetries || 2,
      enableCache: options.enableCache !== false,
      enableCompression: options.enableCompression !== false,
      enableModelRouting: options.enableModelRouting !== false,
      enableContractAssembly: this.enableContractAssembly,
      cacheStore: this.cacheStore,
      tokenCounter: this.tokenCounter,
      contextCompressor: this.contextCompressor,
      modelRouter: this.modelRouter,
      fileManager: this.fileManager,
      agents: this.agents,
      memory: this.memory,
      contractAssembler: this.contractAssembler,
      toolAdapters: this.toolAdapters,
      _getTaskRouter: () => this._getTaskRouter()
    });

    // 任务状态
    this.tasks = [];
    this.results = {};
    this.currentTaskIndex = -1;
    this.isRunning = false;
    this._currentRunId = null;
  }

  // ── 路由器 ──

  _getTaskRouter() {
    if (!this.toolRouter) {
      this.toolRouter = new TaskRouter(this.toolAdapters, {
        strategy: this.routingStrategy,
        manualRouting: this.manualRouting,
        privacyMode: this.privacyMode,
        toolOnlyMode: this.privacyMode
      });
    }
    return this.toolRouter;
  }

  // ── 公共 API（配置） ──

  getRoutingStrategies() { return this._getTaskRouter().getStrategies(); }
  getToolCapabilities() { return this._getTaskRouter().options.capabilities; }
  getModeManager() { return this.modeManager; }
  getExecutionMode() { return this.modeManager.getCurrentMode(); }

  setExecutionMode(modeName) {
    const modeConfig = this.modeManager.setMode(modeName);
    this.privacyMode = modeConfig.privacy.enabled;
    this.routingStrategy = modeConfig.routing.defaultStrategy;
    this.enableContractAssembly = modeConfig.merging.strategy === 'contract';
    this.toolRouter = null;
    return modeConfig;
  }

  getExecutionModes() { return this.modeManager.getAllModes(); }
  setToolCapabilities(capabilities) { this._getTaskRouter().setCapabilities(capabilities); }
  setManualRouting(routingTable) {
    this.manualRouting = routingTable;
    this._getTaskRouter().setManualRouting(routingTable);
  }

  // ── 生命周期 ──

  async initialize() {
    this.emit('init', { provider: this.provider.name });
    this.tokenCounter.reset();
    this.modelRouter.reset();
    return true;
  }

  async runTask(taskDescription, context = {}) {
    if (this.isRunning) {
      throw new Error('已有任务正在运行');
    }

    this.isRunning = true;
    this.tasks = [];
    this.results = {};
    this.memory.clear();

    // 生成运行 ID（用于 checkpoint）
    this._currentRunId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    try {
      this.emit('taskStart', { task: taskDescription });

      const projectContext = {
        ...context,
        fileStructure: this.fileManager.getFileTree('.', 3),
        existingFiles: this.fileManager.listFiles('.').join('\n')
      };

      // 1. 智能分解
      const splitResult = await this._splitTask(taskDescription, projectContext);

      if (splitResult.constraints) {
        for (const [key, value] of Object.entries(splitResult.constraints)) {
          this.memory.setGlobal(key, value);
        }
      }

      this.tasks = splitResult.subtasks.map(t => ({
        ...t, status: 'pending', result: null, retries: 0, qualityChecks: []
      }));

      this.emit('taskSplit', {
        overview: splitResult.taskOverview, tasks: this.tasks,
        plan: splitResult.overallPlan, constraints: splitResult.constraints || {},
        coverageCheck: splitResult.coverageCheck || {},
        dependencyGraph: splitResult.dependencyGraph || {}
      });

      // 2. 执行（委托给 Scheduler + Executor）
      await this.scheduler.executeLoop(
        this.tasks,
        (task, ctx) => this.executor.executeSingleTask(task, {
          ...ctx, orchestrator: this, saveToMemory: (t, r) => this.executor._saveToMemory(t, r),
          completedCountIncrement: () => {} // scheduler tracks internally
        }),
        {
          constraints: this.memory.getAllGlobals(),
          previousTasks: this.tasks.filter(t => t.status === 'completed')
        },
        this._currentRunId
      );

      // 3. 最终审查与合并
      const finalResult = await this._finalReview(taskDescription, splitResult);

      this.emit('taskComplete', {
        success: true, result: finalResult, tasks: this.tasks,
        constraints: splitResult.constraints || {}
      });

      // 4. 生成报告
      const reportResult = this.reportGenerator.generateAndSave(finalResult, {
        fileList: this.fileManager.listFiles('./output')
      });
      this.emit('reportGenerated', {
        reportId: reportResult.report.id, filePath: reportResult.filePath
      });

      this.isRunning = false;
      finalResult.reportId = reportResult.report.id;
      finalResult.reportPath = reportResult.filePath;
      return finalResult;

    } catch (error) {
      this.emit('taskError', { error: error.message });
      this.isRunning = false;
      throw error;
    }
  }

  async _splitTask(taskDescription, context) {
    this.emit('splitting', { task: taskDescription });
    const result = await this.agents.splitter.splitTask(taskDescription, context);
    return result;
  }

  // ── 最终审查 ──

  async _finalReview(originalTask, splitResult) {
    const completedTasks = this.tasks.filter(t => t.status === 'completed');
    const failedTasks = this.tasks.filter(t => t.status === 'failed');
    const needsRevisionTasks = this.tasks.filter(t => t.status === 'needs_revision');

    const summary = {
      originalTask,
      totalTasks: this.tasks.length,
      completedTasks: completedTasks.length,
      failedTasks: failedTasks.length,
      needsRevisionTasks: needsRevisionTasks.length,
      successRate: this.tasks.length > 0
        ? Math.round((completedTasks.length / this.tasks.length) * 100) : 0,
      constraints: this.memory.getAllGlobals(),
      tasks: this.tasks.map(t => ({
        id: t.id, title: t.title, status: t.status,
        qualityScore: t.result?.quality?.qualityScore || null,
        toolResults: t.result?.quality?.toolResults || null,
        toolName: t.result?.toolName || null,
        privacyMode: t.result?.privacyMode || false
      })),
      outputDir: this.fileManager.workspaceDir,
      tokenStats: this.tokenCounter.getStats(),
      cacheStats: this.cacheStore.getStats(),
      modelStats: this.modelRouter.getStats(),
      coverageCheck: splitResult.coverageCheck || {},
      dependencyValidation: this.scheduler._validateAllDependencies(this.tasks),
      privacyMode: this.privacyMode
    };

    // 契约拼装（隐私模式）
    if (this.privacyMode && this.enableContractAssembly && completedTasks.length > 0) {
      const contractResult = await this._assembleContracts(completedTasks, splitResult);
      summary.contractAssembly = contractResult;

      if (contractResult.success) {
        summary.assembledCode = contractResult.code;
        summary.contractReport = this.contractAssembler.getAssemblyReport();
        this.emit('contractAssemblyComplete', {
          contracts: contractResult.contracts,
          conflicts: contractResult.conflicts,
          assembledCode: contractResult.code
        });
      } else {
        summary.contractAssemblyWarning = contractResult.error;
        this.emit('contractAssemblyFailed', {
          error: contractResult.error, issues: contractResult.issues
        });
      }
    }

    // 最终质检
    if (this.enableFinalQualityGate && completedTasks.length > 0) {
      const finalQuality = await this._finalQualityGate(originalTask, summary);
      summary.finalQuality = finalQuality;
      if (!finalQuality.canProceed) {
        summary.finalQualityWarning = '最终质检未通过，产出需要人工审查';
        this.emit('finalQualityWarning', {
          quality: finalQuality, warning: summary.finalQualityWarning
        });
      } else {
        this.emit('finalQualityPassed', { quality: finalQuality });
      }
    }

    this.emit('tokenReport', {
      tokenStats: this.tokenCounter.getStats(),
      cacheStats: this.cacheStore.getStats(),
      modelStats: this.modelRouter.getStats()
    });

    return summary;
  }

  async _assembleContracts(completedTasks, splitResult) {
    const allCodeBlocks = completedTasks
      .filter(t => t.result?.codeBlocks)
      .flatMap(t => t.result.codeBlocks.map(b => ({
        ...b, taskId: t.id, toolName: t.result?.toolName || 'unknown'
      })));

    if (allCodeBlocks.length === 0) {
      return { success: false, error: '没有可拼装的代码产出', contracts: null };
    }

    this.emit('contractExtractionStart', { codeBlocks: allCodeBlocks.length });
    const contracts = await this.contractAssembler.extractContracts(allCodeBlocks);

    this.emit('contractValidationStart', { contracts: contracts.length });
    const validation = this.contractAssembler.validateContracts(contracts);

    if (!validation.valid) {
      this.emit('contractConflict', {
        issues: validation.issues, warnings: validation.warnings.length, errors: validation.errors.length
      });
    }

    const targetLanguage = this.memory.getGlobal('language') ||
      splitResult.constraints?.language || contracts[0]?.language || 'c';

    this.emit('contractAssemblyStart', {
      language: targetLanguage, contracts: contracts.length, validation: validation.valid
    });
    const assemblyResult = this.contractAssembler.assemble(contracts, {
      language: targetLanguage, strictMode: false
    });

    if (assemblyResult.success && assemblyResult.code) {
      const assemblyDir = `${this.fileManager.workspaceDir}/assembled`;
      const assemblyFile = `${assemblyDir}/${targetLanguage === 'c' ? 'main.h' : `main.${this.executor._getExtFromLanguage(targetLanguage)}`}`;
      try {
        this.fileManager.writeFile(assemblyFile, assemblyResult.code);
        assemblyResult.assemblyFilePath = assemblyFile;
      } catch (e) {
        assemblyResult.saveError = e.message;
      }
    }

    return {
      success: assemblyResult.success, contracts: assemblyResult.contracts,
      conflicts: assemblyResult.conflicts, issues: validation.issues,
      warnings: validation.warnings, code: assemblyResult.code,
      language: targetLanguage, privacyProtected: true
    };
  }

  async _finalQualityGate(originalTask, summary) {
    const allCode = this.tasks
      .filter(t => t.status === 'completed' && t.result?.codeBlocks)
      .flatMap(t => t.result.codeBlocks);

    if (allCode.length === 0) {
      return { canProceed: true, qualityScore: 100, status: 'completed', message: '无代码产出，跳过最终质检' };
    }

    const mergedOutput = allCode.map(b => `\`\`\`${b.language}\n${b.code}\n\`\`\``).join('\n\n');

    return await this.agents.qualityChecker.checkQuality(
      { id: 'final', title: '最终合并产物审查', description: originalTask },
      mergedOutput,
      { constraints: this.memory.getAllGlobals(), isFinalReview: true }
    );
  }

  // ── 状态查询 ──

  getFullReport() {
    return this.tokenCounter.getReport() + this.cacheStore.getReport() + this.modelRouter.getReport();
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      currentTask: this.currentTaskIndex >= 0 ? this.tasks[this.currentTaskIndex] : null,
      tasks: this.tasks,
      completedCount: this.tasks.filter(t => t.status === 'completed').length,
      totalCount: this.tasks.length,
      constraints: this.memory.getAllGlobals(),
      tokenStats: this.tokenCounter.getStats(),
      cacheStats: this.cacheStore.getStats()
    };
  }

  getRecentReports(count = 5) { return this.reportGenerator.getRecentReports(count); }
  listReports() { return this.reportGenerator.listReports(); }
  searchReports(query) { return this.reportGenerator.searchReports(query); }
  loadReport(reportId) { return this.reportGenerator.loadReport(reportId); }

  // ═══════════════════════════════════════════
  // 暂停/恢复 API
  // ═══════════════════════════════════════════

  /**
   * 暂停当前运行的任务
   */
  async pause() {
    if (!this.isRunning) {
      throw new Error('当前没有正在运行的任务');
    }
    await this.scheduler.pause();
    this.emit('taskPaused', { runId: this._currentRunId });
  }

  /**
   * 恢复暂停的任务
   */
  resume() {
    if (!this.isRunning) {
      throw new Error('当前没有正在运行的任务');
    }
    this.scheduler.resume();
    this.emit('taskResumed', { runId: this._currentRunId });
  }

  /**
   * 检查任务是否已暂停
   */
  isPaused() {
    return this.scheduler.isPaused();
  }

  // ═══════════════════════════════════════════
  // Checkpoint API
  // ═══════════════════════════════════════════

  /**
   * 手动保存 checkpoint
   */
  saveCheckpoint() {
    if (!this._currentRunId) {
      throw new Error('当前没有运行中的任务');
    }
    const filePath = this.scheduler.saveCheckpoint(this._currentRunId, this.tasks, {
      memory: this.memory.getAll(),
      tokenStats: this.tokenCounter.getStats(),
      cacheStats: this.cacheStore.getStats()
    });
    this.emit('checkpointSaved', { runId: this._currentRunId, filePath });
    return filePath;
  }

  /**
   * 列出所有可用的 checkpoint
   */
  listCheckpoints() {
    return this.scheduler.listCheckpoints();
  }

  /**
   * 从 checkpoint 恢复（用于断点续传）
   * @param {string} runId - 要恢复的 checkpoint runId
   * @returns {Object} 恢复的任务状态
   */
  restoreCheckpoint(runId) {
    const checkpoint = this.scheduler.loadCheckpoint(runId);
    if (!checkpoint) {
      throw new Error(`Checkpoint 不存在: ${runId}`);
    }

    // 恢复任务状态
    this.tasks = checkpoint.tasks.map(t => ({
      ...t,
      result: t.result && t.result.content
        ? { content: t.result.content, quality: { qualityScore: t.result.qualityScore }, codeBlocks: [] }
        : t.result
    }));

    // 恢复已完成的任务状态
    this.tasks.forEach(t => {
      if (t.status === 'completed') {
        // 已完成的标记为 completed，调度器会跳过
      } else if (t.status === 'failed' || t.status === 'needs_revision') {
        // 失败的任务可以重新执行
        t.status = 'pending';
        t.retries = 0;
      }
      // pending 状态的任务将从这里继续
    });

    this._currentRunId = runId;
    this.emit('checkpointRestored', {
      runId,
      completedCount: this.tasks.filter(t => t.status === 'completed').length,
      totalCount: this.tasks.length
    });

    return checkpoint;
  }

  /**
   * 删除 checkpoint
   */
  deleteCheckpoint(runId) {
    return this.scheduler.deleteCheckpoint(runId);
  }

  /**
   * 清理过期 checkpoint
   */
  cleanOldCheckpoints(maxDays = 7) {
    return this.scheduler.cleanOldCheckpoints(maxDays);
  }

  getHistoricalContext(count = 3) {
    const recentReports = this.reportGenerator.getRecentReports(count);
    return this.reportGenerator.getContextSummary(recentReports.map(r => r.id));
  }
  getReportGenerator() { return this.reportGenerator; }
}

module.exports = TaskOrchestrator;
