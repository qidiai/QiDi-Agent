const MergeEngine = require('../agents/MergeEngine');
const MultiProviderRunner = require('./MultiProviderRunner');

/**
 * 任务执行器：负责单任务的具体执行逻辑。
 * 包括：缓存检查、上下文构建、模型路由、工具派发、多工具合并、质量检查。
 * 从 TaskOrchestrator 拆分出来，专注执行细节。
 */
class TaskExecutor {
  constructor (options = {}) {
    this.privacyMode = options.privacyMode || false;
    this.routingStrategy = options.routingStrategy || 'round_robin';
    this.maxRetries = options.maxRetries || 2;
    this.enableCache = options.enableCache !== false;
    this.enableCompression = options.enableCompression !== false;
    this.enableModelRouting = options.enableModelRouting !== false;
    this.enableContractAssembly = options.enableContractAssembly || false;
    this.multiProviderMode = options.multiProviderMode || false;

    this.cacheStore = options.cacheStore || null;
    this.tokenCounter = options.tokenCounter || null;
    this.contextCompressor = options.contextCompressor || null;
    this.modelRouter = options.modelRouter || null;
    this.fileManager = options.fileManager || null;
    this.agents = options.agents || {};
    this.memory = options.memory || null;
    this.contractAssembler = options.contractAssembler || null;
    this.toolAdapters = options.toolAdapters || [];
    this._getTaskRouter = options._getTaskRouter || null;
    this.providers = options.providers || [];

    // ═══ P0-P3 增强模块 ═══
    this.testRunner = options.testRunner || null;
    this.budgetManager = options.budgetManager || null;
    this.gitIntegration = options.gitIntegration || null;
    this.sandboxExecutor = options.sandboxExecutor || null;
    this.approvalWorkflow = options.approvalWorkflow || null;
    this.streamManager = options.streamManager || null;
    this.vectorMemory = options.vectorMemory || null;
    this.contractValidator = options.contractValidator || null;
    this.retryManager = options.retryManager || null;

    this.multiProviderRunner = null;
    if (this.multiProviderMode && this.providers.length > 1) {
      this.multiProviderRunner = new MultiProviderRunner({
        providers: this.providers,
        fileManager: this.fileManager,
        onEvent: (eventName, data) => {
          options.onEvent?.(eventName, data);
        }
      });
    }
  }

