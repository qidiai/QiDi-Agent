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

    // 确保目录存在
    this._ensureDirs();
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

      // 创建编排器
      this.orchestrator = new TaskOrchestrator(this.provider, {
        workspaceDir: this.workspaceDir,
        toolAdapters: this.registeredTools,
        executionMode: this.mode
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
      recentReportsCount: this.recentReportIds.length
    };
  }
}

module.exports = TUISession;
