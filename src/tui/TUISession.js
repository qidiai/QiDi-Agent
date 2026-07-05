'use strict';

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ProviderFactory = require('../providers');
const TaskOrchestrator = require('../core/TaskOrchestrator');
const ToolScanner = require('../core/ToolScanner');
const AdapterFactory = require('../adapters');
const FileManager = require('../utils/FileManager');

// P0-P3 新模块
let TestRunner, MCPClient, VectorMemoryStore, BudgetManager, GitIntegration, SandboxExecutor, ApprovalWorkflow, StreamManager;
try {
  TestRunner = require('../core/TestRunner');
} catch (_) {}
try {
  MCPClient = require('../mcp/MCPClient');
} catch (_) {}
try {
  VectorMemoryStore = require('../core/VectorMemoryStore');
} catch (_) {}
try {
  BudgetManager = require('../core/BudgetManager');
} catch (_) {}
try {
  GitIntegration = require('../core/GitIntegration');
} catch (_) {}
try {
  SandboxExecutor = require('../core/SandboxExecutor');
} catch (_) {}
try {
  ApprovalWorkflow = require('../core/ApprovalWorkflow');
} catch (_) {}
try {
  StreamManager = require('../utils/StreamManager');
} catch (_) {}

/**
 * TUI 会话管理
 *
 * 管理 TUI 的状态和与 TaskOrchestrator 的交互
 */
class TUISession extends EventEmitter {
  constructor (options = {}) {
    super();

    this.workspaceDir = options.workspaceDir || './workspace';
    this.configDir = options.configDir || path.join(__dirname, '../../config');
    this.mode = options.mode || 'privacy';
    this.providerName = options.provider || process.env.MODEL_PROVIDER || 'ollama';

    // 状态
    this.provider = null;
    this.orchestrator = null;
    this.toolScanner = null;
    this.registeredTools = [];
    this.scanned = false;

    // 上下文记忆
    this.recentTasks = [];
    this.recentReportIds = [];

    // TUI 事件适配器
    this.eventAdapter = null;

    // P0-P3 模块实例（延迟初始化）
    this.testRunner = null;
    this.mcpClient = null;
    this.vectorMemory = null;
    this.budgetManager = null;
    this.gitIntegration = null;
    this.sandboxExecutor = null;
    this.approvalWorkflow = null;
    this.streamManager = null;

    // 确保目录存在
    this._ensureDirs();
  }

  /**
   * 初始化增强模块
   */
  async initEnhancedModules () {
    // TestRunner
    if (TestRunner && !this.testRunner) {
      this.testRunner = new TestRunner({ workspaceDir: this.workspaceDir });
      this.emit('module:ready', { module: 'TestRunner' });
    }

    // BudgetManager
    if (BudgetManager && !this.budgetManager) {
      this.budgetManager = new BudgetManager({ totalBudget: 200000 });
      this.budgetManager.on('alarm', (data) => this.emit('budget:alarm', data));
      this.budgetManager.on('critical', (data) => this.emit('budget:critical', data));
    }

    // GitIntegration
    if (GitIntegration && !this.gitIntegration) {
      this.gitIntegration = new GitIntegration({ workspaceDir: this.workspaceDir });
      if (this.gitIntegration.isEnabled()) {
        this.emit('git:ready', { branch: this.gitIntegration.getCurrentBranch() });
      }
    }

    // SandboxExecutor
    if (SandboxExecutor && !this.sandboxExecutor) {
      this.sandboxExecutor = new SandboxExecutor({ workspaceDir: this.workspaceDir, level: 'process' });
    }

    // ApprovalWorkflow
    if (ApprovalWorkflow && !this.approvalWorkflow) {
      this.approvalWorkflow = new ApprovalWorkflow({});
      this.approvalWorkflow.on('approvalRequested', (req) => this.emit('approval:requested', req));
    }

    // StreamManager
    if (StreamManager && !this.streamManager) {
      this.streamManager = new StreamManager();
    }

    // VectorMemoryStore
    if (VectorMemoryStore && !this.vectorMemory) {
      this.vectorMemory = new VectorMemoryStore({});
    }

    // MCPClient
    if (MCPClient && !this.mcpClient) {
      this.mcpClient = new MCPClient({});
      try {
        await this.mcpClient.loadFromConfig();
      } catch (_) {}
    }
  }