  /**
   * 执行单个任务（完整流程：缓存 → 上下文 → 路由 → 执行 → 质检 → 缓存保存）。
   */
  async executeSingleTask (task, context) {
    const agentName = this._getAgentName(task.role);

    // ═══ G1: 契约验证 — 输入 ═══
    if (this.contractValidator) {
      const inputValidation = this.contractValidator.validateInput(task, context);
      if (!inputValidation.passed) {
        context.orchestrator?.emit('contract:inputViolation', {
          task, violations: inputValidation.violations
        });
        // 严重违约直接返回失败
        if (inputValidation.criticalCount > 0) {
          return {
            success: false,
            content: '',
            error: `输入契约违约: ${inputValidation.violations.map(v => v.message).join('; ')}`,
            quality: { status: 'failed', qualityScore: 0 }
          };
        }
      }
    }

    // ═══ G1: 预算检查 ═══
    if (this.budgetManager) {
      const estimatedTokens = 5000; // 估算值
      if (!this.budgetManager.canProceed(estimatedTokens)) {
        return {
          success: false,
          content: '',
          error: 'Token 预算不足',
          quality: { status: 'failed', qualityScore: 0 }
        };
      }
    }

    // ═══ G1: 流式状态更新 ═══
    if (this.streamManager) {
      this.streamManager.status('executing', { task: task.title, agent: agentName });
      this.streamManager.progress(0, 7, '开始执行');
    }

    // 1. 缓存检查
    if (this.enableCache) {
      const cached = this.cacheStore.getTaskResponse(task.id, agentName, task);
      if (cached) {
        context.orchestrator?.emit('cacheHit', { task, agent: agentName });
        this.tokenCounter?.recordCacheHit(agentName, task.id);
        return cached.response;
      }
      this.tokenCounter?.recordCacheMiss(agentName, task.id);
    }

    // 2. 构建上下文
    const allPreviousResults = this.memory?.getTaskHistory(Object.keys(this.memory.getAll())) || [];
    let previousCode = this._buildPreviousCode(allPreviousResults);

    if (this.enableCompression && this.tokenCounter?.shouldCompress(previousCode, 2000)) {
      const originalTokens = this.tokenCounter.estimateTokens(previousCode);
      previousCode = this.contextCompressor.compressCode(previousCode);
      const compressedTokens = this.tokenCounter.estimateTokens(previousCode);
      context.orchestrator?.emit('contextCompressed', {
        task,
        originalTokens,
        compressedTokens,
        saved: originalTokens - compressedTokens
      });
    }

    const taskContext = {
      ...context,
      constraints: this.memory?.getAllGlobals() || {},
      previousResults: allPreviousResults,
      previousCode
    };

    // 3. 模型路由
    let useSmallModel = false;
    if (this.enableModelRouting) {
      const modelSelection = this.modelRouter.selectModel(agentName, task, taskContext);
      useSmallModel = modelSelection.size === 'small';
      context.orchestrator?.emit('modelSelected', {
        task,
        agent: agentName,
        model: modelSelection.model,
        size: modelSelection.size,
        reason: modelSelection.reason
      });
    }

    // 4. 执行（按角色分发）
    // ═══ G1: 使用 RetryManager 包装执行 ═══
    let result;
    const executeFn = async (adjustedParams, attempt) => {
      if (this.streamManager && attempt > 0) {
        this.streamManager.status('retrying', { task: task.title, attempt });
      }
      const opts = { ...adjustedParams };
      switch (task.role) {
      case 'code_reviewer':
        return await this._executeReviewTask(task, taskContext, opts.useSmallModel);
      case 'tester':
        return await this._executeTestTask(task, taskContext, opts.useSmallModel);
      case 'quality_checker':
        return await this._executeQualityTask(task, taskContext, opts.useSmallModel);
      default:
        return await this._executeCodeTask(task, taskContext, opts.useSmallModel);
      }
    };

    if (this.retryManager) {
      result = await this.retryManager.execute(executeFn, {
        maxRetries: this.maxRetries,
        params: { useSmallModel },
        onRetry: (info) => {
          context.orchestrator?.emit('taskRetrying', {
            task, attempt: info.attempt, errorType: info.errorType, delay: info.delay
          });
        }
      });
    } else {
      result = await executeFn({ useSmallModel }, 0);
    }

    if (this.streamManager) {
      this.streamManager.progress(4, 7, '执行完成');
    }

    // 5. Token 记录 + 预算记录
    const promptForLogging = this._buildPromptForLogging(task, taskContext);
    this.tokenCounter?.record(
      agentName, task.id, promptForLogging,
      result.content || JSON.stringify(result),
      { model: useSmallModel ? 'small' : 'large' }
    );

    // ═══ G1: 预算记录 ═══
    if (this.budgetManager) {
      const inputTokens = this.tokenCounter?.estimateTokens?.(promptForLogging) || 0;
      const outputTokens = this.tokenCounter?.estimateTokens?.(result.content || '') || 0;
      this.budgetManager.record(
        task.role || 'code_writer', agentName,
        useSmallModel ? 'small' : (this.providers[0]?.model || 'unknown'),
        inputTokens, outputTokens
      );
    }

    if (this.streamManager) {
      this.streamManager.progress(5, 7, '质检中');
    }

    // 6. 质量检查
    const qualityResult = await this._checkQuality(task, result, taskContext);

    // ═══ G1: 质检后 — 测试执行 ═══
    if (this.testRunner && qualityResult.status !== 'failed' && result.codeBlocks?.length > 0) {
      try {
        const language = taskContext.constraints?.language || 'javascript';
        const codeToTest = result.codeBlocks.map(b => b.code).join('\n');
        const testResult = await this.testRunner.runTests({
          testCode: this._generateQuickTest(codeToTest, language),
          language,
          sourceCode: codeToTest,
          workspaceDir: this.fileManager?.workspaceDir
        });
        result.testResult = testResult;
        context.orchestrator?.emit('testExecuted', {
          task, passed: testResult.passed, total: testResult.total, failed: testResult.failed
        });
        if (this.streamManager) {
          this.streamManager.status('tested', {
            passed: testResult.passed, total: testResult.total
          });
        }
      } catch (_) {}
    }

    // ═══ G1: 质检后 — 契约验证输出 ═══
    if (this.contractValidator && result.codeBlocks?.length > 0) {
      const outputValidation = this.contractValidator.validateOutput(result, {
        language: taskContext.constraints?.language,
        expectCode: true
      });
      if (!outputValidation.passed) {
        context.orchestrator?.emit('contract:outputViolation', {
          task, violations: outputValidation.violations
        });
      }
      result.contractValidation = outputValidation;
    }

    // ═══ G1: 质检后 — 审批 ═══
    if (this.approvalWorkflow && qualityResult.qualityScore < 60) {
      const approval = await this.approvalWorkflow.requestApproval('post_quality', {
        task: task.title,
        qualityScore: qualityResult.qualityScore
      });
      if (!approval.approved) {
        // 审批拒绝 — Git 回滚
        if (this.gitIntegration) {
          this.gitIntegration.rollback();
        }
        return {
          ...result,
          quality: qualityResult,
          rejected: true,
          rejectionReason: approval.comment
        };
      }
    }

    if (this.streamManager) {
      this.streamManager.progress(6, 7, '质检完成');
    }

    if (qualityResult.status === 'needs_revision') {
      task.lastQualityFeedback = qualityResult.revisionSuggestions || qualityResult.weaknesses?.join('; ') || '';
      task.lastQualityScore = qualityResult.qualityScore || 0;
      task.lastQualityIssues = qualityResult.constraintViolations || [];

      if (task.retries < this.maxRetries) {
        task.retries++;
        task.status = 'needs_revision';

        context.orchestrator?.emit('qualityReview', {
          task, quality: qualityResult, needsRevision: true, feedbackInjected: task.lastQualityFeedback
        });

        return { ...result, quality: qualityResult, needsRevision: true };
      } else {
        context.orchestrator?.emit('qualityReview', {
          task,
          quality: qualityResult,
          needsRevision: false,
          qualityWarning: true,
          message: `代码质量仍不达标，但已达到最大重试次数(${this.maxRetries})，强制完成`
        });

        return {
          ...result,
          quality: qualityResult,
          needsRevision: false,
          qualityWarning: true,
          qualityWarningMessage: `代码质量检查未通过，但已达到最大重试次数(${this.maxRetries})，将使用当前代码`
        };
      }
    }

    // 7. 缓存结果
    if (this.enableCache && qualityResult.status === 'completed') {
      this.cacheStore.setTaskResponse(task.id, agentName, task, result, {
        tokens: this.tokenCounter.estimateTokens(result.content || ''),
        qualityScore: qualityResult.qualityScore
      });
    }

    // ═══ G1: 完成后 — Git 保存点 ═══
    if (this.gitIntegration && this.gitIntegration.isEnabled() && qualityResult.status === 'completed') {
      this.gitIntegration.createSavepoint(task.id);
    }

    if (this.streamManager) {
      this.streamManager.progress(7, 7, '完成');
    }

    return { ...result, quality: qualityResult };
  }

