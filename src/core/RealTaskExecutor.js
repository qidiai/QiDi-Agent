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
const logger = require('../utils/Logger')('RealTaskExecutor');

class RealTaskExecutor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.provider = options.provider;
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.maxConcurrent = options.maxConcurrent || 3;
    this.timeout = options.timeout || 600000;
    
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
  async confirmBeforeExecution(taskInfo) {
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
      console.log(`  🤖 工具: 未启用，将仅使用 LLM Provider`);
    }
    
    console.log('='.repeat(60));
    
    const confirmed = await this.prompt.confirm('确认执行此任务？', true);
    
    if (!confirmed) {
      console.log('  ❌ 用户取消执行');
      return false;
    }
    
    return true;
  }

  async initialize() {
    this.emit('init', { provider: this.provider?.name });
    
    await this._loadProviders();
    await this._scanTools();
    
    return {
      providers: this.enabledProviders.length,
      tools: this.connectedTools.length
    };
  }

  async _loadProviders() {
    // 优先使用外部传入的 provider（来自 AgentHub），不重复扫描线上模型
    if (this.provider) {
      this.enabledProviders.push({
        name: this.provider.name || 'webui-agent',
        provider: this.provider,
        config: {}
      });
      this.emit('providerConnected', { name: this.provider.name || 'webui-agent' });
    }

    const configPath = path.join(__dirname, '../../config/agents.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.agents) {
          for (const [key, agentConfig] of Object.entries(config.agents)) {
            if (agentConfig.enabled) {
              try {
                const provider = ProviderFactory.create(key, agentConfig.config);
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

  async _scanTools() {
    // 如果外部传入了已扫描授权的 toolScanner，直接复用，避免二次扫描+授权
    if (this.options.toolScanner) {
      const registered = this.options.toolScanner.getRegisteredTools();
      if (registered && registered.length > 0) {
        this.connectedTools = registered.map(t => ({ name: t.name, ...t }));
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
      const scanResult = await scanner.scan();
      
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
  _createAdapter(toolName) {
    const adapterMap = {
      'claude-code': 'ClaudeCodeAdapter',
      'open-code': 'OpenCodeAdapter',
      'openclaw': 'OpenClawAdapter',
      'qoder': 'QoderAdapter',
      'hermes-agent': 'HermesAgentAdapter',
      'atom-code': 'AtomCodeAdapter',
      'mimo-code': 'MimoCodeAdapter',
      'trae': 'TraeAdapter'
    };
    
    try {
      const AdapterClass = require(`../adapters/${adapterMap[toolName]}`);
      return new AdapterClass({ workspaceDir: this.workspaceDir });
    } catch (e) {
      return null;
    }
  }

  async executeTask(taskDescription, options = {}) {
    const taskId = options.taskId || `task_${Date.now()}`;
    const startTime = Date.now();
    
    this.emit('taskStart', { taskId, task: taskDescription });

    try {
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

  async _splitTask(taskDescription) {
    this.emit('splitting', { task: taskDescription });
    
    const splitter = this.agents.splitter;
    const result = await splitter.splitTask(taskDescription, {});
    
    return result;
  }

  async _executeSubtasks(subtasks, constraints) {
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

  async _executeSingleSubtask(subtask, constraints) {
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

    // 3. 优先使用真实工具执行
    if (hasTools) {
      const selectedTool = this.toolExecutor.selectBestTool(subtask);
      
      if (selectedTool) {
        this.emit('providerSelected', { subtask: subtask.title, tool: selectedTool });
        
        try {
          const toolResult = await this.toolExecutor.executeTask(subtask, {
            preferredTools: [selectedTool],
            timeout: this.timeout,
            workspace: this.workspaceDir
          });
          
          return {
            success: toolResult.success,
            duration: Date.now() - startTime,
            tool: selectedTool,
            provider: null,
            output: toolResult,
            generatedFiles: toolResult.generatedFiles || [],
            stdout: toolResult.output || '',
            stderr: toolResult.error || ''
          };
        } catch (e) {
          this.emit('toolExecutionError', { tool: selectedTool, error: e.message });
          // 工具执行失败，降级到 AI 提供商
        }
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

  /**
   * 选择最佳 AI 提供商
   */
  _selectBestProvider(subtask) {
    const complexity = subtask.estimatedComplexity || 'medium';
    
    if (complexity === 'high' && this.enabledProviders.length > 1) {
      // 复杂任务使用更强的模型
      return this.enabledProviders.find(p => !p.name.includes('small')) || this.enabledProviders[0];
    }
    
    return this.enabledProviders[0];
  }

  async _runWithProvider(providerInfo, subtask, constraints) {
    const provider = providerInfo.provider;
    
    const prompt = this._buildExecutionPrompt(subtask, constraints);
    
    const result = await provider.generate(prompt, {
      maxTokens: 4096,
      temperature: 0.7,
      systemPrompt: this._getSystemPrompt(subtask.role)
    });
    
    return result;
  }

  _buildExecutionPrompt(subtask, constraints) {
    let prompt = `${subtask.title}\n\n`;
    prompt += `${subtask.description}\n\n`;
    
    if (subtask.acceptanceCriteria) {
      prompt += `验收标准：\n${subtask.acceptanceCriteria}\n\n`;
    }
    
    if (constraints) {
      prompt += `约束条件：\n`;
      prompt += `语言：${constraints.language || '未指定'}\n`;
      prompt += `技术栈：${constraints.techStack || '未指定'}\n`;
      prompt += `平台：${constraints.platform || '未指定'}\n`;
    }
    
    prompt += `\n请直接输出代码，不要有多余解释。使用\`\`\`language\ncode\`\`\`格式包裹代码。`;
    
    return prompt;
  }

  _getSystemPrompt(role) {
    const prompts = {
      'code_writer': '你是一位资深编程专家，擅长编写高质量的代码。请直接输出代码，不要解释。',
      'architect': '你是一位资深架构师，擅长设计系统架构和数据结构。',
      'code_reviewer': '你是一位资深代码审查专家，擅长发现代码中的问题。',
      'tester': '你是一位资深测试工程师，擅长设计测试用例。',
      'quality_checker': '你是一位资深质量保障负责人，负责审核代码质量。'
    };
    return prompts[role] || prompts['code_writer'];
  }

  _extractGeneratedFiles(result, constraints) {
    const files = [];
    const content = result.content || '';
    
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

  _getExtension(language) {
    const map = {
      javascript: '.js', python: '.py', html: '.html', css: '.css',
      json: '.json', typescript: '.ts', jsx: '.jsx', tsx: '.tsx',
      java: '.java', go: '.go', rust: '.rs', c: '.c', cpp: '.cpp',
      'c++': '.cpp', 'c/c++': '.cpp', csharp: '.cs', php: '.php',
      ruby: '.rb', swift: '.swift', kotlin: '.kt', sql: '.sql',
      shell: '.sh', bash: '.sh', lua: '.lua', perl: '.pl',
      haskell: '.hs', dart: '.dart', r: '.r'
    };
    return map[language?.toLowerCase()] || '.txt';
  }

  async _checkQuality(executionResults, constraints) {
    const qualityResults = [];
    
    for (const result of executionResults) {
      if (!result.success || !result.output) continue;
      
      const qualityChecker = this.agents.qualityChecker;
      const qualityResult = await qualityChecker.checkQuality(
        result.subtask,
        result.output.content,
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

  async _generateSummary(taskDescription, splitResult, executionResults, qualityResults) {
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

  async _generateReport(taskId, startTime, splitResult, executionResults, qualityResults, summary) {
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

  async executeWithMultipleProviders(taskDescription, options = {}) {
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

  async _executeWithSingleProvider(providerInfo, taskDescription) {
    const startTime = Date.now();
    
    try {
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
    } catch (e) {
      throw e;
    }
  }

  async _evaluateResult(content, taskDescription) {
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

  getStatus() {
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
