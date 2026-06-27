const EventEmitter = require('events');
const AgentFactory = require('../agents');
const FileManager = require('../utils/FileManager');
const MemoryStore = require('./MemoryStore');
const TokenCounter = require('../utils/TokenCounter');
const ContextCompressor = require('../utils/ContextCompressor');
const CacheStore = require('../utils/CacheStore');
const ModelRouter = require('../utils/ModelRouter');
const ExperimentReportGenerator = require('../utils/ExperimentReportGenerator');
const MergeEngine = require('../agents/MergeEngine');
const TaskRouter = require('./TaskRouter');
const ContractAssembler = require('./ContractAssembler');
const ExecutionModeManager = require('./ExecutionModeManager');

/**
 * 任务编排器：负责完整的任务生命周期管理。
 * 包括：分解 → 执行（含缓存/压缩/路由/质检）→ 合并 → 报告。
 */
class TaskOrchestrator extends EventEmitter {
  constructor(provider, options = {}) {
    super();
    this.provider = provider;
    this.options = options;
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
    // 新增配置选项
    this.enableFinalQualityGate = options.enableFinalQualityGate !== false;
    this.strictMode = options.strictMode !== false; // 严格模式：核心任务失败阻断
    this.maxResplits = options.maxResplits || 2; // 最大重拆次数

    // ═══════════════ 执行模式管理器 ═══════════════
    this.modeManager = new ExecutionModeManager();
    // 可以通过 options.executionMode 覆盖默认模式
    if (options.executionMode) {
      this.modeManager.setMode(options.executionMode);
    }

    // ═══════════════ 从模式配置派生 ═══════════════
    const modeConfig = this.modeManager.getModeConfig();
    this.privacyMode = modeConfig.privacy.enabled;
    this.routingStrategy = options.routingStrategy || modeConfig.routing.defaultStrategy;
    this.manualRouting = options.manualRouting || {};
    this.toolRouter = null;

    // ═══════════════ 根据模式创建 Agents ═══════════════
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

    // ═══════════════ 契约拼装配置 ═══════════════
    // 初始化契约拼装引擎（隐私模式下使用本地模型辅助）
    const mergingConfig = modeConfig.merging;
    this.contractAssembler = new ContractAssembler({
      strictMode: options.contractStrictMode ?? mergingConfig.contractStrict,
      autoAdapt: options.contractAutoAdapt ?? mergingConfig.autoAdapt,
      supportedLanguages: options.contractLanguages || ['c', 'python', 'javascript', 'typescript', 'java', 'go', 'rust'],
      // 隐私模式下启用本地模型辅助契约提取
      enableAIAssist: mergingConfig.localModelAssist ?? true,
      localModel: mergingConfig.localModelAssist ? this.provider : null
    });
    this.enableContractAssembly = options.enableContractAssembly ?? mergingConfig.strategy === 'contract';

    // 任务状态
    this.tasks = [];
    this.results = {};
    this.currentTaskIndex = -1;
    this.isRunning = false;
    this.maxRetries = options.maxRetries || 2;
    this.enableCache = options.enableCache !== false;
    this.enableCompression = options.enableCompression !== false;
    this.enableModelRouting = options.enableModelRouting !== false;
  }

  /**
   * 获取任务路由器实例
   */
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

  /**
   * 获取可用的路由策略列表
   */
  getRoutingStrategies() {
    return this._getTaskRouter().getStrategies();
  }

  /**
   * 获取工具能力表
   */
  getToolCapabilities() {
    return this._getTaskRouter().options.capabilities;
  }

  /**
   * 获取执行模式管理器
   */
  getModeManager() {
    return this.modeManager;
  }

  /**
   * 获取当前执行模式
   */
  getExecutionMode() {
    return this.modeManager.getCurrentMode();
  }

  /**
   * 设置执行模式
   */
  setExecutionMode(modeName) {
    const modeConfig = this.modeManager.setMode(modeName);

    // 同步更新派生配置
    this.privacyMode = modeConfig.privacy.enabled;
    this.routingStrategy = modeConfig.routing.defaultStrategy;
    this.enableContractAssembly = modeConfig.merging.strategy === 'contract';

    // 重置工具路由器
    this.toolRouter = null;

    return modeConfig;
  }

  /**
   * 获取所有可用模式
   */
  getExecutionModes() {
    return this.modeManager.getAllModes();
  }

  /**
   * 设置工具能力表
   */
  setToolCapabilities(capabilities) {
    this._getTaskRouter().setCapabilities(capabilities);
  }

