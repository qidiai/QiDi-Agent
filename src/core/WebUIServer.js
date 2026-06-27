const express = require('express');
const path = require('path');
const fs = require('fs');
const ToolScanner = require('./ToolScanner');
const RealTaskExecutor = require('./RealTaskExecutor');
const adapters = require('../adapters');
const ExperimentReportGenerator = require('../utils/ExperimentReportGenerator');
const AgentHub = require('./AgentHub');

class WebUIServer {
  constructor(options = {}) {
    this.port = options.port || process.env.WEB_PORT || 3000;
    this.host = options.host || '127.0.0.1';
    this.configDir = options.configDir || './config';
    this.workspaceDir = options.workspaceDir || './workspace';
    this.reportDir = options.reportDir || './reports';
    
    this.app = express();
    this.toolScanner = null;
    this.reportGenerator = null;
    this.agentHub = null;
    
    this._activeTasks = new Map();
    this._agentStatus = new Map();
    this._tokenStats = new Map();
    
    this._setupMiddleware();
    this._setupRoutes();
    this._setupStaticFiles();
  }

  _setupMiddleware() {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    
    this.app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      next();
    });
  }

  _setupRoutes() {
    this.app.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        timestamp: Date.now(),
        version: '1.0.0'
      });
    });

    this.app.get('/api/dashboard', async (req, res) => {
      try {
        const data = await this._getDashboardData();
        res.json(data);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/tools', async (req, res) => {
      try {
        const tools = await this._getToolsList();
        res.json({ tools });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/tools/scan', async (req, res) => {
      try {
        const results = await this._scanTools();
        res.json({ results });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/tools/connect/:name', async (req, res) => {
      try {
        const result = await this._connectTool(req.params.name);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/tools/:name/detail', async (req, res) => {
      try {
        const detail = await this._getToolDetail(req.params.name);
        res.json(detail);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/agents', async (req, res) => {
      try {
        const agents = await this._getAgentsList();
        res.json({ agents });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/agents/:name/status', async (req, res) => {
      try {
        const status = await this._getAgentStatus(req.params.name);
        res.json(status);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/agents/:name/enable', async (req, res) => {
      try {
        const result = await this._enableAgent(req.params.name);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/agents/:name/disable', async (req, res) => {
      try {
        const result = await this._disableAgent(req.params.name);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/routing/config', async (req, res) => {
      try {
        const config = this._getRoutingConfig();
        res.json(config);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/routing/config', async (req, res) => {
      try {
        const result = await this._saveRoutingConfig(req.body);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // ═══════════════ 执行模式 API ═══════════════
    this.app.get('/api/modes', async (req, res) => {
      try {
        const TaskOrchestrator = require('./TaskOrchestrator');
        const orch = new TaskOrchestrator(null, { workspaceDir: this.workspaceDir });
        const modes = orch.getExecutionModes();
        const currentMode = orch.getExecutionMode();
        res.json({
          modes,
          currentMode,
          total: modes.length
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/modes/compare', async (req, res) => {
      try {
        const ExecutionModeManager = require('./ExecutionModeManager');
        const manager = new ExecutionModeManager();
        const comparison = manager.compareModes('privacy', 'quality');
        res.json(comparison);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/modes/recommend', async (req, res) => {
      try {
        const ExecutionModeManager = require('./ExecutionModeManager');
        const manager = new ExecutionModeManager();
        const taskDescription = req.body.task || '';
        const recommendation = manager.recommendMode(taskDescription);
        res.json(recommendation);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/models', async (req, res) => {
      try {
        const result = await this._saveModel(req.body);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.delete('/api/models/:name', async (req, res) => {
      try {
        const result = await this._deleteModel(req.params.name);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.put('/api/models/:name', async (req, res) => {
      try {
        const result = await this._updateModel(req.params.name, req.body);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/tasks/execute', async (req, res) => {
      try {
        const result = await this._executeTask(req.body);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/tasks/:taskId/status', async (req, res) => {
      try {
        const status = this._getTaskStatus(req.params.taskId);
        res.json(status);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/files/view', async (req, res) => {
      try {
        const filePath = req.query.path;
        if (!filePath) {
          res.status(400).json({ error: '缺少文件路径' });
          return;
        }
        
        // 🚨 安全修复：防止路径穿越攻击
        const resolvedWorkspace = path.resolve(this.workspaceDir);
        const fullPath = path.resolve(path.join(this.workspaceDir, filePath));
        
        // 确保解析后的路径在 workspaceDir 内
        if (!fullPath.startsWith(resolvedWorkspace)) {
          res.status(403).json({ error: '禁止访问工作目录之外的文件' });
          return;
        }
        
        if (!fs.existsSync(fullPath)) {
          res.status(404).json({ error: '文件不存在' });
          return;
        }
        
        const content = fs.readFileSync(fullPath, 'utf-8');
        res.send(content);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/tokens', async (req, res) => {
      try {
        const tokens = await this._getTokenStats();
        res.json({ tokens });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/reports', async (req, res) => {
      try {
        const { tag, limit = 20 } = req.query;
        const reports = this.reportGenerator.listReports({ tag, limit: parseInt(limit) });
        res.json({ reports });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/reports/:id', async (req, res) => {
      try {
        const report = this.reportGenerator.loadReport(req.params.id);
        if (!report) {
          res.status(404).json({ error: '报告不存在' });
        } else {
          res.json(report);
        }
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/reports/tags/list', async (req, res) => {
      try {
        const tags = this.reportGenerator.getTags();
        res.json({ tags });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/tasks', async (req, res) => {
      try {
        const tasks = await this._getTasksList();
        res.json({ tasks });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/stats/overview', async (req, res) => {
      try {
        const stats = this.reportGenerator.getStats();
        res.json(stats);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }

  _setupStaticFiles() {
    const publicDir = path.join(__dirname, '../../public');
    if (fs.existsSync(publicDir)) {
      this.app.use(express.static(publicDir));
    }
    
    this.app.get('/', (req, res) => {
      const indexPath = path.join(__dirname, '../../public/index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.json({
          name: 'QIDI Agent Web UI',
          version: '1.0.0',
          status: 'running',
          endpoints: [
            '/api/health',
            '/api/dashboard',
            '/api/tools',
            '/api/agents',
            '/api/tokens',
            '/api/reports'
          ]
        });
      }
    });
  }

  async _getDashboardData() {
    const tools = await this._getToolsList();
    const agents = await this._getAgentsList();
    const tokenStats = await this._getTokenStats();
    const reportStats = this.reportGenerator.getStats();
    
    const onlineTools = tools.filter(t => t.status === 'online').length;
    const activeAgents = agents.filter(a => a.status === 'active').length;
    
    return {
      summary: {
        totalTools: tools.length,
        onlineTools,
        totalAgents: agents.length,
        activeAgents,
        totalReports: reportStats.totalReports || 0,
        avgSuccessRate: reportStats.avgSuccessRate || 0,
        totalTokens: this._calculateTotalTokens(tokenStats)
      },
      tools,
      agents,
      tokenStats,
      recentReports: this.reportGenerator.getRecentReports(5),
      timestamp: Date.now()
    };
  }

  async _getToolsList() {
    const tools = [];
    
    for (const adapter of this.toolScanner.adapters) {
      const info = adapter.getInfo();
      tools.push({
        name: info.name,
        displayName: info.displayName,
        description: info.description,
        version: info.version,
        status: info.status,
        detected: info.detected,
        installPath: info.installPath,
        command: info.command
      });
    }
    
    return tools;
  }

  async _scanTools() {
    const results = await this.toolScanner.scan();
    this.toolScanner.saveResults(this.configDir);
    return results;
  }

  async _connectTool(name) {
    try {
      const result = await this.toolScanner.connect(name);
      return {
        success: true,
        ...result,
        tool: name
      };
    } catch (e) {
      return {
        success: false,
        tool: name,
        message: e.message
      };
    }
  }

  async _getToolDetail(name) {
    const adapter = this.toolScanner.getTool(name);
    if (!adapter) {
      const allAdapters = this.toolScanner.adapters;
      const found = allAdapters.find(a => a.name === name);
      if (!found) {
        return { error: '工具不存在' };
      }
      
      return {
        name: found.name,
        displayName: found.displayName,
        description: found.description,
        version: found.version,
        status: found.status,
        detected: found.detected,
        installPath: found.installPath,
        command: found.command,
        workFiles: [],
        workUrls: [],
        tokenUsage: 0
      };
    }

    const workFiles = this._getToolWorkFiles(name);
    const workUrls = this._getToolWorkUrls(name);
    const tokenUsage = this._tokenStats.get(name) || { total: 0, prompt: 0, completion: 0 };

    return {
      name: adapter.name,
      displayName: adapter.displayName,
      description: adapter.description,
      version: adapter.version,
      status: adapter.status,
      detected: adapter.detected,
      installPath: adapter.installPath,
      command: adapter.command,
      workFiles,
      workUrls,
      tokenUsage
    };
  }

  _getToolWorkFiles(toolName) {
    const files = [];
    const toolDir = path.join(this.workspaceDir, toolName);
    
    if (fs.existsSync(toolDir)) {
      const walkDir = (dir, prefix = '') => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          
          if (entry.isDirectory()) {
            walkDir(fullPath, relPath);
          } else {
            const stat = fs.statSync(fullPath);
            files.push({
              name: entry.name,
              path: relPath,
              fullPath,
              size: stat.size,
              modified: stat.mtime
            });
          }
        }
      };
      walkDir(toolDir);
    }
    
    return files.slice(0, 50);
  }

  _getToolWorkUrls(toolName) {
    const urls = [];
    const toolDir = path.join(this.workspaceDir, toolName);
    
    if (fs.existsSync(toolDir)) {
      const files = fs.readdirSync(toolDir);
      for (const file of files) {
        if (file.endsWith('.md') || file.endsWith('.txt')) {
          urls.push({
            name: file,
            type: 'report',
            url: `/api/files/${toolName}/${file}`
          });
        }
      }
    }
    
    return urls;
  }

  async _getAgentsList() {
    const agents = [];
    
    try {
      const configPath = path.join(this.configDir, 'agents.json');
      let config = { agents: {} };
      
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }

      for (const [name, agentConfig] of Object.entries(config.agents)) {
        const status = this._agentStatus.get(name) || { status: 'idle' };
        const tokens = this._tokenStats.get(name) || { total: 0, prompt: 0, completion: 0 };
        const isProvider = ['ollama', 'openai', 'anthropic', 'deepseek', 'groq', 'zhipu'].includes(name);
        
        agents.push({
          name,
          displayName: agentConfig.name_display || agentConfig.name || name,
          fullName: agentConfig.name || name,
          description: agentConfig.description || '',
          provider: agentConfig.provider || name,
          enabled: agentConfig.enabled || false,
          isLocal: name === 'ollama',
          isCloud: isProvider && name !== 'ollama',
          model: agentConfig.config?.model || 'unknown',
          status: agentConfig.enabled ? (status.status || 'ready') : 'disabled',
          currentTask: status.currentTask || null,
          tokenUsage: tokens,
          lastActive: status.lastActive || null,
          apiConfig: {
            baseURL: agentConfig.config?.baseURL || '',
            model: agentConfig.config?.model || ''
          }
        });
      }
    } catch (e) {
      console.error('Error loading agents:', e.message);
    }
    
    return agents;
  }

  async _enableAgent(name) {
    try {
      const configPath = path.join(this.configDir, 'agents.json');
      if (!fs.existsSync(configPath)) {
        return { success: false, message: '配置文件不存在' };
      }
      
      let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      
      if (!config.agents[name]) {
        return { success: false, message: `Agent ${name} 不存在` };
      }
      
      config.agents[name].enabled = true;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      
      await this.agentHub.reload();
      
      return { success: true, message: `${name} 已启用` };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  async _disableAgent(name) {
    try {
      const configPath = path.join(this.configDir, 'agents.json');
      if (!fs.existsSync(configPath)) {
        return { success: false, message: '配置文件不存在' };
      }
      
      let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      
      if (!config.agents[name]) {
        return { success: false, message: `Agent ${name} 不存在` };
      }
      
      config.agents[name].enabled = false;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      
      await this.agentHub.reload();
      
      return { success: true, message: `${name} 已禁用` };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  _getRoutingConfig() {
    const configPath = path.join(this.configDir, 'agents.json');
    let config = { dispatch: {}, agents: {} };
    
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }

    const dispatch = config.dispatch || {};
    
    const strategies = [
      { id: 'parallel', name: '并行模式', desc: '同时执行所有选中的模型，选择最快完成的结果' },
      { id: 'sequential', name: '顺序模式', desc: '依次执行每个模型，适合调试和对比' },
      { id: 'select', name: '选择最佳', desc: '执行所有模型，选择质量最高的结果' },
      { id: 'cascade', name: '级联模式', desc: '依次执行，失败则由下一个接管' }
    ];

    const enabledAgents = Object.entries(config.agents || {})
      .filter(([name, agent]) => agent.enabled)
      .map(([name, agent]) => ({
        name,
        displayName: agent.name_display || agent.name,
        description: agent.description || '',
        priority: 1,
        type: name === 'ollama' ? 'local' : 'cloud'
      }));

    const routingRules = dispatch.routingRules || {
      fast: { keywords: ['简单', '翻译', '格式化', '注释', 'lint'], target: 'ollama', maxTokens: 500 },
      normal: { keywords: ['写代码', '函数', '类', '模块'], target: 'auto', maxTokens: 2000 },
      complex: { keywords: ['算法', '架构', '设计', '复杂', '系统'], target: 'auto', maxTokens: 10000 }
    };

    return {
      currentMode: dispatch.mode || 'parallel',
      strategies,
      agents: enabledAgents,
      routingRules,
      parallelLimit: dispatch.parallelLimit || 3,
      compareResults: dispatch.compareResults !== false,
      selectBest: dispatch.selectBest !== false,
      retryOnFailure: dispatch.retryOnFailure !== false,
      maxRetries: dispatch.maxRetries || 2
    };
  }

  async _saveRoutingConfig(body) {
    try {
      const configPath = path.join(this.configDir, 'agents.json');
      if (!fs.existsSync(configPath)) {
        return { success: false, message: '配置文件不存在' };
      }
      
      let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      
      config.dispatch = {
        ...config.dispatch,
        mode: body.mode,
        parallelLimit: body.parallelLimit,
        compareResults: body.compareResults,
        selectBest: body.selectBest,
        retryOnFailure: body.retryOnFailure,
        maxRetries: body.maxRetries,
        routingRules: body.routingRules
      };
      
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      
      return { success: true, message: '路由配置已保存' };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  async _executeTask(taskData) {
    const taskId = `task_${Date.now()}`;
    const { task, models, constraints, mode } = taskData;

    this._activeTasks.set(taskId, {
      id: taskId,
      task,
      models: models || ['ollama'],
      constraints: constraints || {},
      mode: mode || 'privacy',
      status: 'running',
      progress: 0,
      createdAt: Date.now(),
      output: [],
      files: [],
      error: null
    });

    this.updateAgentStatus('console', {
      status: 'busy',
      currentTask: task.substring(0, 100)
    });

    setTimeout(async () => {
      try {
        const taskMode = this._activeTasks.get(taskId)?.mode || 'privacy';
        
        const executor = new RealTaskExecutor({
          workspaceDir: `${this.workspaceDir}/${taskId}`,
          timeout: 600000,
          executionMode: taskMode
        });

        this._activeTasks.set(taskId, {
          ...this._activeTasks.get(taskId),
          progress: 10,
          output: [...(this._activeTasks.get(taskId)?.output || []), `🎯 执行模式: ${taskMode === 'privacy' ? '🔒 隐私模式' : '✨ 高质量模式'}\n正在初始化任务执行器...\n`]
        });

        const initResult = await executor.initialize();

        this._activeTasks.set(taskId, {
          ...this._activeTasks.get(taskId),
          progress: 20,
          output: [...(this._activeTasks.get(taskId)?.output || []), 
            `✅ 已连接 ${initResult.providers} 个 AI 模型，${initResult.tools} 个工具\n`
          ]
        });

        if (initResult.providers === 0) {
          this._activeTasks.set(taskId, {
            ...this._activeTasks.get(taskId),
            status: 'failed',
            progress: 100,
            error: '没有可用的 AI 模型，请先在模型管理中启用模型',
            output: [...(this._activeTasks.get(taskId)?.output || []), '❌ 没有可用的 AI 模型\n']
          });
          
          this.updateAgentStatus('console', { status: 'idle' });
          return;
        }

        this._activeTasks.set(taskId, {
          ...this._activeTasks.get(taskId),
          progress: 30,
          output: [...(this._activeTasks.get(taskId)?.output || []), '🔄 正在分解任务...\n']
        });

        executor.on('splitting', (e) => {
          this._activeTasks.set(taskId, {
            ...this._activeTasks.get(taskId),
            progress: 40,
            output: [...(this._activeTasks.get(taskId)?.output || []), `📋 任务分解完成\n`]
          });
        });

        executor.on('subtaskStart', (e) => {
          this._activeTasks.set(taskId, {
            ...this._activeTasks.get(taskId),
            output: [...(this._activeTasks.get(taskId)?.output || []), 
              `\n🚀 开始执行: ${e.task.title}\n`
            ]
          });
        });

        executor.on('providerSelected', (e) => {
          this._activeTasks.set(taskId, {
            ...this._activeTasks.get(taskId),
            output: [...(this._activeTasks.get(taskId)?.output || []), 
              `   使用模型: ${e.provider}\n`
            ]
          });
        });

        executor.on('subtaskComplete', (e) => {
          this._activeTasks.set(taskId, {
            ...this._activeTasks.get(taskId),
            progress: Math.min(90, this._activeTasks.get(taskId)?.progress + 5),
            output: [...(this._activeTasks.get(taskId)?.output || []), 
              `   ${e.success ? '✅' : '❌'} ${e.task.title} ${e.success ? '完成' : '失败'}\n`
            ]
          });
        });

        const fullTask = constraints && Object.keys(constraints).length > 0
          ? `${task}\n\n约束条件：${Object.entries(constraints).map(([k, v]) => `${k}: ${v}`).join(', ')}`
          : task;

        const result = await executor.executeTask(fullTask);

        this._activeTasks.set(taskId, {
          ...this._activeTasks.get(taskId),
          status: result.success ? 'completed' : 'failed',
          progress: 100,
          result,
          files: result.executionResults.flatMap(r => r.generatedFiles || []),
          output: [...(this._activeTasks.get(taskId)?.output || []), 
            `\n============================\n`,
            `📊 任务完成！\n`,
            `总子任务: ${result.finalSummary.totalSubtasks}\n`,
            `完成: ${result.finalSummary.completedSubtasks}\n`,
            `失败: ${result.finalSummary.failedSubtasks}\n`,
            `质量通过: ${result.finalSummary.qualityPassed}\n`,
            `生成文件: ${result.executionResults.flatMap(r => r.generatedFiles || []).length} 个\n`,
            `耗时: ${Math.round(result.duration / 1000)} 秒\n`,
            `============================\n`
          ]
        });

        this.updateAgentStatus('console', { status: 'idle' });

        const report = this.reportGenerator.generateAndSave({
          originalTask: task,
          successRate: result.finalSummary.success ? 100 : Math.round((result.finalSummary.completedSubtasks / result.finalSummary.totalSubtasks) * 100),
          totalTasks: result.finalSummary.totalSubtasks,
          completedTasks: result.finalSummary.completedSubtasks,
          failedTasks: result.finalSummary.failedSubtasks,
          outputDir: `${this.workspaceDir}/${taskId}`,
          constraints,
          tasks: result.finalSummary.subtasks
        });

      } catch (e) {
        this._activeTasks.set(taskId, {
          ...this._activeTasks.get(taskId),
          status: 'failed',
          progress: 100,
          error: e.message,
          output: [...(this._activeTasks.get(taskId)?.output || []), `\n❌ 执行错误: ${e.message}\n`]
        });
        
        this.updateAgentStatus('console', { status: 'idle' });
      }
    }, 100);

    return {
      success: true,
      taskId,
      message: '任务已开始执行'
    };
  }

  _getTaskStatus(taskId) {
    const task = this._activeTasks.get(taskId);
    if (!task) {
      return { error: '任务不存在' };
    }
    return task;
  }

  _generateModelKey(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
  }

  async _saveModel(modelData) {
    try {
      const configPath = path.join(this.configDir, 'agents.json');
      let config = { agents: {} };
      
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }

      const modelKey = this._generateModelKey(modelData.name);
      
      if (config.agents[modelKey]) {
        return { success: false, message: `模型 ${modelData.name} 已存在` };
      }

      let provider = 'openai';
      if (modelData.type === 'anthropic') provider = 'anthropic';
      if (modelData.type === 'ollama') provider = 'ollama';

      config.agents[modelKey] = {
        enabled: true,
        provider,
        name: modelData.name,
        name_display: modelData.name_display || modelData.name,
        description: modelData.description || '',
        config: {
          baseURL: modelData.baseURL,
          model: modelData.model,
          apiKey: modelData.apiKey,
          timeout: modelData.timeout || 60000
        }
      };

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      
      await this.agentHub.reload();
      
      return { success: true, message: `模型 ${modelData.name} 添加成功`, key: modelKey };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  async _updateModel(name, modelData) {
    try {
      const configPath = path.join(this.configDir, 'agents.json');
      if (!fs.existsSync(configPath)) {
        return { success: false, message: '配置文件不存在' };
      }
      
      let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const modelKey = this._generateModelKey(name);
      
      if (!config.agents[modelKey]) {
        return { success: false, message: `模型 ${name} 不存在` };
      }

      let provider = 'openai';
      if (modelData.type === 'anthropic') provider = 'anthropic';
      if (modelData.type === 'ollama') provider = 'ollama';

      config.agents[modelKey] = {
        ...config.agents[modelKey],
        enabled: modelData.enabled !== undefined ? modelData.enabled : config.agents[modelKey].enabled,
        provider,
        name: modelData.name || config.agents[modelKey].name,
        name_display: modelData.name_display || modelData.name || config.agents[modelKey].name_display,
        description: modelData.description || config.agents[modelKey].description,
        config: {
          baseURL: modelData.baseURL || config.agents[modelKey].config.baseURL,
          model: modelData.model || config.agents[modelKey].config.model,
          apiKey: modelData.apiKey || config.agents[modelKey].config.apiKey,
          timeout: modelData.timeout || config.agents[modelKey].config.timeout || 60000
        }
      };

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      
      await this.agentHub.reload();
      
      return { success: true, message: `模型 ${name} 更新成功` };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  async _deleteModel(name) {
    try {
      const configPath = path.join(this.configDir, 'agents.json');
      if (!fs.existsSync(configPath)) {
        return { success: false, message: '配置文件不存在' };
      }
      
      let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const modelKey = this._generateModelKey(name);
      
      if (!config.agents[modelKey]) {
        return { success: false, message: `模型 ${name} 不存在` };
      }

      delete config.agents[modelKey];
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      
      await this.agentHub.reload();
      
      return { success: true, message: `模型 ${name} 已删除` };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  async _getAgentStatus(name) {
    const status = this._agentStatus.get(name) || { status: 'idle' };
    const tokens = this._tokenStats.get(name) || { total: 0, prompt: 0, completion: 0 };
    
    return {
      name,
      status: status.status,
      currentTask: status.currentTask,
      tokenUsage: tokens,
      lastActive: status.lastActive,
      workFiles: this._getToolWorkFiles(name),
      timestamp: Date.now()
    };
  }

  async _getTokenStats() {
    const stats = [];
    
    for (const [name, tokens] of this._tokenStats.entries()) {
      stats.push({
        agent: name,
        ...tokens
      });
    }
    
    return stats;
  }

  _calculateTotalTokens(tokenStats) {
    return tokenStats.reduce((sum, t) => sum + (t.total || 0), 0);
  }

  async _getTasksList() {
    const tasks = [];
    
    for (const [id, task] of this._activeTasks.entries()) {
      tasks.push({
        id,
        ...task
      });
    }
    
    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  }

  updateAgentStatus(agentName, status) {
    this._agentStatus.set(agentName, {
      ...status,
      lastActive: Date.now()
    });
  }

  updateTokenUsage(agentName, tokens) {
    const current = this._tokenStats.get(agentName) || { total: 0, prompt: 0, completion: 0, calls: 0 };
    this._tokenStats.set(agentName, {
      total: current.total + (tokens.total || 0),
      prompt: current.prompt + (tokens.prompt || 0),
      completion: current.completion + (tokens.completion || 0),
      calls: current.calls + 1
    });
  }

  async initialize() {
    this.toolScanner = new ToolScanner();
    const allAdapters = adapters.createAll();
    this.toolScanner.registerAdapters(allAdapters);
    
    try {
      this.toolScanner.loadResults(this.configDir);
    } catch (e) {
    }
    
    this.reportGenerator = new ExperimentReportGenerator({
      reportDir: this.reportDir
    });
    
    this.agentHub = new AgentHub({
      configDir: this.configDir
    });
    
    try {
      await this.agentHub.initialize();
    } catch (e) {
    }
    
    return this;
  }

  async start() {
    await this.initialize();
    
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, this.host, () => {
        console.log(`\n🌐 QIDI Agent Web UI 已启动`);
        console.log(`   地址: http://${this.host}:${this.port}`);
        console.log(`   API:  http://${this.host}:${this.port}/api\n`);
        resolve();
      });
    });
  }

  async stop() {
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
    }
  }
}

module.exports = WebUIServer;