  _ensureDirs () {
    try {
      if (!fs.existsSync(this.workspaceDir)) {
        fs.mkdirSync(this.workspaceDir, { recursive: true });
      }
    } catch (e) {
      // ignore
    }
  }

  /**
   * 启动会话
   */
  async start () {
    this.emit('start', { mode: this.mode });
    return this;
  }

  /**
   * 扫描工具
   */
  async scan () {
    if (this.scanned) return this.registeredTools;

    this.emit('scan:start');

    try {
      this.toolScanner = new ToolScanner();
      this.toolScanner.registerAdapters(AdapterFactory.createAll());
      await this.toolScanner.scan();
      await this.toolScanner.connectAll();
      this.registeredTools = Array.from(this.toolScanner.registeredTools.values());
      this.scanned = true;

      this.emit('scan:complete', { tools: this.registeredTools });
      return this.registeredTools;
    } catch (err) {
      this.emit('scan:error', { error: err.message });
      throw err;
    }
  }

  /**
   * 连接 Provider
   */
  async connectProvider () {
    if (this.provider) return this.provider;

    this.emit('provider:connecting', { provider: this.providerName });

    try {
      this.provider = ProviderFactory.create(this.providerName);
      const connected = await this.provider.checkConnection();

      if (connected) {
        this.emit('provider:connected', { provider: this.provider });
        return this.provider;
      } else {
        throw new Error(`Provider ${this.providerName} connection failed`);
      }
    } catch (err) {
      this.emit('provider:error', { error: err.message });
      throw err;
    }
  }

  /**
   * 运行任务
   * @param {string} taskDescription - 任务描述
   */
  async run (taskDescription) {
    if (!taskDescription) return null;

    this.emit('task:start', { description: taskDescription, mode: this.mode });

    try {
      // 确保 Provider 已连接
      await this.connectProvider();

      // 如果需要，自动扫描工具
      if (!this.scanned) {
        try {
          await this.scan();
        } catch (e) {
          // 工具扫描失败不影响任务执行
          this.emit('scan:skipped', { reason: e.message });
        }
      }

      // 初始化增强模块
      await this.initEnhancedModules();

      // 创建编排器
      this.orchestrator = new TaskOrchestrator(this.provider, {
        workspaceDir: this.workspaceDir,
        toolAdapters: this.registeredTools,
        executionMode: this.mode,
        testRunner: this.testRunner,
        budgetManager: this.budgetManager,
        gitIntegration: this.gitIntegration,
        sandboxExecutor: this.sandboxExecutor,
        approvalWorkflow: this.approvalWorkflow,
        streamManager: this.streamManager,
        vectorMemory: this.vectorMemory
      });

      // 附加 TUI 事件适配器
      this._attachEventAdapter();

      // 初始化
      await this.orchestrator.initialize();

      // 运行任务
      const result = await this.orchestrator.runTask(taskDescription);

      // 更新记忆
      this.recentTasks.push({
        task: taskDescription,
        success: result.successRate === 100,
        successRate: result.successRate,
        outputDir: result.outputDir,
        reportId: result.reportId,
        ts: Date.now()
      });

      // 保持最多20条
      if (this.recentTasks.length > 20) {
        this.recentTasks = this.recentTasks.slice(-20);
      }

      if (result.reportId) {
        this.recentReportIds.push(result.reportId);
        if (this.recentReportIds.length > 20) {
          this.recentReportIds = this.recentReportIds.slice(-20);
        }
      }

      this.emit('task:complete', result);
      return result;
    } catch (err) {
      this.emit('task:error', { error: err.message, task: taskDescription });
      throw err;
    }
  }

