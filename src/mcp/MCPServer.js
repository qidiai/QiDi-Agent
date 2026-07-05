/**
 * MCP (Model Context Protocol) 服务器
 *
 * 将 Qidi Agent 的核心能力暴露为 MCP 工具，使任何 MCP 兼容客户端
 * （如 Claude Desktop、Cursor、VS Code Copilot 等）都能调用
 * 多模型编排引擎来执行代码任务。
 *
 * 传输方式：stdio（标准输入/输出）
 * 协议：JSON-RPC 2.0
 *
 * 暴露的工具（Tools）：
 *   1. run_task        — 执行代码任务（拆分→派发→质检→合并）
 *   2. scan_tools      — 扫描本机已安装的 AI 编程工具
 *   3. list_agents     — 列出所有 Agent 及状态
 *   4. list_modes      — 列出所有执行模式
 *   5. recommend_mode  — 根据任务推荐执行模式
 *   6. list_reports    — 列出实验报告
 *   7. get_report      — 获取指定报告内容
 *   8. get_health      — 获取系统健康状态
 *
 * 暴露的资源（Resources）：
 *   1. qidi://config   — 当前配置
 *   2. qidi://modes    — 执行模式详情
 *   3. qidi://reports  — 报告列表
 *
 * 暴露的提示模板（Prompts）：
 *   1. task_split      — 任务拆分提示模板
 *   2. code_review     — 代码审查提示模板
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const ProviderFactory = require('../providers');
const TaskOrchestrator = require('../core/TaskOrchestrator');
const ToolScanner = require('../core/ToolScanner');
const AdapterFactory = require('../adapters');
const ExecutionModeManager = require('../core/ExecutionModeManager');
const MultiAgentDispatcher = require('../core/MultiAgentDispatcher');
const createLogger = require('../utils/Logger');

const logger = createLogger('MCPServer');

const SERVER_INFO = {
  name: 'qidi-agent-mcp',
  version: '1.0.0'
};

const PROTOCOL_VERSION = '2024-11-05';

class MCPServer {
  constructor (options = {}) {
    this.options = {
      workspaceDir: options.workspaceDir || './workspace',
      configDir: options.configDir || path.join(__dirname, '../../config'),
      reportDir: options.reportDir || './reports',
      defaultProvider: options.defaultProvider || process.env.MODEL_PROVIDER || 'ollama',
      defaultMode: options.defaultMode || 'privacy',
      ...options
    };

    this.modeManager = new ExecutionModeManager();
    this._activeTasks = new Map();
    this._taskIdCounter = 0;
    this._initialized = false;
  }

  // ═══════════════════════════════════════════
  // 传输层：stdio JSON-RPC
  // ═══════════════════════════════════════════

  async start () {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
      crlfDelay: Infinity
    });

    // 所有输出走 stderr（日志），stdout 仅用于 JSON-RPC 消息
    process.stderr.write(`[MCP] Qidi Agent MCP Server v${SERVER_INFO.version} 启动中...\n`);

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const message = JSON.parse(trimmed);
        this._handleMessage(message).catch((err) => {
          this._sendError(message.id, -32603, err.message);
        });
      } catch (parseErr) {
        // 非 JSON 行，忽略
        process.stderr.write(`[MCP] 忽略非 JSON 输入: ${trimmed.substring(0, 80)}\n`);
      }
    });

    this.rl.on('close', () => {
      process.stderr.write('[MCP] 输入流关闭，服务器退出\n');
      process.exit(0);
    });

    process.stderr.write('[MCP] 服务器就绪，等待客户端连接...\n');
  }

  // ═══════════════════════════════════════════
  // JSON-RPC 消息处理
  // ═══════════════════════════════════════════

  async _handleMessage (message) {
    // 通知（无 id）：不需要回复
    if (message.id === undefined || message.id === null) {
      return;
    }

    const { method, params, id } = message;

    let result;
    try {
      switch (method) {
      case 'initialize':
        result = this._handleInitialize(params);
        break;
      case 'initialized':
        // 通知，不需要回复
        return;
      case 'tools/list':
        result = this._handleToolsList();
        break;
      case 'tools/call':
        result = await this._handleToolsCall(params);
        break;
      case 'resources/list':
        result = this._handleResourcesList();
        break;
      case 'resources/read':
        result = this._handleResourcesRead(params);
        break;
      case 'prompts/list':
        result = this._handlePromptsList();
        break;
      case 'prompts/get':
        result = this._handlePromptsGet(params);
        break;
      case 'ping':
        result = {};
        break;
      default:
        this._sendError(id, -32601, `未知方法: ${method}`);
        return;
      }
      this._sendResult(id, result);
    } catch (err) {
      this._sendError(id, -32603, err.message);
    }
  }

  _sendResult (id, result) {
    const response = {
      jsonrpc: '2.0',
      id,
      result
    };
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  _sendError (id, code, message, data) {
    const response = {
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data ? { data } : {}) }
    };
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  // ═══════════════════════════════════════════
  // initialize 握手
  // ═══════════════════════════════════════════

  _handleInitialize (params) {
    this._initialized = true;
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: SERVER_INFO,
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
        prompts: { listChanged: false }
      }
    };
  }

  // ═══════════════════════════════════════════
  // 工具定义
  // ═══════════════════════════════════════════

  _handleToolsList () {
    return {
      tools: [
        {
          name: 'run_task',
          description: '执行一个代码任务。Qidi 会自动将任务拆分为子任务，分发给多个 AI 编程工具并行执行，经过质量检查后合并为完整的高质量代码。',
          inputSchema: {
            type: 'object',
            properties: {
              task: {
                type: 'string',
                description: '任务描述，例如："用 Python 写一个贪吃蛇游戏" 或 "实现一个 REST API 服务器"'
              },
              mode: {
                type: 'string',
                enum: ['privacy', 'quality', 'efficiency', 'multi'],
                description: '执行模式。privacy=隐私模式（本地拆分质检，零成本）；quality=高质量模式（云端AI参与）；efficiency=效率模式（广播并行）；multi=多模型并行模式。默认 privacy。',
                default: 'privacy'
              },
              provider: {
                type: 'string',
                enum: ['ollama', 'openai', 'deepseek', 'anthropic'],
                description: 'LLM 提供商。ollama=本地模型（零成本）；openai=GPT系列；deepseek=DeepSeek；anthropic=Claude。默认 ollama。',
                default: 'ollama'
              },
              workspace: {
                type: 'string',
                description: '工作目录路径，生成的代码将保存在此目录下。',
                default: './workspace'
              }
            },
            required: ['task']
          }
        },
        {
          name: 'scan_tools',
          description: '扫描本机已安装的 AI 编程工具（如 Claude Code、OpenClaw、AtomCode 等），返回可用工具列表。',
          inputSchema: {
            type: 'object',
            properties: {
              connect: {
                type: 'boolean',
                description: '扫描后是否自动连接已发现的工具。',
                default: false
              }
            }
          }
        },
        {
          name: 'list_agents',
          description: '列出所有已配置的 AI Agent（LLM 提供商）及其启用状态和连接状态。',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'list_modes',
          description: '列出所有可用的执行模式（隐私模式、高质量模式、效率模式、多模型并行模式），包含各模式的配置详情和适用场景。',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'recommend_mode',
          description: '根据任务描述智能推荐最适合的执行模式。',
          inputSchema: {
            type: 'object',
            properties: {
              task: {
                type: 'string',
                description: '任务描述'
              }
            },
            required: ['task']
          }
        },
        {
          name: 'list_reports',
          description: '列出最近的实验报告，包含任务成功率、质量分数等信息。',
          inputSchema: {
            type: 'object',
            properties: {
              count: {
                type: 'number',
                description: '返回报告数量，默认 10。',
                default: 10
              }
            }
          }
        },
        {
          name: 'get_report',
          description: '获取指定报告的完整内容。',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: '报告 ID'
              }
            },
            required: ['id']
          }
        },
        {
          name: 'get_health',
          description: '获取系统健康状态，包括已连接的工具、Agent 在线状态等。',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        }
      ]
    };
  }

  // ═══════════════════════════════════════════
  // 工具调用处理
  // ═══════════════════════════════════════════

  async _handleToolsCall (params) {
    const { name, arguments: args } = params;

    if (!this._initialized) {
      throw new Error('MCP 服务器尚未初始化，请先发送 initialize 请求');
    }

    let result;
    switch (name) {
    case 'run_task':
      result = await this._toolRunTask(args || {});
      break;
    case 'scan_tools':
      result = await this._toolScanTools(args || {});
      break;
    case 'list_agents':
      result = await this._toolListAgents(args || {});
      break;
    case 'list_modes':
      result = this._toolListModes(args || {});
      break;
    case 'recommend_mode':
      result = this._toolRecommendMode(args || {});
      break;
    case 'list_reports':
      result = this._toolListReports(args || {});
      break;
    case 'get_report':
      result = this._toolGetReport(args || {});
      break;
    case 'get_health':
      result = await this._toolGetHealth(args || {});
      break;
    default:
      throw new Error(`未知工具: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        }
      ]
    };
  }

  // ── 工具实现 ──

  async _toolRunTask (args) {
    const { task, mode, provider, workspace } = args;

    if (!task) {
      throw new Error('缺少必填参数: task');
    }

    const execMode = mode || this.options.defaultMode;
    const providerType = provider || this.options.defaultProvider;
    const workspaceDir = workspace || this.options.workspaceDir;

    process.stderr.write(`[MCP] 执行任务: ${task.substring(0, 80)}...\n`);
    process.stderr.write(`[MCP] 模式: ${execMode}, 提供商: ${providerType}, 工作目录: ${workspaceDir}\n`);

    // 创建 Provider
    let providerInstance;
    try {
      providerInstance = ProviderFactory.create(providerType);
    } catch (e) {
      throw new Error(`无法创建模型提供商 ${providerType}: ${e.message}`);
    }

    // 检查连接
    try {
      const connected = await providerInstance.checkConnection();
      if (!connected) {
        throw new Error(`无法连接到 ${providerType}，请确保服务正在运行`);
      }
    } catch (e) {
      throw new Error(`连接 ${providerType} 失败: ${e.message}`);
    }

    // 扫描并连接工具
    let registeredTools = [];
    try {
      const scanner = new ToolScanner({ silentScan: true, autoConfirm: true });
      scanner.registerAdapters(AdapterFactory.createAll());
      await scanner.scan();
      await scanner.connectAll();
      registeredTools = Array.from(scanner.registeredTools.values());
      process.stderr.write(`[MCP] 已连接 ${registeredTools.length} 个工具\n`);
    } catch (e) {
      process.stderr.write(`[MCP] 工具扫描失败: ${e.message}，仅使用 Provider\n`);
    }

    // 多模式：加载额外 Provider
    let extraProviders = [];
    if (execMode === 'multi') {
      try {
        const AgentHub = require('../core/AgentHub');
        const hub = new AgentHub({ configDir: this.options.configDir });
        await hub.initialize();
        const enabled = hub.getEnabledAgents();
        extraProviders = enabled
          .map(a => ({ name: a.name, provider: a.provider }))
          .filter(p => p.provider);
      } catch (e) {
        process.stderr.write(`[MCP] 多 Provider 加载失败: ${e.message}\n`);
      }
    }

    // 创建编排器
    const orchestrator = new TaskOrchestrator(providerInstance, {
      workspaceDir,
      verbose: false,
      toolAdapters: registeredTools,
      executionMode: execMode,
      providers: extraProviders.length > 0 ? extraProviders.map(p => p.provider) : undefined
    });

    orchestrator.setExecutionMode(execMode);

    // 执行任务
    const taskId = `mcp_task_${++this._taskIdCounter}`;
    const startTime = Date.now();
    this._activeTasks.set(taskId, { status: 'running', startTime });

    try {
      await orchestrator.initialize();
      const result = await orchestrator.runTask(task);
      this._activeTasks.set(taskId, { status: 'completed', startTime, endTime: Date.now() });

      // 构建摘要
      const summary = {
        success: true,
        taskId,
        successRate: result.successRate,
        totalTasks: result.totalTasks,
        completedTasks: result.completedTasks,
        failedTasks: result.failedTasks,
        outputDir: result.outputDir,
        reportId: result.reportId || null,
        mode: execMode,
        provider: providerType,
        duration: Date.now() - startTime,
        tasks: (result.tasks || []).map(t => ({
          id: t.id,
          title: t.title,
          status: t.status,
          qualityScore: t.qualityScore,
          toolName: t.toolName,
          privacyMode: t.privacyMode
        })),
        tokenStats: result.tokenStats || null,
        finalQuality: result.finalQuality || null,
        contractAssembly: result.contractAssembly
          ? {
            success: result.contractAssembly.success,
            language: result.contractAssembly.language,
            conflicts: result.contractAssembly.conflicts
          }
          : null
      };

      process.stderr.write(`[MCP] 任务完成: 成功率 ${result.successRate}%\n`);
      return summary;
    } catch (err) {
      this._activeTasks.set(taskId, { status: 'failed', startTime, endTime: Date.now(), error: err.message });
      process.stderr.write(`[MCP] 任务失败: ${err.message}\n`);
      throw new Error(`任务执行失败: ${err.message}`);
    }
  }

  async _toolScanTools (args) {
    const scanner = new ToolScanner({ silentScan: true, autoConfirm: true });
    scanner.registerAdapters(AdapterFactory.createAll());

    const scanResult = await scanner.scan();

    if (args.connect) {
      await scanner.connectAll();
    }

    const tools = [];
    for (const adapter of scanner.adapters) {
      tools.push({
        name: adapter.name,
        displayName: adapter.displayName,
        detected: adapter.detected,
        status: adapter.status,
        version: adapter.version,
        installPath: adapter.installPath,
        description: adapter.description
      });
    }

    return {
      total: tools.length,
      detected: tools.filter(t => t.detected).length,
      online: tools.filter(t => t.status === 'online').length,
      tools
    };
  }

  async _toolListAgents () {
    const dispatcher = new MultiAgentDispatcher({
      configDir: this.options.configDir
    });

    await dispatcher.initialize();
    const agents = await dispatcher.listAgents();

    return {
      total: agents.length,
      enabled: agents.filter(a => a.enabled).length,
      agents: agents.map(a => ({
        name: a.name,
        displayName: a.name_display || a.name,
        description: a.description,
        provider: a.provider,
        enabled: a.enabled,
        status: a.status
      }))
    };
  }

  _toolListModes () {
    const modes = this.modeManager.getAllModes();
    return {
      total: modes.length,
      currentMode: this.modeManager.getCurrentMode(),
      modes: modes.map(m => ({
        name: m.name,
        displayName: m.displayName,
        slogan: m.slogan,
        description: m.description,
        icon: m.icon,
        privacyLevel: m.privacyLevel,
        useCases: m.useCases
      }))
    };
  }

  _toolRecommendMode (args) {
    if (!args.task) {
      throw new Error('缺少必填参数: task');
    }
    const recommendation = this.modeManager.recommendMode(args.task);
    return {
      recommendedMode: recommendation.mode,
      confidence: recommendation.confidence,
      reason: recommendation.reason,
      modeDetails: this.modeManager.getModeConfig(recommendation.mode)
    };
  }

  _toolListReports (args) {
    const count = args.count || 10;
    const orchestrator = new TaskOrchestrator(null, {});
    const reports = orchestrator.listReports();

    return {
      total: reports.length,
      reports: reports.slice(0, count).map(r => ({
        id: r.id,
        date: r.date,
        task: r.task,
        successRate: r.successRate,
        totalTasks: r.totalTasks,
        keywords: r.keywords || []
      }))
    };
  }

  _toolGetReport (args) {
    if (!args.id) {
      throw new Error('缺少必填参数: id');
    }
    const orchestrator = new TaskOrchestrator(null, {});
    const report = orchestrator.loadReport(args.id);

    if (!report) {
      throw new Error(`报告 ${args.id} 不存在`);
    }

    return {
      id: report.id,
      content: report.content
    };
  }

  async _toolGetHealth () {
    // 工具健康检查
    let toolHealth = [];
    try {
      const ToolHealthChecker = require('../core/ToolHealthChecker');
      const healthChecker = new ToolHealthChecker({ timeout: 5000 });
      healthChecker.registerAdapters(AdapterFactory.createAll());
      const results = await healthChecker.checkAll();
      toolHealth = results.map(r => ({
        name: r.displayName || r.name,
        status: r.status,
        responseTime: r.responseTime,
        error: r.error
      }));
    } catch (e) {
      toolHealth = [];
    }

    // Provider 检测
    let providerStatus = [];
    try {
      const available = await ProviderFactory.detectAvailable();
      providerStatus = available.map(p => ({
        type: p.type,
        name: p.name,
        available: true
      }));
    } catch (e) {
      providerStatus = [];
    }

    const healthy = toolHealth.filter(t => t.status === 'healthy').length;
    const unhealthy = toolHealth.filter(t => t.status === 'unhealthy').length;

    return {
      tools: {
        total: toolHealth.length,
        healthy,
        unhealthy,
        details: toolHealth
      },
      providers: providerStatus,
      serverVersion: SERVER_INFO.version,
      activeTasks: this._activeTasks.size,
      timestamp: new Date().toISOString()
    };
  }

  // ═══════════════════════════════════════════
  // 资源定义
  // ═══════════════════════════════════════════

  _handleResourcesList () {
    return {
      resources: [
        {
          uri: 'qidi://config',
          name: '当前配置',
          description: 'Qidi Agent 的当前配置，包括 agents.json 内容',
          mimeType: 'application/json'
        },
        {
          uri: 'qidi://modes',
          name: '执行模式详情',
          description: '所有执行模式的完整配置详情',
          mimeType: 'application/json'
        },
        {
          uri: 'qidi://reports',
          name: '实验报告列表',
          description: '所有实验报告的摘要列表',
          mimeType: 'application/json'
        },
        {
          uri: 'qidi://tools',
          name: '已注册工具',
          description: '当前已扫描和连接的 AI 编程工具列表',
          mimeType: 'application/json'
        }
      ]
    };
  }

  _handleResourcesRead (params) {
    const { uri } = params;

    const contents = [];
    switch (uri) {
    case 'qidi://config': {
      const configPath = path.join(this.options.configDir, 'agents.json');
      let config = {};
      try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        config = JSON.parse(raw);
      } catch (e) {
        config = { error: `无法读取配置: ${e.message}` };
      }
      contents.push({
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(config, null, 2)
      });
      break;
    }
    case 'qidi://modes': {
      const modes = this.modeManager.getAllModes();
      const allModes = {};
      for (const m of modes) {
        allModes[m.name] = this.modeManager.getModeConfig(m.name);
      }
      contents.push({
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(allModes, null, 2)
      });
      break;
    }
    case 'qidi://reports': {
      const orchestrator = new TaskOrchestrator(null, {});
      const reports = orchestrator.listReports();
      contents.push({
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(reports, null, 2)
      });
      break;
    }
    case 'qidi://tools': {
      const scanner = new ToolScanner({ silentScan: true, autoConfirm: true });
      scanner.registerAdapters(AdapterFactory.createAll());
      const tools = scanner.adapters.map(a => ({
        name: a.name,
        displayName: a.displayName,
        detected: a.detected,
        status: a.status,
        version: a.version,
        description: a.description
      }));
      contents.push({
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(tools, null, 2)
      });
      break;
    }
    default:
      throw new Error(`未知资源 URI: ${uri}`);
    }

    return { contents };
  }

  // ═══════════════════════════════════════════
  // 提示模板定义
  // ═══════════════════════════════════════════

  _handlePromptsList () {
    return {
      prompts: [
        {
          name: 'task_split',
          description: '任务拆分提示模板 — 将复杂编程任务拆解为可执行的子任务',
          arguments: [
            {
              name: 'task',
              description: '要拆分的编程任务描述',
              required: true
            },
            {
              name: 'language',
              description: '目标编程语言（如 python、javascript、go）',
              required: false
            }
          ]
        },
        {
          name: 'code_review',
          description: '代码审查提示模板 — 对代码进行多维度质量审查',
          arguments: [
            {
              name: 'code',
              description: '要审查的代码内容',
              required: true
            },
            {
              name: 'language',
              description: '代码语言',
              required: false
            }
          ]
        },
        {
          name: 'multi_tool_dispatch',
          description: '多工具派发提示模板 — 指导如何将任务分发给多个 AI 工具',
          arguments: [
            {
              name: 'task',
              description: '主任务描述',
              required: true
            },
            {
              name: 'tools',
              description: '可用工具列表（逗号分隔）',
              required: false
            }
          ]
        }
      ]
    };
  }

  _handlePromptsGet (params) {
    const { name, arguments: args } = params;

    let messages = [];

    switch (name) {
    case 'task_split': {
      const task = args?.task || '未指定任务';
      const language = args?.language || '未指定';
      messages = [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `请将以下编程任务拆分为 3-10 个可执行的子任务。

任务描述: ${task}
目标语言: ${language}

要求:
1. 每个子任务有明确的标题、描述和验收标准
2. 标注子任务之间的依赖关系
3. 为每个子任务分配合适的角色（architect/code_writer/code_reviewer/tester）
4. 估算复杂度（low/medium/high）
5. 提取全局约束（语言、框架、平台等）

请以 JSON 格式输出拆分结果。`
          }
        }
      ];
      break;
    }
    case 'code_review': {
      const code = args?.code || '未提供代码';
      const language = args?.language || '未知';
      messages = [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `请对以下 ${language} 代码进行多维度质量审查。

代码:
\`\`\`${language}
${code}
\`\`\`

审查维度:
1. 正确性 — 逻辑是否正确，是否有 bug
2. 一致性 — 代码风格是否统一
3. 完整性 — 是否覆盖所有需求
4. 可读性 — 命名、注释、结构是否清晰
5. 安全性 — 是否有安全漏洞

每个维度给出 0-100 分，并给出改进建议。`
          }
        }
      ];
      break;
    }
    case 'multi_tool_dispatch': {
      const task = args?.task || '未指定任务';
      const tools = args?.tools || '未指定工具';
      messages = [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `请分析如何将以下任务分发给多个 AI 编程工具并行执行。

主任务: ${task}
可用工具: ${tools}

要求:
1. 将任务拆分为适合并行执行的模块
2. 为每个模块分配最佳工具（基于工具能力）
3. 定义模块间的接口契约
4. 说明合并策略

输出 JSON 格式的分发计划。`
          }
        }
      ];
      break;
    }
    default:
      throw new Error(`未知提示模板: ${name}`);
    }

    return { messages };
  }
}

module.exports = MCPServer;