  /**
   * 设置手动路由表
   */
  setManualRouting(routingTable) {
    this.manualRouting = routingTable;
    this._getTaskRouter().setManualRouting(routingTable);
  }

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
        ...t,
        status: 'pending',
        result: null,
        retries: 0,
        qualityChecks: []
      }));

      this.emit('taskSplit', {
        overview: splitResult.taskOverview,
        tasks: this.tasks,
        plan: splitResult.overallPlan,
        constraints: splitResult.constraints || {},
        coverageCheck: splitResult.coverageCheck || {},
        dependencyGraph: splitResult.dependencyGraph || {}
      });

      // 2. 执行
      await this._executeTasks(projectContext);

      // 3. 最终审查与合并
      const finalResult = await this._finalReview(taskDescription, splitResult);

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
        reportId: reportResult.report.id,
        filePath: reportResult.filePath
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

  async _executeTasks(context) {
    let completedCount = 0;
    const totalCount = this.tasks.length;

    while (completedCount < totalCount) {
      const readyTasks = this._getReadyTasks();

      if (readyTasks.length === 0) {
        const stuckTasks = this.tasks.filter(t =>
          t.status === 'failed' || t.status === 'needs_revision'
        );
        if (stuckTasks.length > 0) {
          // 改动3：关键子任务失败阻断（区分角色）
          const criticalRoles = ['architect', 'code_writer'];
          const criticalFailed = stuckTasks.filter(t => criticalRoles.includes(t.role));
          if (criticalFailed.length > 0 && this.strictMode) {
            throw new Error(`核心任务执行失败: ${criticalFailed.map(t => t.title).join(', ')}`);
          }
          // 非关键任务失败不阻断，仅标记警告
          const nonCriticalFailed = stuckTasks.filter(t => !criticalRoles.includes(t.role));
          if (nonCriticalFailed.length > 0) {
            this.emit('nonCriticalFailed', {
              tasks: nonCriticalFailed,
              warning: '非核心任务失败，继续执行'
            });
          }
          if (criticalFailed.length > 0 && !this.strictMode) {
            // 非严格模式下，核心任务失败也继续，但标记警告
            this.emit('criticalFailedWarning', {
              tasks: criticalFailed,
              warning: '核心任务失败但非严格模式，继续执行（产出需人工审查）'
            });
          }
          // 如果所有任务都失败了才抛异常
          if (stuckTasks.length >= this.tasks.length) {
            throw new Error(`所有任务执行失败: ${stuckTasks.map(t => t.title).join(', ')}`);
          }
          break;
        }
        break;
      }

      for (const task of readyTasks) {
        this.currentTaskIndex = this.tasks.indexOf(task);
        task.status = 'in_progress';

        this.emit('taskStart_sub', {
          task, index: this.currentTaskIndex, total: totalCount,
          constraints: this.memory.getAllGlobals()
        });

        try {
          const result = await this._executeSingleTask(task, context);
          task.result = result;
          task.status = 'completed';
          completedCount++;
          this._saveToMemory(task, result);

          this.emit('taskComplete_sub', {
            task, result, index: this.currentTaskIndex, total: totalCount
          });

        } catch (error) {
          task.retries++;
          if (task.retries <= this.maxRetries) {
            task.status = 'pending';
            this.emit('taskRetry', {
              task, attempt: task.retries, error: error.message
            });
          } else {
            task.status = 'failed';
            task.error = error.message;
            completedCount++;
            this.emit('taskFailed', { task, error: error.message });
          }
        }
      }
    }
  }

  _saveToMemory(task, result) {
    this.memory.put(task.id, 'content', result.content || '');
    this.memory.put(task.id, 'codeBlocks', result.codeBlocks || []);
    this.memory.put(task.id, 'qualityScore', result.quality?.qualityScore || 0);
    this.memory.put(task.id, 'status', task.status);
    this.memory.put(task.id, 'title', task.title);
    this.memory.put(task.id, 'toolResults', result.quality?.toolResults || {});
    this.memory.addTag(task.id, task.role);
  }

  _getReadyTasks() {
    return this.tasks.filter(task => {
      if (task.status !== 'pending') return false;
      if (!task.dependsOn || task.dependsOn.length === 0) return true;
      return task.dependsOn.every(depId => {
        const depTask = this.tasks.find(t => t.id === depId);
        return depTask && depTask.status === 'completed';
      });
    });
  }

  async _executeSingleTask(task, context) {
    const agentName = this._getAgentName(task.role);

    // 1. 缓存检查
    if (this.enableCache) {
      const cached = this.cacheStore.getTaskResponse(task.id, agentName, task);
      if (cached) {
        this.emit('cacheHit', { task, agent: agentName });
        this.tokenCounter.recordCacheHit(agentName, task.id);
        return cached.response;
      }
      this.tokenCounter.recordCacheMiss(agentName, task.id);
    }

    // 2. 构建上下文
    const allPreviousResults = this.memory.getTaskHistory(
      Object.keys(this.memory.getAll())
    );
    let previousCode = this._buildPreviousCode(allPreviousResults);

    if (this.enableCompression && this.tokenCounter.shouldCompress(previousCode, 2000)) {
      const originalTokens = this.tokenCounter.estimateTokens(previousCode);
      previousCode = this.contextCompressor.compressCode(previousCode);
      const compressedTokens = this.tokenCounter.estimateTokens(previousCode);
      this.emit('contextCompressed', {
        task, originalTokens, compressedTokens,
        saved: originalTokens - compressedTokens
      });
    }

    const taskContext = {
      ...context,
      constraints: this.memory.getAllGlobals(),
      previousResults: allPreviousResults,
      previousCode
    };

    // 3. 模型路由
    let useSmallModel = false;
    if (this.enableModelRouting) {
      const modelSelection = this.modelRouter.selectModel(agentName, task, taskContext);
      useSmallModel = modelSelection.size === 'small';
      this.emit('modelSelected', {
        task, agent: agentName,
        model: modelSelection.model, size: modelSelection.size, reason: modelSelection.reason
      });
    }

    // 4. 执行
    let result;
    const startTime = Date.now();

    switch (task.role) {
      case 'code_writer':
      case 'architect':
        result = await this._executeCodeTask(task, taskContext, useSmallModel);
        break;
      case 'code_reviewer':
        result = await this._executeReviewTask(task, taskContext, useSmallModel);
        break;
      case 'tester':
        result = await this._executeTestTask(task, taskContext, useSmallModel);
        break;
      case 'quality_checker':
        result = await this._executeQualityTask(task, taskContext, useSmallModel);
        break;
      default:
        result = await this._executeCodeTask(task, taskContext, useSmallModel);
    }

    // 5. Token 记录
    const promptForLogging = this._buildPromptForLogging(task, taskContext);
    this.tokenCounter.record(
      agentName, task.id, promptForLogging,
      result.content || JSON.stringify(result),
      { model: useSmallModel ? 'small' : 'large' }
    );

    // 6. 质量检查（含工具链验证）
    const qualityResult = await this._checkQuality(task, result, taskContext);

    if (qualityResult.status === 'needs_revision' && task.retries < this.maxRetries) {
      // 改动1：把质检建议注入到重试上下文中，不抛异常
      task.lastQualityFeedback = qualityResult.revisionSuggestions || qualityResult.weaknesses?.join('; ') || '';
      task.lastQualityScore = qualityResult.qualityScore || 0;
      task.lastQualityIssues = qualityResult.constraintViolations || [];
      task.retries++;
      task.status = 'pending'; // 不抛异常，让loop重新调度
      
      this.emit('qualityReview', {
        task, quality: qualityResult, needsRevision: true, feedbackInjected: task.lastQualityFeedback
      });
      
      // 返回当前结果，但标记需要修订
      return { ...result, quality: qualityResult, needsRevision: true };
    }

    // 7. 缓存
    if (this.enableCache && qualityResult.status === 'completed') {
      this.cacheStore.setTaskResponse(task.id, agentName, task, result, {
        tokens: this.tokenCounter.estimateTokens(result.content || ''),
        qualityScore: qualityResult.qualityScore
      });
    }

    return { ...result, quality: qualityResult };
  }

  _getAgentName(role) {
    const roleMap = {
      'code_writer': 'codeWriter', 'architect': 'codeWriter',
      'code_reviewer': 'codeReviewer', 'tester': 'tester',
      'quality_checker': 'qualityChecker'
    };
    return roleMap[role] || 'codeWriter';
  }

  _buildPromptForLogging(task, context) {
    return `${task.title}\n${task.description}\n${context.previousCode?.substring(0, 500) || ''}`;
  }

  _buildPreviousCode(previousResults) {
    let code = '';
    for (const res of previousResults) {
      if (res.codeBlocks && res.codeBlocks.length > 0) {
        code += `\n// === ${res.taskId}: ${res.title} ===\n`;
        for (const block of res.codeBlocks) {
          code += `\`\`\`${block.language}\n${block.code}\n\`\`\`\n`;
        }
      } else if (res.content) {
        code += `\n// === ${res.taskId}: ${res.title} ===\n${res.content}\n`;
      }
    }
    return code;
  }

  async _executeCodeTask(task, context, useSmallModel = false) {
    this.emit('agentWorking', { agent: 'codeWriter', task, modelSize: useSmallModel ? 'small' : 'large' });

    // 将质检反馈注入到上下文
    const enhancedContext = { ...context };
    if (task.lastQualityFeedback) {
      enhancedContext.qualityFeedback = {
        suggestions: task.lastQualityFeedback,
        score: task.lastQualityScore,
        issues: task.lastQualityIssues
      };
    }

    // ═══════════════ 隐私模式分支 ═══════════════
    if (this.privacyMode) {
      return await this._executePrivacyMode(task, enhancedContext, useSmallModel);
    }

    // ═══════════════ 传统模式（Provider + 工具广播）═══════════════
    // 1. Provider 执行
    const providerResult = await this.agents.codeWriter.writeCode(task, enhancedContext, { useSmallModel });

    // 2. 多工具并行派发（广播给所有工具）
    const adapterResults = await this._dispatchToAdapters(task, enhancedContext);

    // 3. 合并所有产出
    const finalResult = await this._mergeToolOutputs(task, providerResult, adapterResults, enhancedContext);

    if (finalResult.codeBlocks && finalResult.codeBlocks.length > 0) {
      this._saveCodeBlocks(task, finalResult.codeBlocks);
    }

    return finalResult;
  }

  /**
   * 隐私隔离执行模式
   * 
   * 核心原理：
   * 1. Provider 只负责拆分任务，不参与代码生成
   * 2. 每个子任务只发给一个工具（根据路由策略）
   * 3. 工具之间互不知道其他工具的产出
   * 4. 最终合并时，MergeEngine 负责整合各工具产出
   */
  async _executePrivacyMode(task, context, useSmallModel = false) {
    this.emit('privacyModeStart', { task, strategy: this.routingStrategy });

    const router = this._getTaskRouter();

    // 1. 根据路由策略选择工具
    const routingResult = router.routeTask(task);
    const selectedAdapter = routingResult.adapter;
    const routingReason = routingResult.reason;

    if (!selectedAdapter) {
      // 没有可用工具，降级到 Provider 执行
      this.emit('privacyModeFallback', { task, reason: '无可用工具，降级到 Provider' });
      return await this.agents.codeWriter.writeCode(task, context, { useSmallModel });
    }

    this.emit('toolSelected', {
      task,
      tool: selectedAdapter.name,
      displayName: selectedAdapter.displayName,
      strategy: this.routingStrategy,
      reason: routingReason
    });

    // 2. 构建发给工具的任务描述（不包含其他任务的上下文）
    const toolTaskDesc = this._buildPrivacyTaskDescription(task, context);

    // 3. 执行单个工具（不再广播给所有工具）
    const startTime = Date.now();
    let toolResult;

    try {
      toolResult = await selectedAdapter.execute(toolTaskDesc, {
        taskId: `${selectedAdapter.name}_${task.id}`,
        timeout: 120000
      });
    } catch (error) {
      this.emit('toolExecutionError', { task, tool: selectedAdapter.name, error: error.message });
      // 工具执行失败，降级到 Provider
      return await this.agents.codeWriter.writeCode(task, context, { useSmallModel });
    }

    const duration = Date.now() - startTime;

    if (!toolResult.success) {
      this.emit('toolFailed', {
        task,
        tool: selectedAdapter.name,
        error: toolResult.error || toolResult.stderr || '工具执行失败'
      });
      // 工具失败，降级到 Provider
      return await this.agents.codeWriter.writeCode(task, context, { useSmallModel });
    }

    // 4. 整理工具产出
    const adapterOutput = {
      [selectedAdapter.name]: {
        success: true,
        result: { codeBlocks: toolResult.codeBlocks || [] },
        content: toolResult.content || '',
        displayName: selectedAdapter.displayName,
        duration
      }
    };

    // 5. 由于是隐私模式，不再有 Provider 产出，直接使用工具产出
    const finalResult = {
      content: toolResult.content || '',
      codeBlocks: toolResult.codeBlocks || [],
      source: 'tool',
      toolName: selectedAdapter.name,
      toolDisplayName: selectedAdapter.displayName,
      routingStrategy: this.routingStrategy,
      routingReason,
      duration,
      privacyMode: true
    };

    // 如果有合并报告，添加合并信息
    if (toolResult.metadata) {
      finalResult.metadata = toolResult.metadata;
    }

    this.emit('privacyModeComplete', {
      task,
      tool: selectedAdapter.name,
      result: finalResult
    });

    if (finalResult.codeBlocks && finalResult.codeBlocks.length > 0) {
      this._saveCodeBlocks(task, finalResult.codeBlocks);
    }

    return finalResult;
  }

  /**
   * 构建隐私模式下的任务描述
   * 只包含当前任务的信息，不泄露其他任务的上下文
   */
  _buildPrivacyTaskDescription(task, context) {
    const criteria = task.acceptanceCriteria;
    const criteriaStr = Array.isArray(criteria) ? criteria.join('\n') : (typeof criteria === 'string' ? criteria : '无');

    // 隐私模式：只传递必要的任务信息，不传递其他任务的详情
    let desc = `## 任务：${task.title}

${task.description || ''}

### 任务类型
${task.role || 'code_writer'}

### 语言要求
${task.language || '未指定'}

### 框架要求
${task.frameworks ? task.frameworks.join(', ') : '无'}

### 验收标准
${criteriaStr}`;

    // 只传递必要的约束，不传递完整上下文
    if (context.constraints) {
      const essentialConstraints = {};
      if (context.constraints.language) essentialConstraints.language = context.constraints.language;
      if (context.constraints.encoding) essentialConstraints.encoding = context.constraints.encoding;
      if (context.constraints.platform) essentialConstraints.platform = context.constraints.platform;
      if (Object.keys(essentialConstraints).length > 0) {
        desc += `\n\n### 必要约束
${JSON.stringify(essentialConstraints, null, 2)}`;
      }
    }

    // 不传递 previousCode（隐私保护）
    // 如果需要依赖，可以只传递接口定义而非完整代码

    if (task.lastQualityFeedback) {
      desc += `\n\n### ⚠️ 上次质检反馈（请针对以下问题改进）
${task.lastQualityFeedback}
上次评分: ${task.lastQualityScore || '?'}分`;
    }

    return desc;
  }

  /**
   * 向所有已连接的 AI 编程工具并行派发子任务。
   */
  async _dispatchToAdapters(task, context) {
    const results = {};
    const onlineAdapters = this.toolAdapters.filter(a => a.isAvailable && a.isAvailable());

    if (onlineAdapters.length === 0) return results;

    this.emit('multiToolDispatch', {
      task,
      tools: onlineAdapters.map(a => ({ name: a.name, displayName: a.displayName }))
    });

    const taskDesc = this._buildToolTaskDescription(task, context);
    const promises = onlineAdapters.map(async (adapter) => {
      const startTime = Date.now();
      try {
        const r = await adapter.execute(taskDesc, {
          taskId: `${adapter.name}_${task.id}`,
          timeout: 120000
        });
        const errMsg = !r.success
          ? (r.stderr || r.error || r.rawOutput?.substring(0, 300) || '工具执行失败')
          : null;
        return {
          name: adapter.name,
          displayName: adapter.displayName,
          result: r,
          error: errMsg,
          duration: Date.now() - startTime
        };
      } catch (e) {
        return {
          name: adapter.name,
          displayName: adapter.displayName,
          result: { success: false, content: '', codeBlocks: [] },
          error: e.message,
          duration: Date.now() - startTime
        };
      }
    });

    const settled = await Promise.allSettled(promises);

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        const { name, displayName, result, error, duration } = s.value;
        if (result && result.success && !error) {
          results[name] = { ...result, displayName, duration };
        } else {
          results[name] = { success: false, error: error || '任务失败', displayName, duration };
          this.emit('toolFailed', { tool: displayName, task, error: error || '任务失败' });
        }
      }
    }

    return results;
  }

  /**
   * 构建发给外部工具的 prompt（包含质检反馈）。
   */
  _buildToolTaskDescription(task, context) {
    const criteria = task.acceptanceCriteria;
    const criteriaStr = Array.isArray(criteria) ? criteria.join('\n') : (typeof criteria === 'string' ? criteria : '无');
    
    let desc = `## 任务：${task.title}

${task.description || ''}

### 验收标准
${criteriaStr}

### 约束
${JSON.stringify(context.constraints || {}, null, 2) || '无'}

### 已有代码
${context.previousCode || '无'}`;
    
    // 改动：注入上次质检反馈
    if (task.lastQualityFeedback) {
      desc += `\n\n### ⚠️ 上次质检反馈（请针对以下问题改进）
${task.lastQualityFeedback}

上次评分: ${task.lastQualityScore || '?'}分
需要改进的问题: ${task.lastQualityIssues?.join('; ') || '无具体问题'}`;
    }
    
    return desc;
  }

  /**
   * 合并 Provider + 所有外部工具的产出。
   */
  async _mergeToolOutputs(task, providerResult, adapterResults, context) {
    // 收集所有成功的结果
    const allOutputs = {
      provider: { success: true, result: { codeBlocks: providerResult.codeBlocks || [] }, content: providerResult.content || '' }
    };

    let hasAdapters = false;
    for (const [name, r] of Object.entries(adapterResults)) {
      if (r.success && r.codeBlocks && r.codeBlocks.length > 0) {
        allOutputs[name] = { success: true, result: { codeBlocks: r.codeBlocks }, content: r.content || '' };
        hasAdapters = true;
      }
    }

    const successfulCount = Object.keys(allOutputs).length;

    // 只有一个来源（仅 provider），直接返回
    if (!hasAdapters) return providerResult;

    // 使用 MergeEngine 合并
    try {
      const mergeEngine = new MergeEngine(this.provider, { conflictResolution: 'auto' });
      const mergeResult = await mergeEngine.merge(allOutputs, context.constraints || {});

      if (mergeResult.mergedCode) {
        const mergedCodeBlocks = Object.entries(mergeResult.mergedFiles || {}).map(([filePath, code]) => ({
          language: this._getLangFromFilePath(filePath),
          filePath,
          code
        }));

        const finalResult = {
          content: mergeResult.mergedCode,
          codeBlocks: mergedCodeBlocks.length > 0 ? mergedCodeBlocks : providerResult.codeBlocks
        };

        this.emit('multiToolMerged', {
          task,
          toolsUsed: Object.keys(adapterResults).filter(n => adapterResults[n].success),
          conflicts: mergeResult.conflicts?.length || 0,
          quality: mergeResult.qualityAssessment
        });

        finalResult.mergeQuality = mergeResult.qualityAssessment;
        finalResult.mergeReport = mergeResult;
        finalResult._toolCount = successfulCount;

        this.emit('multiToolCompare', this._buildToolCompareReport(providerResult, adapterResults));

        return finalResult;
      }
    } catch (mergeError) {
      this.emit('mergeFailed', { task, error: mergeError.message });
    }

    // 合并失败，回落：选 codeBlocks 最多的结果
    this.emit('multiToolCompare', this._buildToolCompareReport(providerResult, adapterResults));
    return this._pickBestResult(providerResult, adapterResults) || providerResult;
  }

  _getLangFromFilePath(filePath) {
    if (!filePath || filePath === 'main') return 'text';
    const ext = filePath.split('.').pop().toLowerCase();
    const map = {
      js: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby',
      go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp',
      cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin',
      html: 'html', css: 'css', json: 'json', xml: 'xml',
      yaml: 'yaml', yml: 'yaml', md: 'markdown', sql: 'sql',
      sh: 'shell', bash: 'shell', ps1: 'powershell'
    };
    return map[ext] || ext;
  }

  _buildToolCompareReport(providerResult, adapterResults) {
    const report = [];
    report.push({ tool: 'Provider', blocks: (providerResult.codeBlocks || []).length, success: true });
    for (const [name, r] of Object.entries(adapterResults)) {
      report.push({
        tool: r.displayName || name,
        blocks: (r.codeBlocks || []).length,
        success: r.success,
        duration: r.duration || 0,
        error: r.error || null
      });
    }
    return report;
  }

  _pickBestResult(providerResult, adapterResults) {
    let best = providerResult;
    let bestScore = this._scoreResult(providerResult);

    for (const [, r] of Object.entries(adapterResults)) {
      if (!r.success) continue;
      const score = this._scoreResult(r);
      if (score > bestScore) {
        best = r;
        bestScore = score;
      }
    }

    return best === providerResult ? null : best;
  }

  _scoreResult(result) {
    if (!result || !result.success) return 0;
    const blockCount = (result.codeBlocks || []).length;
    const contentLength = (result.content || '').length;
    return blockCount * 100 + Math.min(contentLength / 10, 500);
  }

  async _executeReviewTask(task, context, useSmallModel = false) {
    this.emit('agentWorking', { agent: 'codeReviewer', task, modelSize: useSmallModel ? 'small' : 'large' });
    const codeToReview = context.previousCode || context.previousResults?.[0]?.content || '';
    return await this.agents.codeReviewer.reviewCode(codeToReview, task, {
      acceptanceCriteria: task.acceptanceCriteria,
      constraints: context.constraints, useSmallModel
    });
  }

  async _executeTestTask(task, context, useSmallModel = false) {
    this.emit('agentWorking', { agent: 'tester', task, modelSize: useSmallModel ? 'small' : 'large' });
    const codeToTest = context.previousCode || context.previousResults?.[0]?.content || '';
    return await this.agents.tester.designTests(task, {
      code: codeToTest, acceptanceCriteria: task.acceptanceCriteria,
      constraints: context.constraints, useSmallModel
    });
  }

  async _executeQualityTask(task, context, useSmallModel = false) {
    this.emit('agentWorking', { agent: 'qualityChecker', task, modelSize: useSmallModel ? 'small' : 'large' });
    const contentToCheck = context.previousResults?.[0]?.content || '';
    return await this.agents.qualityChecker.checkQuality(
      task, contentToCheck, { previousTasks: this.tasks.filter(t => t.status === 'completed'), constraints: context.constraints, previousCode: context.previousCode }
    );
  }

  async _checkQuality(task, result, context) {
    this.emit('agentWorking', { agent: 'qualityChecker', task });
    const contentToCheck = result.content || JSON.stringify(result);
    return await this.agents.qualityChecker.checkQuality(task, contentToCheck, {
      previousTasks: this.tasks.filter(t => t.status === 'completed'),
      constraints: context.constraints, previousCode: context.previousCode
    });
  }

  _saveCodeBlocks(task, codeBlocks) {
    const taskDir = `output/${task.id}`;
    codeBlocks.forEach((block, i) => {
      const ext = this._getExtFromLanguage(block.language);
      const fileName = `result_${i + 1}${ext}`;
      const filePath = `${taskDir}/${fileName}`;
      try {
        this.fileManager.writeFile(filePath, block.code);
      } catch (e) {}
    });
  }

  _getExtFromLanguage(lang) {
    const map = {
      javascript: '.js', python: '.py', html: '.html', css: '.css',
      json: '.json', typescript: '.ts', jsx: '.jsx', tsx: '.tsx',
      java: '.java', go: '.go', rust: '.rs', c: '.c', cpp: '.cpp',
      'c++': '.cpp', 'c/c++': '.cpp', objectivec: '.m', csharp: '.cs',
      php: '.php', ruby: '.rb', swift: '.swift', kotlin: '.kt',
      scala: '.scala', sql: '.sql', shell: '.sh', bash: '.sh',
      lua: '.lua', perl: '.pl', haskell: '.hs', fsharp: '.fs',
      dart: '.dart', r: '.r', julia: '.jl'
    };
    return map[lang?.toLowerCase()] || '.txt';
  }

  // ════════════════════════ 最终审查与合并 ════════════════════════
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
        ? Math.round((completedTasks.length / this.tasks.length) * 100)
        : 0,
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
      dependencyValidation: this._validateAllDependencies(),
      privacyMode: this.privacyMode
    };

    // ═══════════════ 契约拼装（隐私模式） ═══════════════
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
          error: contractResult.error,
          issues: contractResult.issues
        });
      }
    }

    // 改动2：增加最终合并质检
    if (this.enableFinalQualityGate && completedTasks.length > 0) {
      const finalQuality = await this._finalQualityGate(originalTask, summary);
      summary.finalQuality = finalQuality;
      if (!finalQuality.canProceed) {
        // 记录最终质检不通过，但不抛异常（用户至少能看到产出）
        summary.finalQualityWarning = '最终质检未通过，产出需要人工审查';
        this.emit('finalQualityWarning', {
          quality: finalQuality,
          warning: summary.finalQualityWarning
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

  /**
   * 契约拼装：从各任务产出中提取契约并拼装
   * 隐私保护核心：只看接口定义，不泄露实现细节
   */
  async _assembleContracts(completedTasks, splitResult) {
    // 1. 收集所有代码块
    const allCodeBlocks = completedTasks
      .filter(t => t.result?.codeBlocks)
      .flatMap(t => t.result.codeBlocks.map(b => ({
        ...b,
        taskId: t.id,
        toolName: t.result?.toolName || 'unknown'
      })));

    if (allCodeBlocks.length === 0) {
      return {
        success: false,
        error: '没有可拼装的代码产出',
        contracts: null
      };
    }

    // 2. 提取契约
    this.emit('contractExtractionStart', { codeBlocks: allCodeBlocks.length });
    const contracts = await this.contractAssembler.extractContracts(allCodeBlocks);

    // 3. 验证契约一致性
    this.emit('contractValidationStart', { contracts: contracts.length });
    const validation = this.contractAssembler.validateContracts(contracts);

    if (!validation.valid) {
      // 契约冲突严重，需要警告
      this.emit('contractConflict', {
        issues: validation.issues,
        warnings: validation.warnings.length,
        errors: validation.errors.length
      });
    }

    // 4. 确定目标语言（从约束或推断）
    const targetLanguage = this.memory.getGlobal('language') ||
      splitResult.constraints?.language ||
      contracts[0]?.language ||
      'c';

    // 5. 拼装代码
    this.emit('contractAssemblyStart', {
      language: targetLanguage,
      contracts: contracts.length,
      validation: validation.valid
    });
    const assemblyResult = this.contractAssembler.assemble(contracts, {
      language: targetLanguage,
      strictMode: false // 隐私模式下不因冲突而失败，而是警告
    });

    // 6. 保存拼装结果
    if (assemblyResult.success && assemblyResult.code) {
      const assemblyDir = `${this.fileManager.workspaceDir}/assembled`;
      const assemblyFile = `${assemblyDir}/${targetLanguage === 'c' ? 'main.h' : `main.${this._getExtFromLanguage(targetLanguage)}`}`;

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
      privacyProtected: true // 标记隐私保护
    };
  }

  /**
   * 最终合并质检：对所有子任务产出做全局审查。
   */
  async _finalQualityGate(originalTask, summary) {
    // 收集所有子任务产出的代码
    const allCode = this.tasks
      .filter(t => t.status === 'completed' && t.result?.codeBlocks)
      .flatMap(t => t.result.codeBlocks);

    if (allCode.length === 0) {
      return {
        canProceed: true,
        qualityScore: 100,
        status: 'completed',
        message: '无代码产出，跳过最终质检'
      };
    }

    const mergedOutput = allCode.map(b => `\`\`\`${b.language}\n${b.code}\n\`\`\``).join('\n\n');

    // 调用QualityChecker做全局审查（传入isFinalReview标记）
    return await this.agents.qualityChecker.checkQuality(
      { id: 'final', title: '最终合并产物审查', description: originalTask },
      mergedOutput,
      { constraints: this.memory.getAllGlobals(), isFinalReview: true }
    );
  }

  _validateAllDependencies() {
    const graph = {};
    const inDegree = {};
    for (const t of this.tasks) {
      graph[t.id] = t.dependsOn || [];
      inDegree[t.id] = inDegree[t.id] || 0;
      for (const dep of t.dependsOn || []) {
        if (!this.tasks.find(task => task.id === dep)) {
          return { valid: false, error: `依赖 ${dep} 不存在` };
        }
        inDegree[t.id]++;
      }
    }

    // 循环检测
    const visited = new Set();
    const recStack = new Set();
    for (const id of Object.keys(graph)) {
      if (!visited.has(id)) {
        const hasCycle = this._hasCycleDFS(id, graph, visited, recStack);
        if (hasCycle) return { valid: false, error: '存在循环依赖' };
      }
    }
    return { valid: true };
  }

  _hasCycleDFS(node, graph, visited, recStack) {
    visited.add(node);
    recStack.add(node);
    for (const neighbor of graph[node] || []) {
      if (!visited.has(neighbor)) {
        if (this._hasCycleDFS(neighbor, graph, visited, recStack)) return true;
      } else if (recStack.has(neighbor)) {
        return true;
      }
    }
    recStack.delete(node);
    return false;
  }

  getFullReport() {
    let report = '';
    report += this.tokenCounter.getReport();
    report += this.cacheStore.getReport();
    report += this.modelRouter.getReport();
    return report;
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
  getHistoricalContext(count = 3) {
    const recentReports = this.reportGenerator.getRecentReports(count);
    return this.reportGenerator.getContextSummary(recentReports.map(r => r.id));
  }
  getReportGenerator() { return this.reportGenerator; }
}

module.exports = TaskOrchestrator;
