/**
 * @module ToolExecutor
 * 
 * 工具执行器 - 统一执行层的核心组件。
 * 负责管理所有 ToolAdapter 实例，选择最佳工具执行任务，
 * 处理并发控制、超时、错误重试，收集执行结果。
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

/**
 * 工具执行器类
 */
class ToolExecutor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.maxConcurrent = options.maxConcurrent || 3;
    this.defaultTimeout = options.defaultTimeout || 120000; // 2分钟
    this.maxRetries = options.maxRetries || 2;
    
    this.adapters = new Map(); // toolName -> adapter
    this.executionHistory = [];
    this.toolStatus = new Map(); // toolName -> status
  }

  /**
   * 注册工具适配器
   */
  registerAdapter(adapter) {
    if (!adapter || !adapter.name) {
      throw new Error('无效的适配器');
    }
    
    this.adapters.set(adapter.name, adapter);
    this.toolStatus.set(adapter.name, {
      registered: true,
      available: adapter.isAvailable ? adapter.isAvailable() : true,
      lastUsed: null,
      successCount: 0,
      failCount: 0
    });
    
    this.emit('adapterRegistered', { name: adapter.name, adapter });
    return this;
  }

  /**
   * 批量注册适配器
   */
  registerAdapters(adapters) {
    for (const adapter of adapters) {
      this.registerAdapter(adapter);
    }
    return this;
  }

  /**
   * 执行单个任务
   * @param {Object} subtask - 子任务
   * @param {Object} options - 执行选项
   * @returns {Promise<Object>} 执行结果
   */
  async executeTask(subtask, options = {}) {
    const {
      preferredTools = null,    // 优先使用的工具列表
      fallbackEnabled = true,  // 是否启用降级
      timeout = this.defaultTimeout,
      workspace = this.workspaceDir
    } = options;

    // 1. 选择最佳工具
    const selectedTool = this.selectBestTool(subtask, preferredTools);
    
    if (!selectedTool) {
      return {
        success: false,
        error: '没有可用的工具',
        tool: null,
        subtask: subtask.id
      };
    }

    // 2. 获取适配器
    const adapter = this.adapters.get(selectedTool);
    if (!adapter) {
      return {
        success: false,
        error: `工具 ${selectedTool} 的适配器未找到`,
        tool: selectedTool,
        subtask: subtask.id
      };
    }

    // 3. 检查工具是否可用
    if (adapter.isAvailable && !adapter.isAvailable()) {
      if (fallbackEnabled) {
        this.emit('toolUnavailable', { tool: selectedTool, reason: '工具不可用' });
        return this._fallbackExecute(subtask, options, selectedTool);
      }
      return {
        success: false,
        error: `工具 ${selectedTool} 不可用`,
        tool: selectedTool,
        subtask: subtask.id
      };
    }

    // 4. 执行任务
    return await this._executeWithAdapter(adapter, subtask, {
      timeout,
      workspace
    });
  }

  /**
   * 使用指定适配器执行任务
   */
  async _executeWithAdapter(adapter, subtask, options) {
    const startTime = Date.now();
    const { timeout = this.defaultTimeout, workspace = this.workspaceDir } = options;
    
    let result = {
      success: false,
      tool: adapter.name,
      subtask: subtask.id,
      startTime,
      endTime: null,
      duration: null,
      output: '',
      error: null,
      generatedFiles: [],
      retryCount: 0
    };

    // 执行前扫描文件
    const filesBefore = this._scanWorkspace(workspace);

    try {
      this.emit('executionStart', {
        tool: adapter.name,
        subtask: subtask.id,
        title: subtask.title
      });

      // 调用适配器的 execute 方法
      const execResult = await this._executeWithTimeout(
        adapter,
        subtask,
        { timeout, workspace }
      );

      result.success = execResult.success !== false;
      result.output = execResult.stdout || execResult.content || '';
      result.error = execResult.stderr || execResult.error || null;

      // 执行后扫描文件
      const filesAfter = this._scanWorkspace(workspace);
      result.generatedFiles = this._diffFiles(filesBefore, filesAfter);

      // 更新工具状态
      this._updateToolStatus(adapter.name, result.success);

      this.emit('executionComplete', {
        tool: adapter.name,
        subtask: subtask.id,
        success: result.success,
        duration: result.duration
      });

    } catch (e) {
      result.error = e.message;
      result.success = false;
      this._updateToolStatus(adapter.name, false);
      
      this.emit('executionError', {
        tool: adapter.name,
        subtask: subtask.id,
        error: e.message
      });
    }

    result.endTime = Date.now();
    result.duration = result.endTime - result.startTime;
    
    // 记录历史
    this.executionHistory.push(result);
    
    return result;
  }

  /**
   * 带超时的执行
   */
  _executeWithTimeout(adapter, subtask, options) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`执行超时 (${options.timeout}ms)`));
      }, options.timeout);

      Promise.resolve(adapter.execute(this._buildTaskDescription(subtask), {
        taskId: subtask.id,
        workspaceDir: options.workspace,
        timeout: options.timeout
      }))
      .then(result => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch(e => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  /**
   * 构建任务描述
   */
  _buildTaskDescription(subtask) {
    const parts = [];
    
    if (subtask.title) {
      parts.push(`## 任务: ${subtask.title}`);
    }
    
    if (subtask.description) {
      parts.push(`\n${subtask.description}`);
    }
    
    if (subtask.acceptanceCriteria) {
      parts.push(`\n### 验收标准\n${subtask.acceptanceCriteria}`);
    }
    
    if (subtask.constraints) {
      parts.push(`\n### 约束\n${JSON.stringify(subtask.constraints, null, 2)}`);
    }
    
    return parts.join('\n');
  }

  /**
   * 降级执行：当首选工具不可用时
   */
  async _fallbackExecute(subtask, options, excludedTool) {
    const availableTools = this.getAvailableTools();
    const fallbackTools = availableTools.filter(t => t !== excludedTool);
    
    if (fallbackTools.length === 0) {
      return {
        success: false,
        error: '没有可用的降级工具',
        tool: null,
        subtask: subtask.id
      };
    }

    // 尝试下一个最佳工具
    const nextTool = fallbackTools[0];
    const adapter = this.adapters.get(nextTool);
    
    this.emit('fallback', {
      original: excludedTool,
      fallback: nextTool,
      subtask: subtask.id
    });

    return await this._executeWithAdapter(adapter, subtask, {
      timeout: options.timeout,
      workspace: options.workspace
    });
  }

  /**
   * 多工具并行执行
   */
  async executeWithTools(tasks, toolNames, options = {}) {
    const {
      mode = 'parallel',      // parallel | sequential | select
      timeout = this.defaultTimeout,
      workspace = this.workspaceDir
    } = options;

    const results = [];

    if (mode === 'parallel') {
      // 并行执行
      const promises = toolNames.map(toolName => {
        const adapter = this.adapters.get(toolName);
        if (!adapter) return Promise.resolve({ tool: toolName, success: false, error: '适配器未找到' });
        return this._executeWithAdapter(adapter, tasks[0], { timeout, workspace });
      });

      const settled = await Promise.allSettled(promises);
      for (let i = 0; i < settled.length; i++) {
        if (settled[i].status === 'fulfilled') {
          results.push({ tool: toolNames[i], ...settled[i].value });
        } else {
          results.push({ tool: toolNames[i], success: false, error: settled[i].reason?.message });
        }
      }

    } else if (mode === 'sequential') {
      // 顺序执行
      for (const toolName of toolNames) {
        const adapter = this.adapters.get(toolName);
        if (!adapter) {
          results.push({ tool: toolName, success: false, error: '适配器未找到' });
          continue;
        }
        
        const result = await this._executeWithAdapter(adapter, tasks[0], { timeout, workspace });
        results.push({ tool: toolName, ...result });
        
        // 如果成功则停止
        if (result.success) break;
      }

    } else if (mode === 'select') {
      // 选择最佳结果
      const promises = toolNames.map(toolName => {
        const adapter = this.adapters.get(toolName);
        if (!adapter) return Promise.resolve({ tool: toolName, success: false, error: '适配器未找到' });
        return this._executeWithAdapter(adapter, tasks[0], { timeout, workspace });
      });

      const settled = await Promise.allSettled(promises);
      let bestResult = null;
      let bestScore = -1;

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i].status === 'fulfilled' ? settled[i].value : { tool: toolNames[i], success: false, error: settled[i].reason?.message };
        const score = this._scoreResult(result);
        
        if (score > bestScore) {
          bestScore = score;
          bestResult = result;
        }
        results.push(result);
      }

      return { results, bestResult, bestScore };

    }

    return { results };
  }

  /**
   * 选择最佳工具
   */
  selectBestTool(subtask, preferredTools = null) {
    const availableTools = this.getAvailableTools();
    
    if (availableTools.length === 0) return null;

    // 如果有优先列表且有可用的
    if (preferredTools && preferredTools.length > 0) {
      const preferred = preferredTools.find(t => availableTools.includes(t));
      if (preferred) return preferred;
    }

    // 根据子任务特性选择
    const complexity = subtask.estimatedComplexity || 'medium';
    const role = subtask.role;

    // 简单任务用轻量工具
    if (complexity === 'low' || role === 'architect') {
      const lightweight = availableTools.find(t => 
        ['qoder', 'opencode', 'atomcode', 'mimocode'].includes(t)
      );
      if (lightweight) return lightweight;
    }

    // 复杂任务用强大工具
    if (complexity === 'high') {
      const powerful = availableTools.find(t =>
        ['claudecode', 'openclaw', 'hermesagent'].includes(t)
      );
      if (powerful) return powerful;
    }

    // 默认返回第一个可用的
    return availableTools[0];
  }

  /**
   * 获取所有可用的工具
   */
  getAvailableTools() {
    const available = [];
    
    for (const [name, adapter] of this.adapters) {
      if (adapter.isAvailable && adapter.isAvailable()) {
        const status = this.toolStatus.get(name);
        if (status && status.available) {
          available.push(name);
        }
      }
    }
    
    return available;
  }

  /**
   * 获取所有已注册的工具
   */
  getRegisteredTools() {
    return Array.from(this.adapters.keys());
  }

  /**
   * 获取工具状态
   */
  getToolStatus() {
    const status = {};
    
    for (const [name, info] of this.toolStatus) {
      const adapter = this.adapters.get(name);
      status[name] = {
        ...info,
        available: adapter?.isAvailable ? adapter.isAvailable() : true,
        adapter: adapter ? adapter.displayName || name : null
      };
    }
    
    return status;
  }

  /**
   * 更新工具状态
   */
  _updateToolStatus(toolName, success) {
    const status = this.toolStatus.get(toolName);
    if (status) {
      status.lastUsed = new Date().toISOString();
      if (success) {
        status.successCount++;
      } else {
        status.failCount++;
      }
    }
  }

  /**
   * 扫描工作目录
   */
  _scanWorkspace(workspaceDir) {
    const files = new Map();
    
    try {
      const scanDir = (dir, basePath = '') => {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const item of items) {
          const fullPath = path.join(dir, item.name);
          const relativePath = path.join(basePath, item.name);
          
          // 跳过 node_modules 和隐藏目录
          if (item.name === 'node_modules' || item.name.startsWith('.')) continue;
          
          if (item.isDirectory()) {
            scanDir(fullPath, relativePath);
          } else {
            try {
              const stat = fs.statSync(fullPath);
              files.set(relativePath, {
                size: stat.size,
                mtime: stat.mtime.getTime()
              });
            } catch (e) {}
          }
        }
      };
      
      scanDir(workspaceDir);
    } catch (e) {}
    
    return files;
  }

  /**
   * 对比文件差异
   */
  _diffFiles(before, after) {
    const diff = [];
    
    for (const [filePath, afterInfo] of after) {
      const beforeInfo = before.get(filePath);
      
      // 新文件或修改的文件
      if (!beforeInfo || afterInfo.mtime > beforeInfo.mtime) {
        diff.push({
          path: filePath,
          status: beforeInfo ? 'modified' : 'added',
          size: afterInfo.size
        });
      }
    }
    
    return diff;
  }

  /**
   * 评分结果
   */
  _scoreResult(result) {
    if (!result.success) return 0;
    
    let score = 50; // 基础分
    
    // 成功加30分
    score += 30;
    
    // 有输出加10分
    if (result.output && result.output.length > 100) score += 10;
    
    // 有生成文件加10分
    if (result.generatedFiles && result.generatedFiles.length > 0) score += 10;
    
    return score;
  }

  /**
   * 获取执行历史
   */
  getExecutionHistory(count = 10) {
    return this.executionHistory.slice(-count);
  }

  /**
   * 清除执行历史
   */
  clearHistory() {
    this.executionHistory = [];
  }
}

module.exports = ToolExecutor;
