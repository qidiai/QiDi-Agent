const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const ToolScanner = require('./ToolScanner');
const RealTaskExecutor = require('./RealTaskExecutor');
const adapters = require('../adapters');
const ExperimentReportGenerator = require('../utils/ExperimentReportGenerator');
const AgentHub = require('./AgentHub');
const TokenCounter = require('../utils/TokenCounter');
const createLogger = require('../utils/Logger');
const logger = createLogger('WebUIServer');

class WebUIServer {
  constructor(options = {}) {
    this.port = options.port || process.env.WEB_PORT || 3000;
    this.host = options.host || '127.0.0.1';
    this.configDir = options.configDir || './config';
    this.workspaceDir = options.workspaceDir || './workspace';
    this.reportDir = options.reportDir || './reports';
    
    // 安全配置
    this.corsOrigin = process.env.CORS_ALLOW_ORIGIN || 'http://localhost:3000';
    this.authPassword = process.env.WEBUI_AUTH_PASSWORD || '';
    this.allowedIPs = (process.env.ALLOWED_IPS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    this._authToken = this.authPassword ? crypto.createHash('sha256').update(this.authPassword).digest('hex') : null;
    
    // _activeTasks 容量限制 + 定时清理
    this._MAX_ACTIVE_TASKS = 100;
    this._TASK_CLEANUP_INTERVAL_MS = 3600000; // 1h
    this._cleanupTimer = null;
    this._activeTasks = new Map();
    
    this.app = express();
    this.toolScanner = null;
    this.reportGenerator = null;
    this.agentHub = null;

    this.chatMemoryDir = path.join(this.configDir, 'chat_memory');
    this._ensureDir(this.chatMemoryDir);
    this.chatTokenCounter = new TokenCounter();
    this.MAX_CHAT_CONTEXT_TOKENS = 24000;

    this._agentStatus = new Map();
    this._tokenStats = new Map();
    
    this._setupMiddleware();
    this._setupAuth();
    this._setupRoutes();
    this._setupStaticFiles();
  }

  _setupMiddleware() {
    // 全局速率限制：所有 API 限 100次/分钟
    const generalLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: '请求过于频繁，请稍后再试' }
    });
    this.app.use(generalLimiter);

    // 执行任务 API 严格限速：10次/分钟
    const executeLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: '任务执行过于频繁，请稍后再试' }
    });
    this.app.use('/api/tasks/execute', executeLimiter);

    // 文件上传路由放在 express.json() 之前，避免 multipart 冲突
    this._setupFileUpload();

    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    
    this.app.use((req, res, next) => {
      // CORS：根据环境变量限制来源
      const origin = this.corsOrigin === '*' ? '*' : (req.headers.origin || '');
      res.setHeader('Access-Control-Allow-Origin', this.corsOrigin === '*' ? '*' : origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-WebUI-Token');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }

  /**
   * 认证中间件
   * 如果配置了 WEBUI_AUTH_PASSWORD，则要求请求携带 X-WebUI-Token 头
   */
  _setupAuth() {
    if (!this._authToken) return;

    this.app.use((req, res, next) => {
      // 健康检查接口免认证
      if (req.path === '/api/health') return next();
      
      const token = req.headers['x-webui-token'];
      if (!token) {
        logger.warn('WebUI 认证失败：缺少令牌', { ip: req.ip, path: req.path });
        return res.status(401).json({ error: '未授权，请提供有效的认证令牌' });
      }
      // 使用 timingSafeEqual 防止时序攻击
      const tokenBuf = Buffer.from(token);
      const expectedBuf = Buffer.from(this._authToken);
      if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
        logger.warn('WebUI 认证失败：令牌无效', { ip: req.ip, path: req.path });
        return res.status(401).json({ error: '未授权，请提供有效的认证令牌' });
      }
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

    this.app.get('/api/modes/detail/:name', async (req, res) => {
      try {
        const ExecutionModeManager = require('./ExecutionModeManager');
        const manager = new ExecutionModeManager();
        const modeName = req.params.name;
        const config = manager.getModeConfig(modeName);
        res.json(config);
      } catch (e) {
        res.status(404).json({ error: '未知模式: ' + req.params.name });
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

    this.app.post('/api/chat', async (req, res) => {
      try {
        const result = await this._handleChat(req.body);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/chat/sessions', async (req, res) => {
      try {
        const sessions = this._listChatSessions();
        res.json({ sessions });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/chat/sessions/:id', async (req, res) => {
      try {
        const session = this._loadChatSession(req.params.id);
        if (!session) {
          res.status(404).json({ error: '会话不存在' });
        } else {
          res.json(session);
        }
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.delete('/api/chat/sessions/:id', async (req, res) => {
      try {
        const result = this._deleteChatSession(req.params.id);
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
        // 复用统一的安全路径解析
        let fullPath;
        try {
          fullPath = this._resolveSafe(filePath);
        } catch (e) {
          res.status(403).json({ error: e.message });
          return;
        }
        if (!fs.existsSync(fullPath)) {
          res.status(404).json({ error: '文件不存在' });
          return;
        }
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          res.status(400).json({ error: '目标是目录，不能查看' });
          return;
        }
        // 二进制以 base64 返回，否则文本直返（兼容旧前端）
        const buf = fs.readFileSync(fullPath);
        if (buf.includes(0)) {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.send(buf.toString('base64'));
        } else {
          res.type('text/plain; charset=utf-8').send(buf.toString('utf-8'));
        }
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

    // ═══════════════ 文件管理 API（统一规范化）═══════════════
    // 所有路径均相对于 workspaceDir，自动防穿越。
    this.app.get('/api/files', async (req, res) => {
      try {
        const sub = (req.query.path || '.').toString();
        const recursive = req.query.recursive === '1' || req.query.recursive === 'true';
        const result = this._listFiles(sub, recursive);
        res.json(result);
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.get('/api/files/read', async (req, res) => {
      try {
        const result = this._readFile((req.query.path || '').toString());
        res.json(result);
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/files/write', async (req, res) => {
      try {
        const { path: relPath, content, encoding } = req.body || {};
        if (!relPath) {
          res.status(400).json({ error: '缺少 path 参数' });
          return;
        }
        const result = this._writeFile(relPath, content || '', encoding || 'utf-8');
        res.json(result);
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/files/rename', async (req, res) => {
      try {
        const { from, to } = req.body || {};
        if (!from || !to) {
          res.status(400).json({ error: '缺少 from/to 参数' });
          return;
        }
        const result = this._renameFile(from, to);
        res.json(result);
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/files/delete', async (req, res) => {
      try {
        const { path: relPath } = req.body || {};
        if (!relPath) {
          res.status(400).json({ error: '缺少 path 参数' });
          return;
        }
        const result = this._deleteFile(relPath);
        res.json(result);
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/files/mkdir', async (req, res) => {
      try {
        const { path: relPath } = req.body || {};
        if (!relPath) {
          res.status(400).json({ error: '缺少 path 参数' });
          return;
        }
        const result = this._makeDir(relPath);
        res.json(result);
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    // 下载文件（响应正文为原始内容 + Content-Disposition）
    this.app.get('/api/files/download', async (req, res) => {
      try {
        const relPath = (req.query.path || '').toString();
        if (!relPath) {
          res.status(400).json({ error: '缺少 path 参数' });
          return;
        }
        const fullPath = this._resolveSafe(relPath);
        if (!fs.existsSync(fullPath)) {
          res.status(404).json({ error: '文件不存在' });
          return;
        }
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          res.status(400).json({ error: '不能下载目录' });
          return;
        }
        const baseName = path.basename(fullPath);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}"`);
        res.setHeader('Content-Length', stat.size);
        const stream = fs.createReadStream(fullPath);
        stream.pipe(res);
      } catch (e) {
        res.status(400).json({ error: e.message });
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
      logger.error('Error loading agents:', e);
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

  async _handleChat(chatData) {
    const { messages, options, sessionId } = chatData;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return { success: false, message: '消息不能为空' };
    }

    const enabledAgents = this.agentHub.getEnabledAgents();
    if (enabledAgents.length === 0) {
      return { success: false, message: '没有已启用的模型，请先到「模型管理」页启用至少一个模型' };
    }

    const agent = enabledAgents[0];
    const provider = agent.provider;

    if (!provider || typeof provider.chat !== 'function') {
      return { success: false, message: `模型 ${agent.name} 的 Provider 不可用` };
    }

    // ═══════════════════════════════════════════════
    // 上下文长度管理：估算 token，超出则截断旧消息
    // ═══════════════════════════════════════════════
    const systemPromptText = options?.systemPrompt ||
      '你叫 QIDI Agent（启迪智能体），是一个多模型协同编程助手。你的核心能力包括：\n\n' +
      '1. 多模型协同：同时调用多个 AI 模型（Ollama、OpenAI、Claude 等）协同完成编程任务\n' +
      '2. 智能路由：根据任务类型自动选择合适的模型和工具\n' +
      '3. 代码生成：支持 C、Python、TypeScript、Go、Rust、Java 等多语言代码生成\n' +
      '4. 隐私模式：代码碎片化分发，敏感信息不出本地\n' +
      '5. 高质量模式：调用多个云端模型协同编排，输出代码质量对标国际前沿模型\n' +
      '6. 任务编排：自动分解复杂任务，按序执行子任务\n\n' +
      '回答要求：\n' +
      '- 始终以 QIDI Agent 的身份回应，不要说"我是某某模型"，不论底层调用的是哪个模型\n' +
      '- 当被问及"你是谁"时，介绍你是 QIDI Agent 以及上述核心功能\n' +
      '- 友好、清晰地回应用户的问题，帮助用户理清需求\n' +
      '- 当用户明确表示要执行任务时，引导用户点击「执行任务」按钮\n' +
      '- 用户可以为你设定新的身份和角色。当用户说"从现在起你是..."时，请按用户要求改变你的回答风格和身份\n' +
      '- 使用中文回复';

    const systemTokens = this.chatTokenCounter.estimateTokens(systemPromptText);
    let managedMessages = [...messages];
    let totalTokens = this._countMessagesTokens(managedMessages) + systemTokens;
    let truncatedCount = 0;

    // 如果超出上下文预算，从中间删除最旧的消息（保留第1条和最新的）
    while (totalTokens > this.MAX_CHAT_CONTEXT_TOKENS && managedMessages.length > 2) {
      // 删除第2条（索引1），保留首条和最新的
      managedMessages.splice(1, 1);
      totalTokens = this._countMessagesTokens(managedMessages) + systemTokens;
      truncatedCount++;
    }

    // ═══════════════════════════════════════════════
    // 调用 AI Provider
    // ═══════════════════════════════════════════════
    try {
      const result = await provider.chat(managedMessages, {
        systemPrompt: systemPromptText,
        temperature: 0.7,
        maxTokens: 4096
      });

      const responseTokens = this.chatTokenCounter.estimateTokens(result.content || '');

      // ═══════════════════════════════════════════════
      // 持久化：保存对话到本地文件
      // ═══════════════════════════════════════════════
      const now = new Date().toISOString();
      const sid = sessionId || `chat_${Date.now()}`;
      try {
        const filePath = path.join(this.chatMemoryDir, `${sid}.json`);
        const existing = fs.existsSync(filePath)
          ? JSON.parse(fs.readFileSync(filePath, 'utf-8'))
          : { id: sid, createdAt: now, messages: [], systemPrompt: systemPromptText };
        existing.updatedAt = now;
        existing.messages = messages; // 保存原始消息（含此次新消息）
        existing.systemPrompt = systemPromptText;
        existing.messageCount = messages.length;
        existing.lastMessage = messages[messages.length - 1]?.content?.slice(0, 120) || '';
        fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf-8');
      } catch (_) { /* 持久化失败不影响对话 */ }

      return {
        success: true,
        content: result.content || '',
        model: result.model || agent.name,
        usage: {
          promptTokens: totalTokens,
          completionTokens: responseTokens,
          totalTokens: totalTokens + responseTokens,
          contextLimit: this.MAX_CHAT_CONTEXT_TOKENS,
          truncatedCount
        },
        sessionId: sid
      };
    } catch (e) {
      return { success: false, message: `对话失败: ${e.message}` };
    }
  }

  /** 估算消息列表的总 token 数 */
  _countMessagesTokens(messages) {
    if (!messages || !Array.isArray(messages)) return 0;
    let total = 0;
    for (const msg of messages) {
      total += this.chatTokenCounter.estimateTokens(msg.content || '');
      total += 4; // role 标记（user/assistant）的粗略开销
    }
    return total;
  }

  /** 列出所有聊天会话摘要 */
  _listChatSessions() {
    try {
      if (!fs.existsSync(this.chatMemoryDir)) return [];
      const files = fs.readdirSync(this.chatMemoryDir)
        .filter(f => f.startsWith('chat_') && f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, 100);
      return files.map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.chatMemoryDir, f), 'utf-8'));
          return {
            id: data.id,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            messageCount: data.messageCount || 0,
            lastMessage: data.lastMessage || '',
            systemPrompt: data.systemPrompt ? (data.systemPrompt.length > 60 ? data.systemPrompt.slice(0, 60) + '...' : data.systemPrompt) : null
          };
        } catch (_) { return null; }
      }).filter(Boolean);
    } catch (_) { return []; }
  }

  /** 加载单个会话的完整数据（含消息） */
  _loadChatSession(sessionId) {
    try {
      const filePath = path.join(this.chatMemoryDir, `${sessionId}.json`);
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch (_) {}
    return null;
  }

  /** 删除单个会话 */
  _deleteChatSession(sessionId) {
    try {
      const filePath = path.join(this.chatMemoryDir, `${sessionId}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return { success: true, message: '会话已删除' };
      }
      return { success: false, message: '会话不存在' };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  async _executeTask(taskData) {
    const taskId = `task_${Date.now()}`;
    const { task, models, constraints, mode } = taskData;

    // 未指定模型时，使用所有已启用的模型（在「模型管理」页启用）
    let useModels = models;
    if (!useModels || useModels.length === 0) {
      try {
        useModels = this.agentHub.getEnabledAgents().map(a => a.name);
      } catch (_) { useModels = []; }
    }

    // 容量控制
    this._ensureActiveTaskSlot(taskId);
    
    this._activeTasks.set(taskId, {
      id: taskId,
      task,
      models: useModels,
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

    // 立即返回 taskId 给前端，后台异步执行任务
    setImmediate(() => {
      this._runTaskAsync(taskId, task, useModels, constraints || {}, mode || 'privacy')
        .catch(e => {
          const task = this._activeTasks.get(taskId);
          if (task) {
            task.status = 'failed';
            task.error = e.message;
            task.output = [...(task.output || []), `\n❌ 执行异常: ${e.message}\n`];
          }
          this.updateAgentStatus('console', { status: 'idle' });
        });
    });

    return { success: true, taskId, message: '任务已提交，正在执行...' };
  }

  /**
   * 异步执行任务内部方法（替代 setTimeout）。
   */
  async _runTaskAsync(taskId, task, models, constraints, mode) {
    try {
      const taskMode = this._activeTasks.get(taskId)?.mode || 'privacy';
      
      // 从 AgentHub 获取第一个启用 Agent 的 provider 传下去，否则 TaskSplitter 无法工作
      const resolvedProvider = this.agentHub?.getEnabledAgents?.()?.[0]?.provider || null;

      const executor = new RealTaskExecutor({
        workspaceDir: `${this.workspaceDir}/${taskId}`,
        timeout: 600000,
        executionMode: taskMode,
        provider: resolvedProvider,
        toolScanner: this.toolScanner  // 传递已扫描+授权好的工具列表，避免二次扫描
      });

      this._activeTasks.set(taskId, {
        ...this._activeTasks.get(taskId),
        progress: 10,
        output: [...(this._activeTasks.get(taskId)?.output || []), `🎯 执行模式: ${taskMode === 'privacy' ? '🔒 隐私模式' : taskMode === 'efficiency' ? '⚡ 效率模式' : '✨ 高质量模式'}\n正在初始化任务执行器...\n`]
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

      this.reportGenerator.generateAndSave({
        originalTask: task,
        successRate: result.finalSummary.success ? 100 : Math.round((result.finalSummary.completedSubtasks / result.finalSummary.totalSubtasks) * 100),
        totalTasks: result.finalSummary.totalSubtasks,
        completedTasks: result.finalSummary.completedSubtasks,
        failedTasks: result.finalSummary.failedSubtasks,
        outputDir: `${this.workspaceDir}/${taskId}`,
        constraints,
        tasks: result.finalSummary.subtasks
      });

      // 启动定时清理
      this._startTaskCleanup();

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

  // ═══════════════ 文件管理辅助方法 ═══════════════
  // 所有方法都对路径做安全校验，防止穿越 workspaceDir。

  _resolveSafe(relPath) {
    const resolvedWorkspace = path.resolve(this.workspaceDir);
    const fullPath = path.resolve(path.join(this.workspaceDir, relPath));
    if (!fullPath.startsWith(resolvedWorkspace)) {
      throw new Error('禁止访问工作目录之外的文件');
    }
    return fullPath;
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _detectLang(name) {
    const ext = path.extname(name).toLowerCase();
    const map = {
      '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
      '.ts': 'typescript', '.tsx': 'typescript', '.jsx': 'javascript',
      '.py': 'python',
      '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
      '.java': 'java', '.go': 'go', '.rs': 'rust', '.rb': 'ruby',
      '.php': 'php', '.sh': 'bash', '.bash': 'bash',
      '.json': 'json', '.md': 'markdown', '.txt': 'text',
      '.html': 'html', '.css': 'css', '.yml': 'yaml', '.yaml': 'yaml',
      '.sql': 'sql', '.xml': 'xml'
    };
    return map[ext] || 'text';
  }

  _walkDir(dir, base = '') {
    const out = [];
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) { return out; }
    // 文件夹优先，名字升序
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push({ name: entry.name, path: rel, type: 'dir' });
        // 递归：但限制深度避免过大
      } else {
        try {
          const stat = fs.statSync(path.join(dir, entry.name));
          out.push({
            name: entry.name,
            path: rel,
            type: 'file',
            size: stat.size,
            modified: stat.mtimeMs,
            lang: this._detectLang(entry.name)
          });
        } catch (_) { /* ignore */ }
      }
    }
    return out;
  }

  _listFiles(relPath, recursive) {
    const fullPath = this._resolveSafe(relPath);
    if (!fs.existsSync(fullPath)) {
      return { path: relPath, exists: false, entries: [] };
    }
    const stat = fs.statSync(fullPath);
    if (!stat.isDirectory()) {
      return {
        path: relPath,
        exists: true,
        type: 'file',
        size: stat.size,
        modified: stat.mtimeMs,
        lang: this._detectLang(fullPath)
      };
    }

    const entries = [];
    if (recursive) {
      // 递归但限制最大条目
      const walk = (dir, base = '') => {
        const list = this._walkDir(dir, base);
        for (const e of list) {
          entries.push(e);
          if (e.type === 'dir' && entries.length < 2000) {
            walk(path.join(dir, e.name), e.path);
          }
        }
      };
      walk(fullPath);
    } else {
      entries.push(...this._walkDir(fullPath));
    }

    return {
      path: relPath,
      exists: true,
      type: 'dir',
      entries,
      total: entries.length
    };
  }

  _readFile(relPath) {
    const fullPath = this._resolveSafe(relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error('文件不存在');
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      throw new Error('目标是目录，不能读取为文件');
    }
    const buf = fs.readFileSync(fullPath);
    const size = buf.length;
    // 自动检测是否为二进制：含 NUL 字节则视为二进制
    const isBinary = buf.includes(0);
    let content;
    if (isBinary) {
      content = buf.toString('base64');
    } else {
      content = buf.toString('utf-8');
    }
    return {
      success: true,
      path: relPath,
      content,
      encoding: isBinary ? 'base64' : 'utf-8',
      size,
      modified: stat.mtimeMs,
      lang: this._detectLang(fullPath),
      binary: isBinary
    };
  }

  _writeFile(relPath, content, encoding = 'utf-8') {
    const fullPath = this._resolveSafe(relPath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let buf;
    if (encoding === 'base64') {
      buf = Buffer.from(content, 'base64');
    } else {
      buf = Buffer.from(content, encoding || 'utf-8');
    }
    fs.writeFileSync(fullPath, buf);
    const stat = fs.statSync(fullPath);
    return {
      success: true,
      path: relPath,
      size: stat.size,
      modified: stat.mtimeMs,
      message: '文件已保存'
    };
  }

  _renameFile(fromRel, toRel) {
    const fromFull = this._resolveSafe(fromRel);
    const toFull = this._resolveSafe(toRel);
    if (!fs.existsSync(fromFull)) {
      throw new Error('源文件不存在');
    }
    if (fs.existsSync(toFull)) {
      throw new Error('目标已存在');
    }
    const toDir = path.dirname(toFull);
    if (!fs.existsSync(toDir)) {
      fs.mkdirSync(toDir, { recursive: true });
    }
    fs.renameSync(fromFull, toFull);
    return {
      success: true,
      from: fromRel,
      to: toRel,
      message: '已重命名'
    };
  }

  _deleteFile(relPath) {
    const fullPath = this._resolveSafe(relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error('文件不存在');
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      // 仅删除空目录；非空需递归
      fs.rmSync(fullPath, { recursive: true, force: false });
    } else {
      fs.unlinkSync(fullPath);
    }
    return { success: true, path: relPath, message: '已删除' };
  }

  _makeDir(relPath) {
    const fullPath = this._resolveSafe(relPath);
    if (fs.existsSync(fullPath)) {
      return { success: true, path: relPath, message: '目录已存在' };
    }
    fs.mkdirSync(fullPath, { recursive: true });
    return { success: true, path: relPath, message: '目录已创建' };
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
        logger.info(`QIDI Agent Web UI 已启动 | 地址: http://${this.host}:${this.port}`);
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
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  /**
   * 启动 _activeTasks 定时清理：移除 completed/failed 超 1h 的条目。
   */
  _startTaskCleanup() {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => this._cleanupExpiredTasks(), this._TASK_CLEANUP_INTERVAL_MS);
    this._cleanupExpiredTasks();
  }

  _cleanupExpiredTasks() {
    const now = Date.now();
    const expired = [];
    for (const [id, task] of this._activeTasks) {
      if ((task.status === 'completed' || task.status === 'failed') && (now - task.createdAt) > this._TASK_CLEANUP_INTERVAL_MS) {
        expired.push(id);
      }
    }
    for (const id of expired) this._activeTasks.delete(id);
    if (expired.length > 0) {
      logger.info(`[WebUI] 清理过期任务 ${expired.length} 个，当前活跃: ${this._activeTasks.size}`);
    }
  }

  /**
   * 安全插入 _activeTasks：超限则淘汰最旧的 completed/failed 条目。
   */
  _ensureActiveTaskSlot(taskId) {
    while (this._activeTasks.size >= this._MAX_ACTIVE_TASKS) {
      let oldestId = null;
      let oldestTs = Infinity;
      for (const [id, t] of this._activeTasks) {
        if ((t.status === 'completed' || t.status === 'failed') && t.createdAt < oldestTs) {
          oldestTs = t.createdAt;
          oldestId = id;
        }
      }
      if (oldestId) {
        this._activeTasks.delete(oldestId);
      } else {
        let stalledId = null;
        let stalledTs = Infinity;
        for (const [id, t] of this._activeTasks) {
          if (t.progress < 100 && t.createdAt < stalledTs) {
            stalledTs = t.createdAt;
            stalledId = id;
          }
        }
        if (stalledId) this._activeTasks.delete(stalledId);
        else break;
      }
    }
  }

  /**
   * 文件上传路由（必须在 express.json() 之前注册，避免 multipart 冲突）。
   */
  _setupFileUpload() {
    const uploadDir = path.join(__dirname, '../../tmp/uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    
    const upload = multer({ dest: uploadDir, limits: { fileSize: 50 * 1024 * 1024 } });
    
    // multipart 上传
    this.app.post('/api/files/upload', upload.array('files', 20), async (req, res) => {
      try {
        if (!req.files || req.files.length === 0) {
          res.status(400).json({ error: '未选择任何文件' });
          return;
        }
        const dirRel = (req.body?.dir || '').toString().replace(/\\/g, '/');
        const results = [];
        for (const file of req.files) {
          try {
            const content = fs.readFileSync(file.path);
            const encoding = file.mimetype?.includes('text') ? 'utf-8' : 'base64';
            const decoded = encoding === 'utf-8' ? content.toString('utf-8') : content.toString('base64');
            const target = dirRel ? `${dirRel}/${file.originalname}` : file.originalname;
            const r = this._writeFile(target, decoded, encoding);
            results.push({ name: file.originalname, ...r, size: file.size });
            fs.unlinkSync(file.path); // 清理临时文件
          } catch (e) {
            try { fs.unlinkSync(file.path); } catch (_) {}
            results.push({ name: file.originalname, success: false, error: e.message });
          }
        }
        res.json({ success: true, uploaded: results, count: results.length });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });
    
    // 遗留兼容：JSON 格式上传
    this.app.post('/api/files/upload-json', async (req, res) => {
      try {
        const { path: dirRel, files } = req.body || {};
        if (!Array.isArray(files) || files.length === 0) {
          res.status(400).json({ error: '缺少 files 数组（每项 {name, content}）' });
          return;
        }
        const results = [];
        for (const f of files) {
          try {
            const target = dirRel ? `${dirRel}/${f.name}` : f.name;
            const r = this._writeFile(target, f.content || '', f.encoding || 'utf-8');
            results.push({ name: f.name, ...r });
          } catch (e) {
            results.push({ name: f.name, success: false, error: e.message });
          }
        }
        res.json({ success: true, uploaded: results });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });
  }
}

module.exports = WebUIServer;