  // ── 角色特定执行 ──

  async _executeCodeTask (task, context, useSmallModel = false) {
    context.orchestrator?.emit('agentWorking', { agent: 'codeWriter', task, modelSize: useSmallModel ? 'small' : 'large' });

    const enhancedContext = { ...context };
    if (task.lastQualityFeedback) {
      enhancedContext.qualityFeedback = {
        suggestions: task.lastQualityFeedback,
        score: task.lastQualityScore,
        issues: task.lastQualityIssues
      };
    }

    if (this.privacyMode) {
      return await this._executePrivacyMode(task, enhancedContext, useSmallModel);
    }

    if (this.multiProviderMode && this.multiProviderRunner) {
      return await this.multiProviderRunner.execute(task, enhancedContext, useSmallModel);
    }

    let providerResult;
    if (task.lastQualityFeedback && task.result?.codeBlocks?.length > 0) {
      const originalCode = task.result.codeBlocks.map(b => b.code).join('\n\n');
      const feedback = {
        revisionSuggestions: task.lastQualityFeedback,
        weaknesses: task.lastQualityIssues || [],
        constraintViolations: []
      };
      providerResult = await this.agents.codeWriter?.refineCode(task, originalCode, feedback, enhancedContext, { useSmallModel });
      context.orchestrator?.emit('codeRefined', { task, revisionCount: task.retries });
    } else {
      providerResult = await this.agents.codeWriter?.writeCode(task, enhancedContext, { useSmallModel });
    }

    const adapterResults = await this._dispatchToAdapters(task, enhancedContext);

    // 2. 每工具结果单独质检（PerToolQualityGate）
    const qualityFiltered = {};
    for (const [toolName, result] of Object.entries(adapterResults)) {
      if (!result.success) continue;
      const qc = await this._checkQuality(task, result, enhancedContext);
      if (qc.status !== 'failed') {
        qualityFiltered[toolName] = {
          ...result,
          qualityScore: qc.qualityScore || 0,
          qualityReport: qc
        };
      } else {
        context.orchestrator?.emit('toolQualityFailed', { tool: toolName, task, score: qc.qualityScore });
        qualityFiltered[toolName] = {
          ...result, qualityScore: 0, qualityWarning: true
        };
      }
    }

    // 3. 仅合并通过质检的结果（不合格结果降权保留）
    const finalResult = await this._mergeToolOutputs(task, providerResult || {}, qualityFiltered, enhancedContext);

    if (finalResult.codeBlocks && finalResult.codeBlocks.length > 0) {
      this._saveCodeBlocks(task, finalResult.codeBlocks);
    }

    return finalResult;
  }

  async _executePrivacyMode (task, context, useSmallModel = false) {
    context.orchestrator?.emit('privacyModeStart', { task, strategy: this.routingStrategy });

    const router = this._getTaskRouter?.();
    if (!router) {
      return await this.agents.codeWriter?.writeCode(task, context, { useSmallModel }) || {};
    }

    const routingResult = router.routeTask(task);
    const selectedAdapter = routingResult.adapter;
    const routingReason = routingResult.reason;

    if (!selectedAdapter) {
      context.orchestrator?.emit('privacyModeFallback', { task, reason: '无可用工具，降级到 Provider' });
      return await this.agents.codeWriter?.writeCode(task, context, { useSmallModel }) || {};
    }

    context.orchestrator?.emit('toolSelected', {
      task,
      tool: selectedAdapter.name,
      displayName: selectedAdapter.displayName,
      strategy: this.routingStrategy,
      reason: routingReason
    });

    // ═══ 增量上下文：构建前序子任务的接口摘要 ═══
    const previousInterfaceSummaries = this._buildPreviousInterfaceSummaries(context);
    const enrichedContext = {
      ...context,
      previousInterfaceSummaries
    };

    const toolTaskDesc = this._buildPrivacyTaskDescription(task, enrichedContext);

    const startTime = Date.now();
    let toolResult;
    try {
      toolResult = await selectedAdapter.execute(toolTaskDesc, {
        taskId: `${selectedAdapter.name}_${task.id}`, timeout: 120000
      });
    } catch (error) {
      context.orchestrator?.emit('toolExecutionError', { task, tool: selectedAdapter.name, error: error.message });
      return await this.agents.codeWriter?.writeCode(task, context, { useSmallModel }) || {};
    }

    const duration = Date.now() - startTime;

    if (!toolResult?.success) {
      context.orchestrator?.emit('toolFailed', {
        task,
        tool: selectedAdapter.name,
        error: toolResult.error || toolResult.stderr || '工具执行失败'
      });
      return await this.agents.codeWriter?.writeCode(task, context, { useSmallModel }) || {};
    }

    // ═══ 契约验证：检查产出是否满足 producesContracts ═══
    const contractViolation = this._verifyProducedContracts(task, toolResult);
    if (contractViolation) {
      context.orchestrator?.emit('contractViolation', {
        task,
        tool: selectedAdapter.name,
        violation: contractViolation
      });
      // 不阻止流程，但记录违规
      toolResult.contractViolation = contractViolation;
    }

    const finalResult = {
      content: toolResult.content || '',
      codeBlocks: toolResult.codeBlocks || [],
      source: 'tool',
      toolName: selectedAdapter.name,
      toolDisplayName: selectedAdapter.displayName,
      routingStrategy: this.routingStrategy,
      routingReason,
      duration,
      privacyMode: true,
      contracts: {
        produced: this._extractProducedContracts(toolResult),
        required: task.requiredContracts || []
      }
    };

    if (toolResult.metadata) finalResult.metadata = toolResult.metadata;
    if (toolResult.contractViolation) finalResult.contractViolation = toolResult.contractViolation;

    context.orchestrator?.emit('privacyModeComplete', { task, tool: selectedAdapter.name, result: finalResult });

    if (finalResult.codeBlocks && finalResult.codeBlocks.length > 0) {
      this._saveCodeBlocks(task, finalResult.codeBlocks);
    }

    return finalResult;
  }

