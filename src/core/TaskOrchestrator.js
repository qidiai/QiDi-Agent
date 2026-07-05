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
const ToolLearning = require('./ToolLearning');
const AdaptiveOrchestrator = require('./AdaptiveOrchestrator');
const logger = require('../utils/Logger').createLogger('TaskOrchestrator');

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
  constructor (provider, options = {}) {
    super();
    this.provider = provider;
    this.options = options;
    this.providers = options.providers || [provider];

    // ═══════════════ 基础设施 ═══════════════
    this.fileManager = new FileManager(options.workspaceDir);
    this.memory = new MemoryStore({
      persistDir: options.memoryDir || './memory',
      persistFile: `session_${Date.now()}.json`
    });
    this.tokenCounter = new TokenCounter({ maxHistory: options.maxTokenHistory || 200 });
    this.contextCompressor = new ContextCompressor({
      maxContextTokens: options.maxContextTokens || 1500,
      keepSignatures: true,
      keepComments: false
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
    this.multiProviderMode = modeConfig.codeGeneration?.multiProviderMode || false;

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

    // ═══════════════ 被拒计数器与人工审批 ═══════════════
    this.rejectionCounter = {
      consecutiveFailures: 0,
      maxConsecutiveFailures: options.maxConsecutiveFailures || 3,
      enabled: options.enableRejectionCounter !== false,
      requiresHumanApproval: false,
      lastApprovalTime: null,
      approvalHistory: []
    };

    // ═══════════════ P0-P3 增强模块接入 ═══════════════
    this.testRunner = options.testRunner || null;
    this.budgetManager = options.budgetManager || null;
    this.gitIntegration = options.gitIntegration || null;
    this.sandboxExecutor = options.sandboxExecutor || null;
    this.approvalWorkflow = options.approvalWorkflow || null;
    this.streamManager = options.streamManager || null;
    this.vectorMemory = options.vectorMemory || null;
    this.contractValidator = options.contractValidator || null;
    this.retryManager = options.retryManager || null;
    this.mcpClient = options.mcpClient || null;

    // 将 TestRunner 注入 TesterAgent
    if (this.testRunner && this.agents.tester) {
      this.agents.tester.setTestRunner(this.testRunner);
    }

    // 将 MCP 工具适配器纳入路由池
    if (this.mcpClient) {
      const mcpAdapters = this.mcpClient.getToolAdapters();
      if (mcpAdapters.length > 0) {
        this.toolAdapters = [...this.toolAdapters, ...mcpAdapters];
        this.toolRouter = null; // 强制重建路由器
      }
    }

    this.executor = new TaskExecutor({
      privacyMode: this.privacyMode,
      routingStrategy: this.routingStrategy,
      maxRetries: options.maxRetries || 2,
      enableCache: options.enableCache !== false,
      enableCompression: options.enableCompression !== false,
      enableModelRouting: options.enableModelRouting !== false,
      enableContractAssembly: this.enableContractAssembly,
      multiProviderMode: this.multiProviderMode,
      cacheStore: this.cacheStore,
      tokenCounter: this.tokenCounter,
      contextCompressor: this.contextCompressor,
      modelRouter: this.modelRouter,
      fileManager: this.fileManager,
      agents: this.agents,
      memory: this.memory,
      contractAssembler: this.contractAssembler,
      toolAdapters: this.toolAdapters,
      providers: this.providers,
      _getTaskRouter: () => this._getTaskRouter(),
      // P0-P3 增强模块
      testRunner: this.testRunner,
      budgetManager: this.budgetManager,
      gitIntegration: this.gitIntegration,
      sandboxExecutor: this.sandboxExecutor,
      approvalWorkflow: this.approvalWorkflow,
      streamManager: this.streamManager,
      vectorMemory: this.vectorMemory,
      contractValidator: this.contractValidator,
      retryManager: this.retryManager
    });

    // 任务状态
    this.tasks = [];
    this.results = {};
    this.currentTaskIndex = -1;
    this.isRunning = false;
    this._currentRunId = null;

    this.toolLearning = new ToolLearning({
      learningDir: options.learningDir || './config/tool_learning'
    });

    // ═══════════════ 自适应智能编排器 ═══════════════
    this.adaptiveOrchestrator = new AdaptiveOrchestrator({
      capabilityTree: this.modeManager.capabilityTree,
      toolLearning: this.toolLearning,
      orchestrationMode: options.orchestrationMode || 'hybrid', // auto/manual/hybrid
      privacySensitivity: options.privacySensitivity,
      qualityPriority: options.qualityPriority,
      efficiencyPriority: options.efficiencyPriority,
      maxParallelTools: options.maxParallelTools,
      preferredTools: options.preferredTools,
      excludedTools: options.excludedTools,
      learningDir: options.learningDir
    });
  }

  // ── 路由器 ──

  _getTaskRouter () {
    if (!this.toolRouter) {
      this.toolRouter = new TaskRouter(this.toolAdapters, {
        strategy: this.routingStrategy,
        topN: this.options.topN || 3,
        manualRouting: this.manualRouting,
        privacyMode: this.privacyMode,
        toolOnlyMode: this.privacyMode,
        toolLearning: this.toolLearning
      });
    }
    return this.toolRouter;
  }

  // ── 公共 API（配置） ──

  getRoutingStrategies () {
    return this._getTaskRouter().getStrategies();
  }

  getToolCapabilities () {
    return this._getTaskRouter().options.capabilities;
  }

  getToolLearningStats () {
    return this.toolLearning.getLearningStats();
  }

  getToolLearningProfiles () {
    return this.toolLearning.getAllToolProfiles();
  }

  getToolRecommendation (taskInfo, availableTools) {
    return this.toolLearning.recommendBestTool(taskInfo, availableTools);
  }

  resetToolLearning () {
    return this.toolLearning.reset();
  }

  getModeManager () {
    return this.modeManager;
  }

  getExecutionMode () {
    return this.modeManager.getCurrentMode();
  }

  setExecutionMode (modeName) {
    const modeConfig = this.modeManager.setMode(modeName);
    this.privacyMode = modeConfig.privacy.enabled;
    this.routingStrategy = modeConfig.routing.defaultStrategy;
    this.enableContractAssembly = modeConfig.merging.strategy === 'contract';
    this.multiProviderMode = modeConfig.codeGeneration?.multiProviderMode || false;
    this.toolRouter = null;

    if (this.executor) {
      this.executor.privacyMode = this.privacyMode;
      this.executor.routingStrategy = this.routingStrategy;
      this.executor.multiProviderMode = this.multiProviderMode;
    }

    return modeConfig;
  }

  getExecutionModes () {
    return this.modeManager.getAllModes();
  }

  setToolCapabilities (capabilities) {
    this._getTaskRouter().setCapabilities(capabilities);
  }

  setManualRouting (routingTable) {
    this.manualRouting = routingTable;
    this._getTaskRouter().setManualRouting(routingTable);
  }

  // ═══════════════════════════════════════════
  // 自适应智能编排 API
  // ═══════════════════════════════════════════

  /**
   * 获取自适应编排推荐（不修改状态）
   * @param {string} taskDescription - 任务描述
   * @returns {Object} 推荐结果
   */
  getAdaptiveRecommendation (taskDescription) {
    return this.adaptiveOrchestrator.recommend(
      taskDescription,
      this.toolAdapters.map(a => ({ name: a.name, displayName: a.displayName, status: a.status }))
    );
  }

  /**
   * 应用自适应推荐（手动确认后执行）
   * @param {Object} recommendation - 推荐结果
   */
  applyAdaptiveRecommendation (recommendation) {
    if (recommendation.mode && recommendation.mode !== this.modeManager.getCurrentMode()) {
      this.setExecutionMode(recommendation.mode);
    }
    if (recommendation.strategy && recommendation.strategy !== this.routingStrategy) {
      this.routingStrategy = recommendation.strategy;
      this.toolRouter = null;
      if (this.executor) {
        this.executor.routingStrategy = this.routingStrategy;
      }
    }
    if (recommendation.tools && recommendation.tools.length > 0) {
      const recommendedNames = recommendation.tools.map(t => t.name);
      this.toolAdapters = this.toolAdapters.filter(a => recommendedNames.includes(a.name));
      this.toolRouter = null;
    }
    return { success: true, applied: recommendation };
  }

  /**
   * 设置编排模式
   * @param {string} mode - auto（自适应）/ manual（手动）/ hybrid（混合）
   */
  setOrchestrationMode (mode) {
    return this.adaptiveOrchestrator.setOrchestrationMode(mode);
  }

  /**
   * 获取当前编排模式
   */
  getOrchestrationMode () {
    return this.adaptiveOrchestrator.orchestrationMode;
  }

  /**
   * 更新用户偏好（隐私敏感度、质量优先级等）
   */
  updateAdaptivePreferences (preferences) {
    return this.adaptiveOrchestrator.updatePreferences(preferences);
  }

  /**
   * 获取自适应编排状态
   */
  getAdaptiveStatus () {
    return this.adaptiveOrchestrator.getStatus();
  }

  // ── 生命周期 ──

  async initialize () {
    this.emit('init', { provider: this.provider.name });
    this.tokenCounter.reset();
    this.modelRouter.reset();

    if (this.toolAdapters && this.toolAdapters.length > 0) {
      await this._connectTools();
    }

    return true;
  }

  async _connectTools () {
    const ToolScanner = require('./ToolScanner');
    const scanner = new ToolScanner({
      silentScan: true,
      autoConfirm: true
    });
    scanner.registerAdapters(this.toolAdapters);
    const scanResult = await scanner.scan();

    for (const tool of scanResult.enabled) {
      try {
        await scanner.connect(tool.name);
      } catch (e) {
        console.log(`连接工具 ${tool.name} 失败: ${e.message}`);
      }
    }

    this.connectedTools = scanResult.enabled || [];
    console.log(`\n📡 已连接工具: ${this.connectedTools.length} 个`);
    if (this.connectedTools.length > 0) {
      console.log(`   工具列表: ${this.connectedTools.map(t => t.name).join(', ')}`);
    }
  }

  async runTask (taskDescription, context = {}) {
    if (this.isRunning) {
      throw new Error('已有任务正在运行');
    }

    this.isRunning = true;
    this.tasks = [];
    this.results = {};
    this.memory.clear();

    this._resetRejectionCounter();

    // 生成运行 ID（用于 checkpoint）
    this._currentRunId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    try {
      this.emit('taskStart', { task: taskDescription });

      // ═══ G1: 任务执行前 — Git 分支创建 ═══
      if (this.gitIntegration && this.gitIntegration.isEnabled()) {
        const runId = this._currentRunId;
        this.gitIntegration.createTaskBranch(runId);
        this.emit('git:branchCreated', { branch: `${this.gitIntegration.branchPrefix}${runId}` });
      }

      // ═══ G1: 任务执行前 — 预算检查 ═══
      if (this.budgetManager) {
        if (!this.budgetManager.canProceed(10000)) {
          throw new Error('Token 预算已耗尽，无法执行任务');
        }
        if (this.budgetManager.shouldDegrade(10000)) {
          this.emit('budget:degrade', { remaining: this.budgetManager.getRemaining() });
        }
      }

      // ═══ G1: 任务执行前 — 审批 ═══
      if (this.approvalWorkflow) {
        const approval = await this.approvalWorkflow.requestApproval('pre_execute', {
          task: taskDescription
        });
        if (!approval.approved) {
          throw new Error(`任务执行被拒绝: ${approval.comment || '无理由'}`);
        }
      }

      // ═══ G1: 流式输出开始 ═══
      if (this.streamManager) {
        this.streamManager.start();
        this.streamManager.status('splitting', { task: taskDescription });
      }

      // ═══ 自适应智能编排：auto/hybrid 模式自动推荐配置 ═══
      const orchestrationMode = this.adaptiveOrchestrator.orchestrationMode;
      let adaptiveRecommendation = null;
      if (orchestrationMode !== 'manual' && this.toolAdapters.length > 0) {
        adaptiveRecommendation = this.adaptiveOrchestrator.recommend(
          taskDescription,
          this.toolAdapters.map(a => ({ name: a.name, displayName: a.displayName, status: a.status }))
        );

        this.emit('adaptiveRecommendation', adaptiveRecommendation);

        // auto 模式：自动应用推荐
        if (orchestrationMode === 'auto') {
          // 应用推荐的模式
          if (adaptiveRecommendation.mode && adaptiveRecommendation.mode !== this.modeManager.getCurrentMode()) {
            this.setExecutionMode(adaptiveRecommendation.mode);
          }
          // 应用推荐的策略
          if (adaptiveRecommendation.strategy && adaptiveRecommendation.strategy !== this.routingStrategy) {
            this.routingStrategy = adaptiveRecommendation.strategy;
            this.toolRouter = null; // 强制重建路由器
            if (this.executor) {
              this.executor.routingStrategy = this.routingStrategy;
            }
          }
          // 应用推荐的工具组合（覆盖 toolAdapters）
          if (adaptiveRecommendation.tools.length > 0) {
            const recommendedNames = adaptiveRecommendation.tools.map(t => t.name);
            this.toolAdapters = this.toolAdapters.filter(a => recommendedNames.includes(a.name));
            this.toolRouter = null; // 强制重建路由器
          }
          this.emit('adaptiveApplied', {
            mode: adaptiveRecommendation.mode,
            strategy: adaptiveRecommendation.strategy,
            tools: adaptiveRecommendation.tools.map(t => t.name),
            confidence: adaptiveRecommendation.confidence
          });
        }
        // hybrid 模式：仅推荐不强制，由用户在 WebUI/CLI 决定是否接受
        // manual 模式：完全跳过推荐，使用用户已选工具
      }

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
        overview: splitResult.taskOverview,
        tasks: this.tasks,
        plan: splitResult.overallPlan,
        constraints: splitResult.constraints || {},
        coverageCheck: splitResult.coverageCheck || {},
        dependencyGraph: splitResult.dependencyGraph || {}
      });

      // 2. 执行（委托给 Scheduler + Executor）
      await this.scheduler.executeLoop(
        this.tasks,
        async (task, ctx) => {
          if (this.rejectionCounter.requiresHumanApproval) {
            throw new Error(`需要人工审批：连续失败 ${this.rejectionCounter.consecutiveFailures} 次，请先调用 confirmHumanApproval() 确认`);
          }

          const result = await this.executor.executeSingleTask(task, {
            ...ctx,
            orchestrator: this,
            saveToMemory: (t, r) => this.executor._saveToMemory(t, r),
            completedCountIncrement: () => {}
          });

          this._updateRejectionCounter(task, result);
          return result;
        },
        {
          constraints: this.memory.getAllGlobals(),
          previousTasks: this.tasks.filter(t => t.status === 'completed')
        },
        this._currentRunId
      );

      // 3. 最终审查与合并
      const finalResult = await this._finalReview(taskDescription, splitResult);

      // ═══ G1: 任务完成后 — Git 提交 ═══
      if (this.gitIntegration && this.gitIntegration.isEnabled() && finalResult.successRate >= 60) {
        const commitHash = this.gitIntegration.commitChanges(this._currentRunId,
          `Qidi Agent: 任务完成 (成功率 ${finalResult.successRate}%)`);
        if (commitHash) {
          this.emit('git:committed', { hash: commitHash });
        }
      }

      // ═══ G1: 任务完成后 — 语义记忆存储 ═══
      if (this.vectorMemory && finalResult.successRate >= 60) {
        try {
          const qualityScores = finalResult.tasks
            .filter(t => t.qualityScore !== null)
            .map(t => t.qualityScore);
          const avgQuality = qualityScores.length > 0
            ? Math.round(qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length)
            : 0;
          await this.vectorMemory.store(taskDescription, {
            taskTitle: taskDescription.substring(0, 200),
            language: finalResult.constraints?.language || 'unknown',
            qualityScore: avgQuality,
            successRate: finalResult.successRate,
            runId: this._currentRunId,
            taskType: 'completed'
          });
        } catch (_) {}
      }

      // ═══ G1: 任务完成后 — 预算记录 ═══
      if (this.budgetManager) {
        const tokenStats = this.tokenCounter.getStats();
        this.budgetManager.record('orchestrator', 'TaskOrchestrator',
          this.provider?.model || 'unknown',
          tokenStats.totalInputTokens || 0,
          tokenStats.totalOutputTokens || 0);
      }

      // ═══ P4: 自适应学习闭环 — 任务完成后回写结果 ═══
      if (this.adaptiveOrchestrator && adaptiveRecommendation) {
        try {
          const adaptiveQualityScores = (finalResult.tasks || [])
            .filter(t => t.qualityScore !== null && t.qualityScore !== undefined)
            .map(t => t.qualityScore);
          const adaptiveAvgQuality = adaptiveQualityScores.length > 0
            ? Math.round(adaptiveQualityScores.reduce((a, b) => a + b, 0) / adaptiveQualityScores.length)
            : 0;
          this.adaptiveOrchestrator.recordOutcome(
            adaptiveRecommendation.timestamp,
            finalResult.successRate >= 0.6,
            adaptiveAvgQuality,
            {
              taskType: adaptiveRecommendation.features?.taskType || 'unknown',
              language: adaptiveRecommendation.features?.language || 'unknown',
              duration: finalResult.duration || 0,
              successRate: finalResult.successRate
            }
          );
          this.emit('adaptive:learning', { timestamp: adaptiveRecommendation.timestamp, successRate: finalResult.successRate });
        } catch (e) {
          logger.warn('[Adaptive] 学习闭环失败: ' + e.message);
        }
      }

      // ═══ G1: 流式输出完成 ═══
      if (this.streamManager) {
        this.streamManager.done({ successRate: finalResult.successRate });
      }

      this.emit('taskComplete', {
        success: true,
        result: finalResult,
        tasks: this.tasks,
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

      // ═══ G1: 失败时 — Git 回滚 ═══
      if (this.gitIntegration && this.gitIntegration.isEnabled()) {
        this.gitIntegration.rollback();
        this.emit('git:rolledBack', { reason: error.message });
      }

      // ═══ G1: 流式输出错误 ═══
      if (this.streamManager) {
        this.streamManager.error(error);
      }

      this.isRunning = false;
      throw error;
    }
  }

  async _splitTask (taskDescription, context) {
    this.emit('splitting', { task: taskDescription });
    const result = await this.agents.splitter.splitTask(taskDescription, context);
    return result;
  }

  // ── 最终审查 ──

  async _finalReview (originalTask, splitResult) {
    const completedTasks = this.tasks.filter(t => t.status === 'completed');
    const failedTasks = this.tasks.filter(t => t.status === 'failed');
    const needsRevisionTasks = this.tasks.filter(t => t.status === 'needs_revision');

    for (const task of this.tasks) {
      const toolName = task.result?.toolName;
      if (toolName) {
        const taskInfo = {
          type: task.type || task.role || 'general',
          language: task.language || splitResult.constraints?.language || 'unknown',
          complexity: task.complexity || 'medium',
          frameworks: task.frameworks || [],
          role: task.role || 'code_writer'
        };
        const result = {
          success: task.status === 'completed',
          qualityScore: task.result?.quality?.qualityScore || (task.status === 'completed' ? 60 : 0),
          duration: task.result?.duration || 0,
          error: task.status === 'failed' ? (task.result?.error || '任务失败') : null
        };
        this.toolLearning.recordExecution(toolName, taskInfo, result);
      }
    }

    const summary = {
      originalTask,
      totalTasks: this.tasks.length,
      completedTasks: completedTasks.length,
      failedTasks: failedTasks.length,
      needsRevisionTasks: needsRevisionTasks.length,
      successRate: this.tasks.length > 0
        ? Math.round((completedTasks.length / this.tasks.length) * 100)
        : 0,
      constraints: this.memory.getAllGlobals(),
      tasks: this.tasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        result: t.result,
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

    const qualityScores = summary.tasks
      .filter(t => t.qualityScore !== null)
      .map(t => t.qualityScore);
    const avgQuality = qualityScores.length > 0
      ? Math.round(qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length)
      : 0;

    this.modeManager.recordTaskResult(
      this.modeManager.getCurrentMode(),
      summary.successRate >= 60,
      avgQuality
    );

    return summary;
  }

  async _assembleContracts (completedTasks, splitResult) {
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
      success: assemblyResult.success,
      contracts: assemblyResult.contracts,
      conflicts: assemblyResult.conflicts,
      issues: validation.issues,
      warnings: validation.warnings,
      code: assemblyResult.code,
      language: targetLanguage,
      privacyProtected: true
    };
  }

  async _finalQualityGate (originalTask, summary) {
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

  getFullReport () {
    return this.tokenCounter.getReport() + this.cacheStore.getReport() + this.modelRouter.getReport();
  }

  getStatus () {
    return {
      isRunning: this.isRunning,
      currentTask: this.currentTaskIndex >= 0 ? this.tasks[this.currentTaskIndex] : null,
      tasks: this.tasks,
      completedCount: this.tasks.filter(t => t.status === 'completed').length,
      totalCount: this.tasks.length,
      constraints: this.memory.getAllGlobals(),
      tokenStats: this.tokenCounter.getStats(),
      cacheStats: this.cacheStore.getStats(),
      // G1: 增强模块状态
      budget: this.budgetManager ? this.budgetManager.generateReport() : null,
      git: this.gitIntegration
        ? {
          enabled: this.gitIntegration.isEnabled(),
          branch: this.gitIntegration.getCurrentBranch()
        }
        : null,
      approvals: this.approvalWorkflow ? this.approvalWorkflow.getStats() : null,
      vectorMemory: this.vectorMemory ? this.vectorMemory.getStats() : null,
      mcpServers: this.mcpClient ? this.mcpClient.getStatus() : []
    };
  }

  getRecentReports (count = 5) {
    return this.reportGenerator.getRecentReports(count);
  }

  listReports () {
    return this.reportGenerator.listReports();
  }

  searchReports (query) {
    return this.reportGenerator.searchReports(query);
  }

  loadReport (reportId) {
    return this.reportGenerator.loadReport(reportId);
  }

  // ═══════════════════════════════════════════
  // 暂停/恢复 API
  // ═══════════════════════════════════════════

  /**
   * 暂停当前运行的任务
   */
  async pause () {
    if (!this.isRunning) {
      throw new Error('当前没有正在运行的任务');
    }
    await this.scheduler.pause();
    this.emit('taskPaused', { runId: this._currentRunId });
  }

  /**
   * 恢复暂停的任务
   */
  resume () {
    if (!this.isRunning) {
      throw new Error('当前没有正在运行的任务');
    }
    this.scheduler.resume();
    this.emit('taskResumed', { runId: this._currentRunId });
  }

  /**
   * 检查任务是否已暂停
   */
  isPaused () {
    return this.scheduler.isPaused();
  }

  // ═══════════════════════════════════════════
  // Checkpoint API
  // ═══════════════════════════════════════════

  /**
   * 手动保存 checkpoint
   */
  saveCheckpoint () {
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
  listCheckpoints () {
    return this.scheduler.listCheckpoints();
  }

  /**
   * 从 checkpoint 恢复（用于断点续传）
   * @param {string} runId - 要恢复的 checkpoint runId
   * @returns {Object} 恢复的任务状态
   */
  restoreCheckpoint (runId) {
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
  deleteCheckpoint (runId) {
    return this.scheduler.deleteCheckpoint(runId);
  }

  /**
   * 清理过期 checkpoint
   */
  cleanOldCheckpoints (maxDays = 7) {
    return this.scheduler.cleanOldCheckpoints(maxDays);
  }

  getHistoricalContext (count = 3) {
    const recentReports = this.reportGenerator.getRecentReports(count);
    return this.reportGenerator.getContextSummary(recentReports.map(r => r.id));
  }

  getReportGenerator () {
    return this.reportGenerator;
  }

  // ═══════════════════════════════════════════
  // 被拒计数器与人工审批 API
  // ═══════════════════════════════════════════

  _resetRejectionCounter () {
    this.rejectionCounter.consecutiveFailures = 0;
    this.rejectionCounter.requiresHumanApproval = false;
  }

  _updateRejectionCounter (task, result) {
    if (!this.rejectionCounter.enabled) return;

    const isFailed = result?.success === false ||
                     result?.quality?.qualityScore < this.modeManager.getModeConfig().qualityCheck.minQualityScore ||
                     task?.status === 'failed';

    if (isFailed) {
      this.rejectionCounter.consecutiveFailures++;

      if (this.rejectionCounter.consecutiveFailures >= this.rejectionCounter.maxConsecutiveFailures) {
        this.rejectionCounter.requiresHumanApproval = true;
        this.emit('humanApprovalRequired', {
          runId: this._currentRunId,
          consecutiveFailures: this.rejectionCounter.consecutiveFailures,
          maxAllowed: this.rejectionCounter.maxConsecutiveFailures,
          taskId: task?.id,
          taskTitle: task?.title,
          qualityScore: result?.quality?.qualityScore
        });
      }
    } else {
      this.rejectionCounter.consecutiveFailures = 0;
    }
  }

  confirmHumanApproval (reason = '') {
    if (!this.rejectionCounter.requiresHumanApproval) {
      throw new Error('当前不需要人工审批');
    }

    this.rejectionCounter.requiresHumanApproval = false;
    this.rejectionCounter.consecutiveFailures = 0;
    this.rejectionCounter.lastApprovalTime = Date.now();
    this.rejectionCounter.approvalHistory.push({
      timestamp: Date.now(),
      reason,
      runId: this._currentRunId
    });

    this.emit('humanApprovalConfirmed', {
      runId: this._currentRunId,
      reason,
      approvalHistory: this.rejectionCounter.approvalHistory.length
    });

    return {
      success: true,
      message: '人工审批已确认，任务将继续执行',
      approvalHistory: this.rejectionCounter.approvalHistory.slice(-5)
    };
  }

  skipHumanApproval () {
    if (!this.rejectionCounter.requiresHumanApproval) {
      throw new Error('当前不需要人工审批');
    }

    this.rejectionCounter.requiresHumanApproval = false;
    this.rejectionCounter.consecutiveFailures = 0;

    this.emit('humanApprovalSkipped', {
      runId: this._currentRunId
    });

    return {
      success: true,
      message: '已跳过人工审批，任务将继续执行'
    };
  }

  getRejectionCounterStatus () {
    return {
      enabled: this.rejectionCounter.enabled,
      consecutiveFailures: this.rejectionCounter.consecutiveFailures,
      maxConsecutiveFailures: this.rejectionCounter.maxConsecutiveFailures,
      requiresHumanApproval: this.rejectionCounter.requiresHumanApproval,
      lastApprovalTime: this.rejectionCounter.lastApprovalTime,
      approvalCount: this.rejectionCounter.approvalHistory.length
    };
  }

  setRejectionThreshold (threshold) {
    if (threshold < 1 || threshold > 10) {
      throw new Error('阈值必须在 1-10 之间');
    }
    this.rejectionCounter.maxConsecutiveFailures = threshold;
    return { success: true, threshold };
  }

  disableRejectionCounter () {
    this.rejectionCounter.enabled = false;
    return { success: true, message: '被拒计数器已禁用' };
  }

  enableRejectionCounter () {
    this.rejectionCounter.enabled = true;
    return { success: true, message: '被拒计数器已启用' };
  }
}

module.exports = TaskOrchestrator;