  /**
   * 附加 TUI 事件适配器
   */
  _attachEventAdapter () {
    if (!this.orchestrator) return;

    // 转发所有事件到 TUI
    const events = [
      'init', 'splitting', 'taskSplit',
      'taskStart', 'taskStart_sub', 'taskComplete_sub', 'taskFailed',
      'taskComplete', 'taskError',
      'agentWorking', 'qualityReview',
      'toolSelected', 'multiToolDispatch', 'toolFailed', 'multiToolMerged',
      'streamStart', 'streamToken', 'streamEnd',
      'reportGenerated',
      'privacyModeStart', 'privacyModeComplete',
      'contractAssemblyComplete'
    ];

    for (const event of events) {
      this.orchestrator.on(event, (data) => {
        this.emit(event, data);
      });
    }
  }

  /**
   * 切换模式
   */
  setMode (mode) {
    if (mode !== 'privacy' && mode !== 'quality') {
      throw new Error(`Invalid mode: ${mode}. Use 'privacy' or 'quality'`);
    }
    this.mode = mode;
    if (this.orchestrator) {
      this.orchestrator.setExecutionMode(mode);
    }
    this.emit('mode:changed', { mode });
  }

  /**
   * 切换 Provider
   */
  async setProvider (providerName) {
    this.providerName = providerName;
    this.provider = null; // 触发重连

    if (this.orchestrator) {
      await this.connectProvider();
      this.orchestrator.updateProvider(this.provider);
    }

    this.emit('provider:changed', { provider: providerName });
  }

  /**
   * 保存 checkpoint
   */
  saveCheckpoint () {
    if (this.orchestrator && this.orchestrator.saveCheckpoint) {
      return this.orchestrator.saveCheckpoint();
    }
    return null;
  }

  /**
   * 重置上下文
   */
  resetContext () {
    this.recentTasks = [];
    this.recentReportIds = [];
    this.emit('context:reset');
  }

  /**
   * 获取状态
   */
  getStatus () {
    return {
      mode: this.mode,
      provider: this.providerName,
      providerConnected: !!this.provider,
      toolsScanned: this.scanned,
      toolsCount: this.registeredTools.length,
      recentTasksCount: this.recentTasks.length,
      recentReportsCount: this.recentReportIds.length,
      // 增强模块状态
      testRunner: this.testRunner ? 'ready' : 'unavailable',
      budget: this.budgetManager ? this.budgetManager.generateReport() : null,
      git: this.gitIntegration
        ? {
          enabled: this.gitIntegration.isEnabled(),
          branch: this.gitIntegration.getCurrentBranch()
        }
        : null,
      sandbox: this.sandboxExecutor ? this.sandboxExecutor.getStatus() : null,
      approvals: this.approvalWorkflow ? this.approvalWorkflow.getStats() : null,
      vectorMemory: this.vectorMemory ? this.vectorMemory.getStats() : null,
      mcpServers: this.mcpClient ? this.mcpClient.getStatus() : []
    };
  }

  /**
   * 获取预算报告
   */
  getBudgetReport () {
    return this.budgetManager ? this.budgetManager.generateReport() : null;
  }

  /**
   * 审批操作
   */
  approve (approvalId, comment = '') {
    return this.approvalWorkflow ? this.approvalWorkflow.approve(approvalId, 'tui-user', comment) : false;
  }

  rejectApproval (approvalId, comment = '') {
    return this.approvalWorkflow ? this.approvalWorkflow.reject(approvalId, 'tui-user', comment) : false;
  }

  /**
   * Git 操作
   */
  gitStatus () {
    return this.gitIntegration
      ? {
        branch: this.gitIntegration.getCurrentBranch(),
        changedFiles: this.gitIntegration.getChangedFiles(),
        log: this.gitIntegration.getLog(10)
      }
      : null;
  }

  /**
   * 回滚
   */
  rollback (commitHash = null) {
    return this.gitIntegration ? this.gitIntegration.rollback(commitHash) : false;
  }
}

module.exports = TUISession;