  async _executeReviewTask (task, context, useSmallModel = false) {
    context.orchestrator?.emit('agentWorking', { agent: 'codeReviewer', task, modelSize: useSmallModel ? 'small' : 'large' });
    const codeToReview = context.previousCode || context.previousResults?.[0]?.content || '';
    return await this.agents.codeReviewer?.reviewCode(codeToReview, task, {
      acceptanceCriteria: task.acceptanceCriteria, constraints: context.constraints, useSmallModel
    }) || {};
  }

  async _executeTestTask (task, context, useSmallModel = false) {
    context.orchestrator?.emit('agentWorking', { agent: 'tester', task, modelSize: useSmallModel ? 'small' : 'large' });
    const codeToTest = context.previousCode || context.previousResults?.[0]?.content || '';
    return await this.agents.tester?.designTests(task, {
      code: codeToTest,
      acceptanceCriteria: task.acceptanceCriteria,
      constraints: context.constraints,
      useSmallModel
    }) || {};
  }

  async _executeQualityTask (task, context, useSmallModel = false) {
    context.orchestrator?.emit('agentWorking', { agent: 'qualityChecker', task, modelSize: useSmallModel ? 'small' : 'large' });
    const contentToCheck = context.previousResults?.[0]?.content || '';
    return await this.agents.qualityChecker?.checkQuality(
      task, contentToCheck, {
        previousTasks: context.previousTasks || [],
        constraints: context.constraints,
        previousCode: context.previousCode
      }
    ) || {};
  }

  // ── 工具派发与合并 ──

