const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const AgentFactory = require('../agents');
const ToolScanner = require('./ToolScanner');
const ToolExecutor = require('./ToolExecutor');
const ProviderFactory = require('../providers');
const MergeEngine = require('../agents/MergeEngine');
const ExecutionModeManager = require('./ExecutionModeManager');
const ConfirmPrompt = require('../utils/ConfirmPrompt');
const { safeJsonParse } = require('../utils/SafeParser');
const logger = require('../utils/Logger')('RealTaskExecutor');
const adapters = require('../adapters');

class RealTaskExecutor extends EventEmitter {
  constructor (options = {}) {
    super();
    this.options = options;
    this.provider = options.provider;
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.maxConcurrent = options.maxConcurrent || 3;
    this.timeout = options.timeout || 600000;
    this.selectedTools = options.selectedTools || [];

    // 执行模式
    this.modeManager = new ExecutionModeManager();
    if (options.executionMode) {
      this.modeManager.setMode(options.executionMode);
    }
    this.currentMode = this.modeManager.getCurrentMode();
    const modeConfig = this.modeManager.getModeConfig();

    // 新增：工具执行器
    this.toolExecutor = new ToolExecutor({
      workspaceDir: this.workspaceDir,
      maxConcurrent: this.maxConcurrent,
      defaultTimeout: this.timeout
    });

    // 设置正在使用的工具（排除这些工具）
    if (options.inUseTools) {
      this.toolExecutor.setInUseTools(options.inUseTools);
    }

    this.agents = AgentFactory.createAll(options.provider, {
      splitter: {
        enableSelfCheck: modeConfig.splitter.enableSelfCheck,
        maxSubtasks: modeConfig.splitter.maxSubtasks
      },
      qualityChecker: {
        enableStaticCheck: modeConfig.qualityCheck.enableStaticCheck,
        enableCompilation: modeConfig.qualityCheck.enableCompilation,
        enableLint: modeConfig.qualityCheck.enableLint,
        enableTest: modeConfig.qualityCheck.enableTest,
        minQualityScore: modeConfig.qualityCheck.minQualityScore,
        enableAI: modeConfig.qualityCheck.enableAI
      }
    });

    this.connectedTools = [];
    this.enabledProviders = [];
    this.executionHistory = [];
    this.toolAdapters = new Map(); // 工具名 -> 适配器
    this.prompt = new ConfirmPrompt({
      silent: options.silentExecution || false,
      autoConfirm: options.autoConfirm || false
    });
  }

  /**
   * 执行前确认
   */
  async confirmBeforeExecution (taskInfo) {
    const { task, mode, tools } = taskInfo;

    console.log('\n' + '='.repeat(60));
    console.log('  📋 任务执行确认');
    console.log('='.repeat(60));
    console.log(`  📝 任务: ${task.substring(0, 80)}${task.length > 80 ? '...' : ''}`);
    console.log(`  🔧 模式: ${mode === 'privacy' ? '🔒 隐私模式' : '✨ 高质量模式'}`);

    if (tools && tools.length > 0) {
      console.log(`  🤖 将使用的工具 (${tools.length}):`);
      for (const tool of tools) {
        console.log(`     • ${tool.displayName || tool.name}`);
      }
    } else {
      console.log('  🤖 工具: 未启用，将仅使用 LLM Provider');
    }

    console.log('='.repeat(60));

    const confirmed = await this.prompt.confirm('确认执行此任务？', true);

    if (!confirmed) {
      console.log('  ❌ 用户取消执行');
      return false;
    }

    return true;
  }

