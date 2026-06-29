const MergeEngine = require('../agents/MergeEngine');

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
  }

  /**
   * 执行单个任务（完整流程：缓存 → 上下文 → 路由 → 执行 → 质检 → 缓存保存）。
   */
  async executeSingleTask (task, context) {
    const agentName = this._getAgentName(task.role);

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
    let result;
    switch (task.role) {
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
    this.tokenCounter?.record(
      agentName, task.id, promptForLogging,
      result.content || JSON.stringify(result),
      { model: useSmallModel ? 'small' : 'large' }
    );

    // 6. 质量检查
    const qualityResult = await this._checkQuality(task, result, taskContext);

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

    if (this.multiProviderMode && this.providers.length > 1) {
      return await this._executeMultiProviderMode(task, enhancedContext, useSmallModel);
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
    const finalResult = await this._mergeToolOutputs(task, providerResult || {}, adapterResults, enhancedContext);

    if (finalResult.codeBlocks && finalResult.codeBlocks.length > 0) {
      this._saveCodeBlocks(task, finalResult.codeBlocks);
    }

    return finalResult;
  }

  async _executeMultiProviderMode (task, context, useSmallModel = false) {
    context.orchestrator?.emit('multiProviderStart', {
      task,
      providers: this.providers.map(p => p.name || p.constructor.name),
      count: this.providers.length
    });

    const AgentFactory = require('../agents');
    const allResults = {};
    const promises = this.providers.map(async (provider, index) => {
      const providerName = provider.name || `provider_${index + 1}`;

      try {
        const agents = AgentFactory.createAll(provider);
        const result = await agents.codeWriter?.writeCode(task, context, { useSmallModel });

        allResults[providerName] = {
          success: true,
          result: { codeBlocks: result?.codeBlocks || [], content: result?.content || '' },
          content: result?.content || '',
          providerName,
          model: result?.model || 'unknown'
        };

        context.orchestrator?.emit('multiProviderResult', {
          task,
          provider: providerName,
          hasCodeBlocks: (result?.codeBlocks?.length || 0) > 0
        });
      } catch (error) {
        allResults[providerName] = {
          success: false,
          error: error.message,
          providerName
        };
        context.orchestrator?.emit('multiProviderError', { task, provider: providerName, error: error.message });
      }
    });

    await Promise.all(promises);

    const validResults = Object.keys(allResults).filter(name => allResults[name].success);

    if (validResults.length === 0) {
      context.orchestrator?.emit('multiProviderFailed', { task, error: '所有Provider都执行失败' });
      return { content: '', codeBlocks: [], multiProviderFailed: true };
    }

    if (validResults.length === 1) {
      const singleResult = allResults[validResults[0]];
      return {
        ...singleResult.result,
        content: singleResult.content,
        source: 'multi_provider_single',
        providerName: validResults[0],
        _providerCount: 1
      };
    }

    const mergeResult = await this._mergeMultiProviderOutputs(task, allResults, context);

    if (mergeResult.codeBlocks && mergeResult.codeBlocks.length > 0) {
      this._saveCodeBlocks(task, mergeResult.codeBlocks);
    }

    return {
      ...mergeResult,
      source: 'multi_provider_merged',
      _providerCount: validResults.length,
      _providers: validResults
    };
  }

  async _mergeMultiProviderOutputs (task, providerResults, context) {
    const validResults = {};
    for (const [name, result] of Object.entries(providerResults)) {
      if (result.success) {
        validResults[name] = result;
      }
    }

    try {
      const MergeEngine = require('../agents/MergeEngine');
      const mergeEngine = new MergeEngine(this.agents.codeWriter?.provider || null, {
        conflictResolution: 'ai_decides',
        enableThreeWayMerge: Object.keys(validResults).length >= 3
      });

      const mergeResult = await mergeEngine.merge(validResults, context.constraints || {});

      if (mergeResult.mergedCode) {
        const mergedCodeBlocks = Object.entries(mergeResult.mergedFiles || {}).map(([filePath, code]) => ({
          filePath,
          language: this._getLangFromFilePath(filePath),
          code
        }));

        const finalResult = {
          content: mergeResult.mergedCode,
          codeBlocks: mergedCodeBlocks.length > 0 ? mergedCodeBlocks : [],
          mergeQuality: mergeResult.qualityAssessment,
          mergeReport: mergeResult,
          mergeConflicts: mergeResult.conflicts?.length || 0,
          _providerCount: Object.keys(validResults).length
        };

        context.orchestrator?.emit('multiProviderMerged', {
          task,
          providers: Object.keys(validResults),
          conflicts: mergeResult.conflicts?.length || 0,
          quality: mergeResult.qualityAssessment
        });

        return finalResult;
      }
    } catch (mergeError) {
      context.orchestrator?.emit('multiProviderMergeFailed', { task, error: mergeError.message });
    }

    return this._pickBestResultFromProviders(validResults);
  }

  _pickBestResultFromProviders (providerResults) {
    let bestName = null;
    let bestScore = 0;
    let bestResult = null;

    for (const [name, result] of Object.entries(providerResults)) {
      if (!result.success) continue;

      const blockCount = (result.result?.codeBlocks?.length || 0);
      const contentLength = (result.content?.length || 0);
      const score = blockCount * 100 + Math.min(contentLength / 10, 500);

      if (score > bestScore) {
        bestScore = score;
        bestName = name;
        bestResult = result;
      }
    }

    return {
      ...bestResult.result,
      content: bestResult.content,
      source: 'multi_provider_fallback',
      providerName: bestName
    };
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

    const toolTaskDesc = this._buildPrivacyTaskDescription(task, context);

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

    if (toolResult.metadata) finalResult.metadata = toolResult.metadata;

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
    const results = {};
    const onlineAdapters = this.toolAdapters.filter(a => a.isAvailable && a.isAvailable());

    if (onlineAdapters.length === 0) return results;

    context.orchestrator?.emit('multiToolDispatch', {
      task, tools: onlineAdapters.map(a => ({ name: a.name, displayName: a.displayName }))
    });

    const taskDesc = this._buildToolTaskDescription(task, context);
    const promises = onlineAdapters.map(async (adapter) => {
      const startTime = Date.now();
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
      const mergeEngine = new MergeEngine(null, { conflictResolution: 'auto' });
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

    let desc = `## 任务：${task.title}\n${task.description || ''}\n\n### 任务类型\n${task.role || 'code_writer'}\n### 语言要求\n${task.language || '未指定'}\n### 框架要求\n${task.frameworks ? task.frameworks.join(', ') : '无'}\n### 验收标准\n${criteriaStr}`;

    if (context.constraints) {
      const essentialConstraints = {};
      if (context.constraints.language) essentialConstraints.language = context.constraints.language;
      if (context.constraints.encoding) essentialConstraints.encoding = context.constraints.encoding;
      if (context.constraints.platform) essentialConstraints.platform = context.constraints.platform;
      if (Object.keys(essentialConstraints).length > 0) {
        desc += `\n\n### 必要约束\n${JSON.stringify(essentialConstraints, null, 2)}`;
      }
    }

    if (task.lastQualityFeedback) {
      desc += `\n\n### ⚠️ 上次质检反馈\n${task.lastQualityFeedback}\n上次评分: ${task.lastQualityScore || '?'}分`;
    }

    return desc;
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