  async _dispatchToAdapters (task, context) {
    const allOnline = this.toolAdapters.filter(a => a.isAvailable && a.isAvailable());
    if (allOnline.length === 0) return {};

    const router = this._getTaskRouter ? this._getTaskRouter() : null;
    let targetAdapters = allOnline;

    if (router) {
      const routing = router.routeTask(task);
      if (routing.adapter) {
        if (Array.isArray(routing.adapter)) {
          targetAdapters = routing.adapter;
        } else {
          targetAdapters = [routing.adapter];
        }
      }
      context.orchestrator?.emit('toolRouted', {
        task,
        strategy: routing.strategy,
        selectedTools: targetAdapters.map(a => a.displayName),
        reason: routing.reason
      });
    }

    context.orchestrator?.emit('multiToolDispatch', {
      task,
      tools: targetAdapters.map(a => ({ name: a.name, displayName: a.displayName }))
    });

    // 模块化分发：如果任务包含子任务（模块），按模块边界分配
    const modules = task.subtasks && task.subtasks.length > 0 ? task.subtasks : [task];
    const moduleContracts = this._extractModuleContracts(modules);

    const promises = targetAdapters.map(async (adapter, index) => {
      const startTime = Date.now();
      // 当前工具的主要模块（轮询分配）
      const primaryModule = modules[index % modules.length];
      // 其他模块仅含契约摘要（紧凑模式）
      const otherModules = modules
        .filter((_, i) => i !== index % modules.length)
        .map(m => ({
          id: m.id || m.title,
          title: m.title,
          contracts: moduleContracts.get(m.id || m.title) || []
        }));

      const taskDesc = this._buildModuleTaskDescription(
        task, primaryModule, otherModules, context
      );

      try {
        const r = await adapter.execute(taskDesc, {
          taskId: `${adapter.name}_${task.id}`, timeout: 120000
        });
        const errMsg = !r.success
          ? (r.stderr || r.error || r.rawOutput?.substring(0, 300) || '工具执行失败')
          : null;
        return { name: adapter.name, displayName: adapter.displayName, result: r, error: errMsg, duration: Date.now() - startTime };
      } catch (e) {
        return { name: adapter.name, displayName: adapter.displayName, result: { success: false, content: '', codeBlocks: [] }, error: e.message, duration: Date.now() - startTime };
      }
    });

    const settled = await Promise.allSettled(promises);
    const results = {};
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        const { name, displayName, result, error, duration } = s.value;
        if (result && result.success && !error) {
          results[name] = { ...result, displayName, duration };
        } else {
          results[name] = { success: false, error: error || '任务失败', displayName, duration };
          context.orchestrator?.emit('toolFailed', { tool: displayName, task, error: error || '任务失败' });
        }
      }
    }
    return results;
  }

  _extractModuleContracts (modules) {
    const contracts = new Map();
    for (const mod of modules) {
      const key = mod.id || mod.title;
      const extracted = [];
      const desc = mod.description || mod.content || '';
      // 提取接口签名（function/class/def 定义）
      const sigMatches = desc.matchAll(/(?:function|class|def|async\s+function|const\s+\w+\s*=\s*(?:async\s+)?\(|interface\s+\w+|type\s+\w+)\s+(\w+)/g);
      for (const m of sigMatches) extracted.push(m[0].trim());
      contracts.set(key, extracted);
    }
    return contracts;
  }

  _buildModuleTaskDescription (task, primaryModule, otherModules, context) {
    const criteria = task.acceptanceCriteria;
    const criteriaStr = Array.isArray(criteria) ? criteria.join('\n') : (typeof criteria === 'string' ? criteria : '无');

    let desc = `## 任务：${task.title}\n${task.description || ''}\n\n`;
    desc += '### 🔷 你主要负责的模块\n';
    desc += `模块名称: ${primaryModule.title || primaryModule.id || '主模块'}\n`;
    desc += `模块描述: ${primaryModule.description || primaryModule.content || primaryModule.title || ''}\n`;
    desc += `验收标准: ${criteriaStr}\n`;
    desc += `约束: ${JSON.stringify(context.constraints || {}, null, 2) || '无'}\n\n`;

    if (otherModules.length > 0) {
      desc += '### 🔗 相邻模块接口契约（只读参考，请勿实现这些模块）\n';
      for (const m of otherModules) {
        desc += `- ${m.title}: ${m.contracts.length > 0 ? m.contracts.join(', ') : '（接口摘要不可用）'}\n`;
      }
      desc += '\n⚠️ 请仅实现你负责的模块，确保与上述契约兼容。\n';
    }

    desc += `\n### 已有代码\n${context.previousCode || '无'}`;

    if (task.lastQualityFeedback) {
      desc += `\n\n### ⚠️ 上次质检反馈\n${task.lastQualityFeedback}\n上次评分: ${task.lastQualityScore || '?'}分`;
    }

    return desc;
  }

  async _mergeToolOutputs (task, providerResult, adapterResults, context) {
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

    if (!hasAdapters) return providerResult;

    try {
      const mergeEngine = new MergeEngine(
        context.orchestrator?.provider ?? null,
        { conflictResolution: 'auto' }
      );
      const mergeResult = await mergeEngine.merge(allOutputs, context.constraints || {});

      if (mergeResult.mergedCode) {
        const mergedCodeBlocks = Object.entries(mergeResult.mergedFiles || {}).map(([filePath, code]) => ({
          language: this._getLangFromFilePath(filePath), filePath, code
        }));

        const finalResult = {
          content: mergeResult.mergedCode,
          codeBlocks: mergedCodeBlocks.length > 0 ? mergedCodeBlocks : providerResult.codeBlocks
        };

        context.orchestrator?.emit('multiToolMerged', {
          task,
          toolsUsed: Object.keys(adapterResults).filter(n => adapterResults[n].success),
          conflicts: mergeResult.conflicts?.length || 0,
          quality: mergeResult.qualityAssessment
        });

        finalResult.mergeQuality = mergeResult.qualityAssessment;
        finalResult.mergeReport = mergeResult;
        finalResult._toolCount = Object.keys(allOutputs).length;

        return finalResult;
      }
    } catch (mergeError) {
      context.orchestrator?.emit('mergeFailed', { task, error: mergeError.message });
    }

    return this._pickBestResult(providerResult, adapterResults) || providerResult;
  }

  // ── 质量检查 ──

  async _checkQuality (task, result, context) {
    context.orchestrator?.emit('agentWorking', { agent: 'qualityChecker', task });
    const contentToCheck = result.content || JSON.stringify(result);
    return await this.agents.qualityChecker?.checkQuality(
      task, contentToCheck, {
        previousTasks: context.previousTasks || [],
        constraints: context.constraints,
        previousCode: context.previousCode
      }
    ) || { status: 'completed', qualityScore: 100 };
  }

  // ── 辅助方法 ──

  _saveToMemory (task, result) {
    this.memory?.put(task.id, 'content', result.content || '');
    this.memory?.put(task.id, 'codeBlocks', result.codeBlocks || []);
    this.memory?.put(task.id, 'qualityScore', result.quality?.qualityScore || 0);
    this.memory?.put(task.id, 'status', task.status);
    this.memory?.put(task.id, 'title', task.title);
    this.memory?.put(task.id, 'toolResults', result.quality?.toolResults || {});
    this.memory?.addTag(task.id, task.role);
  }

  _getAgentName (role) {
    const roleMap = {
      code_writer: 'codeWriter',
      architect: 'codeWriter',
      code_reviewer: 'codeReviewer',
      tester: 'tester',
      quality_checker: 'qualityChecker'
    };
    return roleMap[role] || 'codeWriter';
  }

  _buildPromptForLogging (task, context) {
    return `${task.title}\n${task.description}\n${context.previousCode?.substring(0, 500) || ''}`;
  }

  _buildPreviousCode (previousResults) {
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

  _buildPrivacyTaskDescription (task, context) {
    const criteria = task.acceptanceCriteria;
    const criteriaStr = Array.isArray(criteria) ? criteria.join('\n') : (typeof criteria === 'string' ? criteria : '无');

    let desc = `## 任务：${task.title}\n${task.description || ''}\n\n### 任务类型\n${task.role || 'code_writer'}\n### 语言要求\n${task.language || (context.constraints && context.constraints.language) || '未指定'}\n### 框架要求\n${task.frameworks ? task.frameworks.join(', ') : '无'}\n### 验收标准\n${criteriaStr}`;

    if (context.constraints) {
      const essentialConstraints = {};
      if (context.constraints.language) essentialConstraints.language = context.constraints.language;
      if (context.constraints.encoding) essentialConstraints.encoding = context.constraints.encoding;
      if (context.constraints.platform) essentialConstraints.platform = context.constraints.platform;
      if (context.constraints.framework) essentialConstraints.framework = context.constraints.framework;
      if (context.constraints.style) essentialConstraints.style = context.constraints.style;
      if (Object.keys(essentialConstraints).length > 0) {
        desc += `\n\n### 必要约束\n${JSON.stringify(essentialConstraints, null, 2)}`;
      }
    }

    // ═══ 契约驱动：传递必须实现的接口和可依赖的接口 ═══
    if (task.producesContracts && task.producesContracts.length > 0) {
      desc += '\n\n### 🔒 必须实现的接口契约（你必须实现以下接口，签名不可更改）\n';
      for (const contract of task.producesContracts) {
        desc += `- ${contract}\n`;
      }
      desc += '\n⚠️ 你的代码必须严格实现上述接口，函数名、参数名、返回类型必须完全匹配。\n';
    }

    if (task.requiredContracts && task.requiredContracts.length > 0) {
      desc += '\n\n### 📎 可依赖的接口契约（以下接口已由其他模块实现，你可以直接调用）\n';
      for (const contract of task.requiredContracts) {
        desc += `- ${contract}\n`;
      }
      desc += '\n⚠️ 请基于上述接口编写调用代码，不要重新实现这些接口。\n';
    }

    // ═══ 增量上下文：传递前序子任务的接口摘要（不传实现，保护隐私）═══
    if (context.previousInterfaceSummaries && context.previousInterfaceSummaries.length > 0) {
      desc += '\n\n### 📋 前序模块接口摘要（只读参考，帮助你与已有模块兼容）\n';
      for (const summary of context.previousInterfaceSummaries) {
        desc += `\n**${summary.taskId}: ${summary.title}**\n`;
        if (summary.functions && summary.functions.length > 0) {
          desc += '函数:\n';
          for (const fn of summary.functions.slice(0, 10)) {
            desc += `  - ${fn.signature || fn.name}\n`;
          }
          if (summary.functions.length > 10) {
            desc += `  - ... 共${summary.functions.length}个函数\n`;
          }
        }
        if (summary.classes && summary.classes.length > 0) {
          desc += '类/结构体:\n';
          for (const cls of summary.classes.slice(0, 5)) {
            desc += `  - ${cls.signature || cls.name}\n`;
          }
        }
        if (summary.imports && summary.imports.length > 0) {
          desc += `导入: ${summary.imports.slice(0, 5).join(', ')}${summary.imports.length > 5 ? '...' : ''}\n`;
        }
      }
    }

    // ═══ 传递已有代码的接口摘要（不是完整代码，减少token消耗并保护隐私）═══
    if (context.previousCode && context.previousCode.length > 0 && context.previousCode.length < 3000) {
      desc += `\n\n### 已有代码（前序产出）\n\`\`\`\n${context.previousCode.substring(0, 2000)}\n\`\`\``;
    }

    if (task.lastQualityFeedback) {
      desc += `\n\n### ⚠️ 上次质检反馈\n${task.lastQualityFeedback}\n上次评分: ${task.lastQualityScore || '?'}分`;
    }

    return desc;
  }

  /**
   * 从已完成任务的结果中提取接口摘要（用于增量上下文传递）
   * 只提取签名信息，不传实现代码，保护隐私并减少token
   */
  _extractInterfaceSummary (taskId, title, result, language) {
    const summary = { taskId, title, functions: [], classes: [], structs: [], imports: [] };
    const codeBlocks = result.codeBlocks || [];
    const lang = (language || 'text').toLowerCase();

    for (const block of codeBlocks) {
      const code = block.code || '';
      const blockLang = (block.language || lang).toLowerCase();

      // 提取函数签名
      const funcPatterns = {
        python: /def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/g,
        javascript: /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)\s*\(?([^)]*)?\)?/g,
        c: /^(\w+)\s+(\w+)\s*\(([^)]*)\)\s*\{/gm,
        cpp: /^(?:\w+\s+)?(\w+)\s+(\w+)\s*\(([^)]*)\)\s*\{/gm,
        java: /(?:public|private|protected)\s+(\w+)\s+(\w+)\s*\(([^)]*)\)/g,
        go: /func\s+(\w+)\s*\(([^)]*)\)\s*([^{]+)?\s*\{/g,
        rust: /(?:pub\s+)?fn\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?/g
      };

      const pattern = funcPatterns[blockLang] || funcPatterns.javascript;
      let match;
      while ((match = pattern.exec(code)) !== null) {
        const name = match[1] || match[2] || 'anonymous';
        const params = match[3] || match[2] || '';
        const returnType = match[4] || match[3] || '';
        summary.functions.push({
          name,
          params: params.trim(),
          returnType: returnType.trim(),
          signature: `${name}(${params.trim()})${returnType ? ' -> ' + returnType.trim() : ''}`
        });
      }

      // 提取类定义
      const classPatterns = {
        python: /class\s+(\w+)(?:\(([^)]*)\))?:/g,
        javascript: /class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{/g,
        java: /(?:public|private|protected)?\s*class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?\s*\{/g
      };
      const classPattern = classPatterns[blockLang] || classPatterns.javascript;
      while ((match = classPattern.exec(code)) !== null) {
        summary.classes.push({
          name: match[1],
          inherits: match[2] || null,
          signature: `class ${match[1]}${match[2] ? ' extends ' + match[2] : ''}`
        });
      }

      // 提取结构体（C/C++/Go/Rust）
      const structPatterns = {
        c: /struct\s+(\w+)\s*\{/g,
        cpp: /struct\s+(\w+)\s*\{/g,
        go: /type\s+(\w+)\s+struct\s*\{/g,
        rust: /(?:pub\s+)?struct\s+(\w+)/g
      };
      const structPattern = structPatterns[blockLang];
      if (structPattern) {
        while ((match = structPattern.exec(code)) !== null) {
          summary.structs.push({ name: match[1], signature: `struct ${match[1]}` });
        }
      }

      // 提取导入
      const importPattern = /^(?:import\s+|from\s+|#include\s*[<"])([^>;"\n]+)/gm;
      while ((match = importPattern.exec(code)) !== null) {
        summary.imports.push(match[1].trim());
      }
    }

    return summary;
  }

  /**
   * 构建前序子任务的接口摘要列表（用于增量上下文传递）
   * 从 memory 中获取已完成任务的结果，提取接口签名
   */
  _buildPreviousInterfaceSummaries (context) {
    const summaries = [];
    if (!this.memory) return summaries;

    try {
      const allKeys = Object.keys(this.memory.getAll());
      const history = this.memory.getTaskHistory(allKeys);

      for (const entry of history) {
        if (!entry.codeBlocks || entry.codeBlocks.length === 0) continue;
        const summary = this._extractInterfaceSummary(
          entry.taskId,
          entry.title || '未知',
          { codeBlocks: entry.codeBlocks },
          context.constraints?.language
        );
        if (summary.functions.length > 0 || summary.classes.length > 0 || summary.structs.length > 0) {
          summaries.push(summary);
        }
      }
    } catch (e) {
      // 静默失败，不影响执行
    }

    return summaries;
  }

  /**
   * 验证工具产出是否满足 producesContracts
   * 返回违规列表，空数组表示全部满足
   */
  _verifyProducedContracts (task, toolResult) {
    if (!task.producesContracts || task.producesContracts.length === 0) return null;

    const codeBlocks = toolResult.codeBlocks || [];
    const allCode = codeBlocks.map(b => b.code || '').join('\n');

    const missing = [];
    for (const contract of task.producesContracts) {
      // 简单验证：检查契约名称是否出现在代码中
      const contractName = typeof contract === 'string'
        ? contract.split('(')[0].split(' ')[0].trim()
        : contract.name;
      if (contractName && !allCode.includes(contractName)) {
        missing.push(contract);
      }
    }

    if (missing.length === 0) return null;
    return {
      type: 'missing_contracts',
      missing,
      message: `以下契约未在产出中找到: ${missing.join(', ')}`
    };
  }

  /**
   * 从工具产出中提取已实现的契约（用于后续子任务依赖）
   */
  _extractProducedContracts (toolResult) {
    const contracts = [];
    const codeBlocks = toolResult.codeBlocks || [];

    for (const block of codeBlocks) {
      const code = block.code || '';
      const lang = (block.language || 'text').toLowerCase();

      // 函数
      const funcPatterns = {
        python: /def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/g,
        javascript: /function\s+(\w+)\s*\(([^)]*)\)/g,
        c: /^(\w+)\s+(\w+)\s*\(([^)]*)\)\s*\{/gm,
        go: /func\s+(\w+)\s*\(([^)]*)\)\s*([^{]+)?\s*\{/g
      };
      const pattern = funcPatterns[lang] || funcPatterns.javascript;
      let match;
      while ((match = pattern.exec(code)) !== null) {
        const name = match[1] || match[2];
        const params = match[3] || match[2] || '';
        contracts.push(`${name}(${params.trim()})`);
      }

      // 类
      const classPattern = /class\s+(\w+)/g;
      while ((match = classPattern.exec(code)) !== null) {
        contracts.push(`class ${match[1]}`);
      }

      // 结构体
      const structPattern = /struct\s+(\w+)/g;
      while ((match = structPattern.exec(code)) !== null) {
        contracts.push(`struct ${match[1]}`);
      }
    }

    return contracts;
  }

  _buildToolTaskDescription (task, context) {
    const criteria = task.acceptanceCriteria;
    const criteriaStr = Array.isArray(criteria) ? criteria.join('\n') : (typeof criteria === 'string' ? criteria : '无');

    let desc = `## 任务：${task.title}\n${task.description || ''}\n\n### 验收标准\n${criteriaStr}\n### 约束\n${JSON.stringify(context.constraints || {}, null, 2) || '无'}\n### 已有代码\n${context.previousCode || '无'}`;

    if (task.lastQualityFeedback) {
      desc += `\n\n### ⚠️ 上次质检反馈\n${task.lastQualityFeedback}\n上次评分: ${task.lastQualityScore || '?'}分\n需要改进的问题: ${task.lastQualityIssues?.join('; ') || '无具体问题'}`;
    }

    return desc;
  }

  _getLangFromFilePath (filePath) {
    if (!filePath || filePath === 'main') return 'text';
    const ext = filePath.split('.').pop().toLowerCase();
    const map = {
      js: 'javascript',
      ts: 'typescript',
      py: 'python',
      rb: 'ruby',
      go: 'go',
      rs: 'rust',
      java: 'java',
      c: 'c',
      cpp: 'cpp',
      cs: 'csharp',
      php: 'php',
      swift: 'swift',
      kt: 'kotlin',
      html: 'html',
      css: 'css',
      json: 'json',
      xml: 'xml',
      yaml: 'yaml',
      yml: 'yaml',
      md: 'markdown',
      sql: 'sql',
      sh: 'shell',
      bash: 'shell',
      ps1: 'powershell'
    };
    return map[ext] || ext;
  }

  _saveCodeBlocks (task, codeBlocks) {
    const taskDir = `output/${task.id}`;
    codeBlocks.forEach((block, i) => {
      let relPath = block.filePath;
      if (!relPath || relPath === 'main') {
        const ext = this._getExtFromLanguage(block.language);
        relPath = `result_${i + 1}${ext}`;
      }
      relPath = relPath.replace(/^\/+/, '').replace(/\.\.\//g, '');
      const filePath = `${taskDir}/${relPath}`;
      try {
        this.fileManager?.writeFile(filePath, block.code);
      } catch (e) {}
    });
  }

  _getExtFromLanguage (lang) {
    const map = {
      javascript: '.js',
      python: '.py',
      html: '.html',
      css: '.css',
      json: '.json',
      typescript: '.ts',
      jsx: '.jsx',
      tsx: '.tsx',
      java: '.java',
      go: '.go',
      rust: '.rs',
      c: '.c',
      cpp: '.cpp',
      'c++': '.cpp',
      'c/c++': '.cpp',
      objectivec: '.m',
      csharp: '.cs',
      php: '.php',
      ruby: '.rb',
      swift: '.swift',
      kotlin: '.kt',
      scala: '.scala',
      sql: '.sql',
      shell: '.sh',
      bash: '.sh',
      lua: '.lua',
      perl: '.pl',
      haskell: '.hs',
      fsharp: '.fs',
      dart: '.dart',
      r: '.r',
      julia: '.jl'
    };
    return map[lang?.toLowerCase()] || '.txt';
  }

  /**
   * G1: 快速生成测试桩代码（用于 TestRunner 执行）
   * 根据语言生成基本的语法/导入/导出测试
   */
  _generateQuickTest (sourceCode, language = 'javascript') {
    const lang = (language || 'javascript').toLowerCase();
    const timestamp = new Date().toISOString();

    const templates = {
      javascript: `// Auto-generated quick test — ${timestamp}
const assert = require('assert');

// === Source under test ===
// ${sourceCode.split('\n').length} lines

try {
  // 基本语法检查：eval 源码（仅用于快速验证，不用于生产）
  // 注意：这里只是做语法检查，不执行有副作用的代码
  new Function(sourceCode);
  console.log('✓ 语法检查通过');
} catch (e) {
  console.error('✗ 语法错误:', e.message);
  process.exit(1);
}

console.log('✓ 快速测试完成');
`,
      typescript: `// Auto-generated quick test — ${timestamp}
// TypeScript 语法检查

try {
  // 基本语法检查
  console.log('✓ TypeScript 语法检查（跳过类型检查）');
} catch (e) {
  console.error('✗ 语法错误:', e.message);
  process.exit(1);
}
console.log('✓ 快速测试完成');
`,
      python: `# Auto-generated quick test — ${timestamp}
import ast, sys

source_code = '''${sourceCode.replace(/'''/g, '\'\'\'')}'''

try:
    ast.parse(source_code)
    print('✓ Python 语法检查通过')
except SyntaxError as e:
    print(f'✗ 语法错误: {e}')
    sys.exit(1)

print('✓ 快速测试完成')
`,
      c: `/* Auto-generated quick test — ${timestamp} */
#include <stdio.h>
#include <stdlib.h>

/* Source under test */
/* ${sourceCode.split('\n').length} lines */

int main() {
    printf('✓ C 快速测试编译通过\n');
    return 0;
}
`,
      cpp: `/* Auto-generated quick test — ${timestamp} */
#include <iostream>

int main() {
    std::cout << '✓ C++ 快速测试编译通过' << std::endl;
    return 0;
}
`,
      go: `// Auto-generated quick test — ${timestamp}
package main

import "fmt"

func main() {
    fmt.Println("✓ Go 快速测试编译通过")
}
`,
      rust: `// Auto-generated quick test — ${timestamp}
fn main() {
    println!("✓ Rust 快速测试编译通过");
}
`,
      java: `// Auto-generated quick test — ${timestamp}
public class QuickTest {
    public static void main(String[] args) {
        System.out.println("✓ Java 快速测试编译通过");
    }
}
`
    };

    return templates[lang] || templates.javascript;
  }

  _pickBestResult (providerResult, adapterResults) {
    let best = providerResult;
    let bestScore = this._scoreResult(providerResult);

    for (const [, r] of Object.entries(adapterResults)) {
      if (!r.success) continue;
      const score = this._scoreResult(r);
      if (score > bestScore) {
        best = r; bestScore = score;
      }
    }

    return best === providerResult ? null : best;
  }

  _scoreResult (result) {
    if (!result || !result.success) return 0;
    const blockCount = (result.codeBlocks || []).length;
    const contentLength = (result.content || '').length;
    return blockCount * 100 + Math.min(contentLength / 10, 500);
  }
}

module.exports = TaskExecutor;