  async initialize () {
    this.emit('init', { provider: this.provider?.name });

    await this._loadProviders();
    await this._scanTools();

    if (this.enabledProviders.length > 0) {
      this.provider = this.enabledProviders[0].provider;
      const modeConfig = this.modeManager.getModeConfig();
      this.agents = AgentFactory.createAll(this.provider, {
        splitter: {
          enableSelfCheck: modeConfig.splitter.enableSelfCheck,
          maxSubtasks: modeConfig.splitter.maxSubtasks
        },
        qualityChecker: {
          enableStaticCheck: modeConfig.qualityCheck.enableStaticCheck,
          enableCompilation: modeConfig.qualityCheck.enableCompilation,
          enableLint: modeConfig.qualityCheck.enableLint,
          enableTest: modeConfig.qualityCheck.enableTest,
          minQualityScore: modeConfig.qualityCheck.minQualityScore,
          enableAI: modeConfig.qualityCheck.enableAI
        }
      });
      logger.info(`已更新 provider 和 agents，使用: ${this.enabledProviders[0].name}`);
    }

    return {
      providers: this.enabledProviders.length,
      tools: this.connectedTools.length
    };
  }

  async _loadProviders () {
    if (this.provider) {
      this.enabledProviders.push({
        name: this.provider.name || 'webui-agent',
        provider: this.provider,
        config: {}
      });
      this.emit('providerConnected', { name: this.provider.name || 'webui-agent' });
      return;
    }

    const configPath = path.join(__dirname, '../../config/agents.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = safeJsonParse(fs.readFileSync(configPath, 'utf-8'), {});
        if (config.agents) {
          for (const [key, agentConfig] of Object.entries(config.agents)) {
            if (agentConfig.enabled) {
              try {
                const provider = ProviderFactory.create(agentConfig.provider, agentConfig.config);
                const connected = await provider.checkConnection().catch(() => false);
                if (connected) {
                  this.enabledProviders.push({
                    name: key,
                    provider,
                    config: agentConfig
                  });
                  this.emit('providerConnected', { name: key });
                } else {
                  this.emit('providerFailed', { name: key, reason: '连接失败' });
                }
              } catch (e) {
                this.emit('providerFailed', { name: key, reason: e.message });
              }
            }
          }
        }
      } catch (e) {
        logger.error('加载配置失败:', e.message);
      }
    }
  }

  async _scanTools () {
    // 如果外部传入了已扫描授权的 toolScanner，直接复用，避免二次扫描+授权
    if (this.options.toolScanner) {
      const registered = this.options.toolScanner.getRegisteredTools();
      if (registered && registered.length > 0) {
        // 如果用户指定了选中的工具，则只使用这些工具
        let filteredTools = registered;
        if (this.selectedTools.length > 0) {
          filteredTools = registered.filter(t => this.selectedTools.includes(t.name));
          logger.info(`[任务启动] 用户选中工具: ${this.selectedTools.join(', ')}, 可用: ${filteredTools.length} 个`);
        }

        this.connectedTools = filteredTools.map(t => ({ name: t.name, ...t }));
        for (const tool of this.connectedTools) {
          const adapter = this.options.toolScanner.getTool(tool.name);
          if (adapter) {
            this.toolExecutor.registerAdapter(adapter);
            this.toolAdapters.set(tool.name, adapter);
          }
          this.emit('toolConnected', { name: tool.name });
        }
        logger.info(`复用 WebUI 已授权工具: ${this.connectedTools.map(t => t.name).join(', ')}`);
        return;
      }
    }

    try {
      const scanner = new ToolScanner({
        silentScan: this.options.silentScan,
        autoConfirm: this.options.autoConfirm
      });
      scanner.registerAdapters(adapters.createAll());
      const scanResult = await scanner.scan();

      // 自动连接所有启用的工具
      for (const tool of scanResult.enabled) {
        try {
          await scanner.connect(tool.name);
        } catch (e) {
          logger.warn(`连接工具 ${tool.name} 失败: ${e.message}`);
        }
      }

      // 只连接用户确认启用的工具
      this.connectedTools = scanResult.enabled || [];

      // 注册工具适配器到 toolExecutor
      for (const tool of this.connectedTools) {
        const adapter = tool.adapter || this._createAdapter(tool.name);
        if (adapter) {
          this.toolExecutor.registerAdapter(adapter);
          this.toolAdapters.set(tool.name, adapter);
        }
        this.emit('toolConnected', { name: tool.name });
      }

      if (this.connectedTools.length === 0 && scanResult.tools?.length > 0) {
        logger.info('用户未启用任何工具，将仅使用 LLM Provider 执行');
      }
    } catch (e) {
      logger.error('扫描工具失败:', e.message);
    }
  }

  /**
   * 根据工具名称创建适配器
   */
  _createAdapter (toolName) {
    const adapterMap = {
      'claude-code': 'ClaudeCodeAdapter',
      'open-code': 'OpenCodeAdapter',
      openclaw: 'OpenClawAdapter',
      qoder: 'QoderAdapter',
      'hermes-agent': 'HermesAgentAdapter',
      'atom-code': 'AtomCodeAdapter',
      'mimo-code': 'MimoCodeAdapter',
      trae: 'TraeAdapter'
    };

    try {
      const AdapterClass = require(`../adapters/${adapterMap[toolName]}`);
      return new AdapterClass({ workspaceDir: this.workspaceDir });
    } catch (e) {
      return null;
    }
  }

  async executeTask (taskDescription, options = {}) {
    const taskId = options.taskId || `task_${Date.now()}`;
    const startTime = Date.now();

    this.emit('taskStart', { taskId, task: taskDescription });

    try {
      await this.initialize();

      const splitResult = await this._splitTask(taskDescription);

      this.emit('taskSplit', {
        taskId,
        subtasks: splitResult.subtasks.length,
        constraints: splitResult.constraints
      });

      const executionResults = await this._executeSubtasks(splitResult.subtasks, splitResult.constraints);

      const qualityResults = await this._checkQuality(executionResults, splitResult.constraints);

      const finalSummary = await this._generateSummary(taskDescription, splitResult, executionResults, qualityResults);

      const report = await this._generateReport(taskId, startTime, splitResult, executionResults, qualityResults, finalSummary);

      this.emit('taskComplete', {
        taskId,
        success: finalSummary.success,
        summary: finalSummary,
        report
      });

      return {
        success: true,
        taskId,
        splitResult,
        executionResults,
        qualityResults,
        finalSummary,
        report,
        duration: Date.now() - startTime
      };
    } catch (e) {
      this.emit('taskError', { taskId, error: e.message });
      throw e;
    }
  }

  async _splitTask (taskDescription) {
    this.emit('splitting', { task: taskDescription });

    const splitter = this.agents.splitter;
    const result = await splitter.splitTask(taskDescription, {});

    return result;
  }

  async _executeSubtasks (subtasks, constraints) {
    const results = [];

    for (const subtask of subtasks) {
      if (subtask.role === 'quality_checker') continue;

      this.emit('subtaskStart', { task: subtask });

      const result = await this._executeSingleSubtask(subtask, constraints);
      results.push({ subtask, ...result });

      this.emit('subtaskComplete', { task: subtask, success: result.success });
    }

    return results;
  }

  async _executeSingleSubtask (subtask, constraints) {
    const startTime = Date.now();

    // 1. 检查是否有可用的工具
    const availableTools = this.toolExecutor.getAvailableTools();
    const hasTools = availableTools.length > 0;

    // 2. 检查是否有可用的 AI 提供商
    const hasProvider = this.enabledProviders.length > 0;

    if (!hasTools && !hasProvider) {
      return {
        success: false,
        error: '没有可用的 AI 工具或模型',
        duration: Date.now() - startTime,
        provider: null,
        tool: null,
        output: null,
        generatedFiles: []
      };
    }

    // 3. 多工具执行：根据当前模式选择策略
    if (hasTools) {
      const mode = this.currentMode || 'public';
      if (mode === 'public' && availableTools.length > 1) {
        // ── 公开模式：并行多工具分发 ──
        return await this._executeParallelTools(subtask, availableTools, startTime);
      } else {
        // ── 隐私/单工具模式：串行尝试 ──
        return await this._executeSerialTools(subtask, availableTools, startTime);
      }
    }

    // 4. 降级：使用 AI 提供商
    if (hasProvider) {
      const primaryProvider = this._selectBestProvider(subtask);

      if (primaryProvider) {
        this.emit('providerSelected', { subtask: subtask.title, provider: primaryProvider.name });

        try {
          const result = await this._runWithProvider(primaryProvider, subtask, constraints);

          return {
            success: true,
            duration: Date.now() - startTime,
            provider: primaryProvider.name,
            tool: null,
            output: result,
            generatedFiles: this._extractGeneratedFiles(result, constraints),
            stdout: result.content || '',
            stderr: ''
          };
        } catch (e) {
          return {
            success: false,
            error: e.message,
            duration: Date.now() - startTime,
            provider: primaryProvider.name,
            tool: null,
            output: null,
            generatedFiles: []
          };
        }
      }
    }

    return {
      success: false,
      error: '没有可用的执行方式',
      duration: Date.now() - startTime,
      provider: null,
      tool: null,
      output: null,
      generatedFiles: []
    };
  }

  // ── 并行多工具执行（公开模式）──
  async _executeParallelTools (subtask, tools, startTime) {
    this.emit('parallelToolExecution', { subtask: subtask.title, tools, timeout: 120000 });

    const promises = tools.map(async (toolName) => {
      this.emit('providerSelected', { subtask: subtask.title, tool: toolName });
      try {
        return {
          toolName,
          result: await this.toolExecutor.executeTask(subtask, {
            preferredTools: [toolName],
            timeout: 120000,
            workspace: this.workspaceDir
          })
        };
      } catch (e) {
        return { toolName, result: { success: false, error: e.message } };
      }
    });

    const rawResults = await Promise.allSettled(promises);

    // 收集所有成功结果
    const successful = [];
    for (const r of rawResults) {
      if (r.status === 'fulfilled') {
        const { toolName, result } = r.value;
        if (result.success && result.generatedFiles?.length > 0) {
          successful.push({ toolName, result });
        } else {
          this.emit('toolExecutionError', { tool: toolName, error: result.error || '工具执行成功但未生成代码文件' });
        }
      }
    }

    if (successful.length === 0) {
      // 全失败 → 降级到串行模式
      this.emit('parallelToolExecution', { subtask: subtask.title, status: 'all_failed_degrading' });
      return await this._executeSerialTools(subtask, tools, startTime);
    }

    // 仅一个工具成功 → 直接返回
    if (successful.length === 1) {
      const { toolName, result } = successful[0];
      return {
        success: true,
        duration: Date.now() - startTime,
        tool: toolName,
        provider: null,
        output: result,
        generatedFiles: result.generatedFiles || [],
        stdout: result.output || '',
        stderr: result.error || '',
        parallelMode: false
      };
    }

    // 多个工具成功 → 使用 MergeEngine 合并最优输出
    this.emit('parallelToolExecution', { subtask: subtask.title, status: 'merging', count: successful.length });
    const mergeEngine = new MergeEngine(this.provider, { conflictResolution: 'auto' });
    const resultsForMerge = {};
    for (const { toolName, result } of successful) {
      const outputCode = (result.output || result.codeBlocks?.map(b => b.code).join('\n\n') || '');
      resultsForMerge[toolName] = { success: true, output: outputCode, codeBlocks: result.codeBlocks || [], files: result.generatedFiles || [] };
    }
    const mergeResult = await mergeEngine.merge(resultsForMerge, { task: subtask });
    this.emit('mergeComplete', { subtask: subtask.title, files: Object.keys(mergeResult.mergedFiles || {}).length });

    return {
      success: true,
      duration: Date.now() - startTime,
      merged: true,
      tool: successful.map(s => s.toolName).join('+'),
      provider: null,
      output: mergeResult,
      generatedFiles: Object.keys(mergeResult.mergedFiles || {}),
      stdout: mergeResult.mergedCode || '',
      stderr: '',
      parallelMode: true,
      toolResults: successful
    };
  }

  // ── 串行单工具执行（隐私/降级模式）──
  async _executeSerialTools (subtask, tools, startTime) {
    for (const toolName of tools) {
      this.emit('providerSelected', { subtask: subtask.title, tool: toolName });

      try {
        const toolResult = await this.toolExecutor.executeTask(subtask, {
          preferredTools: [toolName],
          timeout: 30000,
          workspace: this.workspaceDir
        });

        if (toolResult.success) {
          const genFiles = toolResult.generatedFiles || [];
          if (genFiles.length > 0) {
            return {
              success: toolResult.success,
              duration: Date.now() - startTime,
              tool: toolName,
              provider: null,
              output: toolResult,
              generatedFiles: genFiles,
              stdout: toolResult.output || '',
              stderr: toolResult.error || ''
            };
          } else {
            this.emit('toolExecutionError', { tool: toolName, error: '工具执行成功但未生成代码文件，跳过其他工具直接降级到AI' });
            break;
          }
        } else {
          this.emit('toolExecutionError', { tool: toolName, error: toolResult.error || '工具执行失败' });
        }
      } catch (e) {
        this.emit('toolExecutionError', { tool: toolName, error: e.message });
      }
    }
    return { success: false, error: '所有工具执行失败', duration: Date.now() - startTime, tool: null, provider: null, output: null, generatedFiles: [] };
  }

  /**
   * 选择最佳 AI 提供商
   */
  _selectBestProvider (subtask) {
    const complexity = subtask.estimatedComplexity || 'medium';

    if (complexity === 'high' && this.enabledProviders.length > 1) {
      // 复杂任务使用更强的模型
      return this.enabledProviders.find(p => !p.name.includes('small')) || this.enabledProviders[0];
    }

    return this.enabledProviders[0];
  }

  async _runWithProvider (providerInfo, subtask, constraints) {
    const provider = providerInfo.provider;

    const prompt = this._buildExecutionPrompt(subtask, constraints);

    const result = await provider.generate(prompt, {
      maxTokens: 4096,
      temperature: 0.7,
      systemPrompt: this._getSystemPrompt(subtask.role)
    });

    return result;
  }

  _buildExecutionPrompt (subtask, constraints) {
    let prompt = `${subtask.title}\n\n`;
    prompt += `${subtask.description}\n\n`;

    if (subtask.acceptanceCriteria) {
      prompt += `验收标准：\n${subtask.acceptanceCriteria}\n\n`;
    }

    if (constraints) {
      prompt += '约束条件：\n';
      prompt += `语言：${constraints.language || '未指定'}\n`;
      prompt += `技术栈：${constraints.techStack || '未指定'}\n`;
      prompt += `平台：${constraints.platform || '未指定'}\n`;
    }

    prompt += '\n请直接输出代码，不要有多余解释。使用```language\ncode```格式包裹代码。';

    return prompt;
  }

  _getSystemPrompt (role) {
    const prompts = {
      code_writer: '你是一位资深编程专家，擅长编写高质量的代码。请直接输出代码，不要解释。',
      architect: '你是一位资深架构师，擅长设计系统架构和数据结构。',
      code_reviewer: '你是一位资深代码审查专家，擅长发现代码中的问题。',
      tester: '你是一位资深测试工程师，擅长设计测试用例。',
      quality_checker: '你是一位资深质量保障负责人，负责审核代码质量。'
    };
    return prompts[role] || prompts.code_writer;
  }

  _extractGeneratedFiles (result, constraints) {
    const files = [];
    const content = (result.content || '').replace(/\r\n/g, '\n');

    const codeBlocks = content.match(/```(\w+)?\s*\n([\s\S]*?)\n```/g) || [];

    for (let i = 0; i < codeBlocks.length; i++) {
      const match = codeBlocks[i].match(/```(\w+)?\s*\n([\s\S]*?)\n```/);
      if (match) {
        const language = match[1] || constraints?.language || 'text';
        const code = match[2].trim();

        const ext = this._getExtension(language);
        const fileName = `output_${Date.now()}_${i + 1}${ext}`;
        const filePath = path.join(this.workspaceDir, fileName);

        try {
          fs.writeFileSync(filePath, code, 'utf-8');
          files.push({
            name: fileName,
            path: filePath,
            language,
            size: code.length
          });
        } catch (e) {
          logger.error('写入文件失败:', e.message);
        }
      }
    }

    return files;
  }

  _getExtension (language) {
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
      csharp: '.cs',
      php: '.php',
      ruby: '.rb',
      swift: '.swift',
      kotlin: '.kt',
      sql: '.sql',
      shell: '.sh',
      bash: '.sh',
      lua: '.lua',
      perl: '.pl',
      haskell: '.hs',
      dart: '.dart',
      r: '.r'
    };
    return map[language?.toLowerCase()] || '.txt';
  }

  async _checkQuality (executionResults, constraints) {
    const qualityResults = [];

    for (const result of executionResults) {
      if (!result.success || !result.output) continue;

      const output = result.output;
      let contentToCheck = '';

      if (output.codeBlocks && output.codeBlocks.length > 0) {
        contentToCheck = output.codeBlocks.map(cb => `\`\`\`${cb.language}\n${cb.code}\n\`\`\``).join('\n');
      } else if (output.content) {
        contentToCheck = output.content;
      } else if (typeof output === 'string') {
        contentToCheck = output;
      } else if (output.output) {
        contentToCheck = output.output;
      } else if (output.rawOutput) {
        contentToCheck = output.rawOutput;
      }

      if (!contentToCheck) continue;

      const qualityChecker = this.agents.qualityChecker;
      const qualityResult = await qualityChecker.checkQuality(
        result.subtask,
        contentToCheck,
        { constraints }
      );

      qualityResults.push({
        subtaskId: result.subtask.id,
        qualityResult,
        passed: qualityResult.status === 'completed'
      });
    }

    return qualityResults;
  }

  async _generateSummary (taskDescription, splitResult, executionResults, qualityResults) {
    const completed = executionResults.filter(r => r.success).length;
    const failed = executionResults.filter(r => !r.success).length;
    const total = executionResults.length;

    const passedQuality = qualityResults.filter(q => q.passed).length;

    const summary = {
      originalTask: taskDescription,
      success: failed === 0 && passedQuality === qualityResults.length,
      totalSubtasks: total,
      completedSubtasks: completed,
      failedSubtasks: failed,
      qualityPassed: passedQuality,
      qualityFailed: qualityResults.length - passedQuality,
      constraints: splitResult.constraints,
      subtasks: executionResults.map(r => ({
        id: r.subtask.id,
        title: r.subtask.title,
        status: r.success ? 'completed' : 'failed',
        provider: r.provider,
        duration: r.duration,
        generatedFiles: r.generatedFiles?.length || 0,
        qualityScore: qualityResults.find(q => q.subtaskId === r.subtask.id)?.qualityResult?.qualityScore || null
      }))
    };

    return summary;
  }

  async _generateReport (taskId, startTime, splitResult, executionResults, qualityResults, summary) {
    const report = {
      id: taskId,
      timestamp: new Date().toISOString(),
      duration: Date.now() - startTime,
      originalTask: summary.originalTask,
      success: summary.success,
      constraints: summary.constraints,
      subtasks: summary.subtasks,
      providers: this.enabledProviders.map(p => p.name),
      tools: this.connectedTools.map(t => t.name),
      qualityMetrics: {
        totalChecked: qualityResults.length,
        passed: qualityResults.filter(q => q.passed).length,
        averageScore: qualityResults.length > 0
          ? Math.round(qualityResults.reduce((sum, q) => sum + (q.qualityResult.qualityScore || 0), 0) / qualityResults.length)
          : 0
      }
    };

    const reportDir = path.join(__dirname, '../../reports');
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

    const reportPath = path.join(reportDir, `${taskId}_report.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    return { id: taskId, path: reportPath, content: report };
  }

  async executeWithMultipleProviders (taskDescription, options = {}) {
    const mode = options.mode || 'parallel';
    const selectedProviders = options.providers || this.enabledProviders.map(p => p.name);

    const providersToUse = this.enabledProviders.filter(p => selectedProviders.includes(p.name));

    if (providersToUse.length === 0) {
      throw new Error('没有可用的提供商');
    }

    this.emit('multiProviderStart', {
      mode,
      providers: providersToUse.length,
      task: taskDescription
    });

    const results = [];

    if (mode === 'parallel') {
      const promises = providersToUse.map(p =>
        this._executeWithSingleProvider(p, taskDescription)
      );
      const allResults = await Promise.allSettled(promises);

      for (let i = 0; i < allResults.length; i++) {
        if (allResults[i].status === 'fulfilled') {
          results.push({
            provider: providersToUse[i].name,
            success: true,
            ...allResults[i].value
          });
        } else {
          results.push({
            provider: providersToUse[i].name,
            success: false,
            error: allResults[i].reason?.message
          });
        }
      }
    } else if (mode === 'sequential') {
      for (const provider of providersToUse) {
        try {
          const result = await this._executeWithSingleProvider(provider, taskDescription);
          results.push({ provider: provider.name, success: true, ...result });
          if (result.success && options.stopOnSuccess) break;
        } catch (e) {
          results.push({ provider: provider.name, success: false, error: e.message });
        }
      }
    } else if (mode === 'select') {
      const promises = providersToUse.map(p =>
        this._executeWithSingleProvider(p, taskDescription)
      );
      const allResults = await Promise.allSettled(promises);

      let bestResult = null;
      let bestScore = -1;

      for (let i = 0; i < allResults.length; i++) {
        if (allResults[i].status === 'fulfilled') {
          const result = allResults[i].value;
          const score = await this._evaluateResult(result.output?.content || '', taskDescription);
          results.push({ provider: providersToUse[i].name, success: true, ...result, score });

          if (score > bestScore) {
            bestScore = score;
            bestResult = { provider: providersToUse[i].name, ...result };
          }
        }
      }

      this.emit('bestResult', { provider: bestResult?.provider, score: bestScore });
      return { results, bestResult, bestScore };
    }

    return { results };
  }

  async _executeWithSingleProvider (providerInfo, taskDescription) {
    const startTime = Date.now();

    const prompt = `请完成以下编程任务：\n\n${taskDescription}\n\n请直接输出代码，使用\`\`\`language\ncode\`\`\`格式。`;

    const result = await providerInfo.provider.generate(prompt, {
      maxTokens: 4096,
      temperature: 0.7
    });

    const files = this._extractGeneratedFiles(result, {});

    return {
      output: result,
      generatedFiles: files,
      duration: Date.now() - startTime
    };
  }

  async _evaluateResult (content, taskDescription) {
    try {
      const evaluator = this.agents.qualityChecker;
      const result = await evaluator.checkQuality(
        { title: '评估任务', description: taskDescription },
        content,
        {}
      );
      return result.qualityScore || 50;
    } catch (e) {
      return 50;
    }
  }

  getStatus () {
    return {
      providers: this.enabledProviders.map(p => ({
        name: p.name,
        status: 'connected',
        config: p.config
      })),
      tools: this.toolExecutor.getRegisteredTools().map(name => {
        const status = this.toolExecutor.getToolStatus()[name];
        return {
          name,
          ...status
        };
      }),
      toolExecutor: {
        availableTools: this.toolExecutor.getAvailableTools(),
        registeredTools: this.toolExecutor.getRegisteredTools(),
        status: this.toolExecutor.getToolStatus()
      },
      executionCount: this.executionHistory.length
    };
  }
}

module.exports = RealTaskExecutor;
