const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

/**
 * 任务调度器：负责任务状态管理、依赖调度、执行循环和重试逻辑。
 * 从 TaskOrchestrator 拆分出来，专注调度和执行顺序。
 *
 * 新增：任务暂停/恢复 + 断点续传（Checkpoint）
 */
class TaskScheduler extends EventEmitter {
  constructor (options = {}) {
    super();
    this.strictMode = options.strictMode !== false;
    this.maxRetries = options.maxRetries || 2;
    this.checkpointDir = options.checkpointDir || path.join(process.cwd(), 'checkpoints');
    // 暂停状态
    this._paused = false;
    this._resumeResolver = null;
    // 当前运行的 task 索引（用于 checkpoint）
    this._currentTaskIndex = -1;
  }

  /**
   * 执行任务循环：按依赖关系调度任务执行。
   * @param {Array} tasks - 任务列表（已初始化状态）
   * @param {Function} executeFn - 单任务执行函数 (task, context) => result
   * @param {Object} context - 项目上下文
   * @returns {Promise<void>}
   */
  async executeLoop (tasks, executeFn, context, runId = null) {
    let completedCount = 0;
    const totalCount = tasks.length;

    while (completedCount < totalCount) {
      const readyTasks = this._getReadyTasks(tasks);

      if (readyTasks.length === 0) {
        const stuckTasks = tasks.filter(t =>
          t.status === 'failed' || t.status === 'needs_revision'
        );
        if (stuckTasks.length > 0) {
          await this._handleStuckTasks(tasks, stuckTasks);
          if (stuckTasks.length >= tasks.length) {
            throw new Error(`所有任务执行失败: ${stuckTasks.map(t => t.title).join(', ')}`);
          }
          break;
        }
        break;
      }

      for (const task of readyTasks) {
        const currentIndex = tasks.indexOf(task);
        task.status = 'in_progress';
        this._currentTaskIndex = currentIndex;

        // 在执行每个任务前检查是否被暂停
        await this._waitForResume();

        this.emit('taskStart_sub', {
          task,
          index: currentIndex,
          total: totalCount,
          constraints: context.constraints || {}
        });

        try {
          const result = await executeFn(task, context);
          task.result = result;

          if (result.needsRevision) {
            context.orchestrator?.emit('taskNeedsRevision', {
              task, result, index: currentIndex, total: totalCount
            });
          } else {
            task.status = 'completed';
            completedCount++;

            context.saveToMemory?.(task, result);

            this.emit('taskComplete_sub', {
              task, result, index: currentIndex, total: totalCount
            });

            this._autoCheckpoint(runId, tasks);
          }
        } catch (error) {
          await this._handleTaskError(task, error, context);
        }
      }
    }
  }

  /**
   * 获取所有就绪的任务（依赖已满足、状态为 pending）。
   */
  _getReadyTasks (tasks) {
    return tasks.filter(task => {
      if (task.status !== 'pending' && task.status !== 'needs_revision') return false;
      if (!task.dependsOn || task.dependsOn.length === 0) return true;
      return task.dependsOn.every(depId => {
        const depTask = tasks.find(t => t.id === depId);
        return depTask && depTask.status === 'completed';
      });
    });
  }

  /**
   * 处理卡住的任务（失败/需要修订）。
   */
  async _handleStuckTasks (tasks, stuckTasks) {
    const criticalRoles = ['architect', 'code_writer'];
    const criticalFailed = stuckTasks.filter(t => criticalRoles.includes(t.role));

    if (criticalFailed.length > 0 && this.strictMode) {
      throw new Error(`核心任务执行失败: ${criticalFailed.map(t => t.title).join(', ')}`);
    }

    const nonCriticalFailed = stuckTasks.filter(t => !criticalRoles.includes(t.role));
    if (nonCriticalFailed.length > 0) {
      this.emit('nonCriticalFailed', {
        tasks: nonCriticalFailed,
        warning: '非核心任务失败，继续执行'
      });
    }

    if (criticalFailed.length > 0 && !this.strictMode) {
      this.emit('criticalFailedWarning', {
        tasks: criticalFailed,
        warning: '核心任务失败但非严格模式，继续执行（产出需人工审查）'
      });
    }
  }

  /**
   * 处理单个任务执行错误（重试或标记失败）。
   */
  async _handleTaskError (task, error, context) {
    task.retries++;
    if (task.retries <= this.maxRetries) {
      task.status = 'pending';
      this.emit('taskRetry', {
        task, attempt: task.retries, error: error.message
      });
    } else {
      task.status = 'failed';
      task.error = error.message;
      context.completedCountIncrement?.();
      this.emit('taskFailed', { task, error: error.message });
    }
  }

  /**
   * 验证所有依赖图的合法性（无缺失依赖、无循环）。
   */
  _validateAllDependencies (tasks) {
    const graph = {};
    const inDegree = {};
    for (const t of tasks) {
      graph[t.id] = t.dependsOn || [];
      inDegree[t.id] = inDegree[t.id] || 0;
      for (const dep of t.dependsOn || []) {
        if (!tasks.find(task => task.id === dep)) {
          return { valid: false, error: `依赖 ${dep} 不存在` };
        }
        inDegree[t.id]++;
      }
    }

    const visited = new Set();
    const recStack = new Set();
    for (const id of Object.keys(graph)) {
      if (!visited.has(id)) {
        const hasCycle = this._hasCycleDFS(id, graph, visited, recStack);
        if (hasCycle) return { valid: false, error: '存在循环依赖' };
      }
    }
    return { valid: true };
  }

  _hasCycleDFS (node, graph, visited, recStack) {
    visited.add(node);
    recStack.add(node);
    for (const neighbor of graph[node] || []) {
      if (!visited.has(neighbor)) {
        if (this._hasCycleDFS(neighbor, graph, visited, recStack)) return true;
      } else if (recStack.has(neighbor)) {
        return true;
      }
    }
    recStack.delete(node);
    return false;
  }

  // ═══════════════════════════════════════════
  // 暂停/恢复机制
  // ═══════════════════════════════════════════

  /**
   * 暂停当前执行循环
   * @returns {Promise<void>} 解析当 resume() 被调用时
   */
  async pause () {
    this._paused = true;
    this.emit('schedulerPaused', { taskIndex: this._currentTaskIndex });
    return new Promise((resolve) => {
      this._resumeResolver = resolve;
    });
  }

  /**
   * 恢复暂停的执行循环
   */
  resume () {
    if (this._resumeResolver) {
      this._paused = false;
      this._resumeResolver();
      this._resumeResolver = null;
      this.emit('schedulerResumed');
    }
  }

  /**
   * 检查是否已暂停
   */
  isPaused () {
    return this._paused;
  }

  /**
   * 在执行循环中等待暂停解除
   * @private
   */
  async _waitForResume () {
    if (this._paused && this._resumeResolver) {
      await this.pause();
    }
  }

  // ═══════════════════════════════════════════
  // 断点续传（Checkpoint）
  // ═══════════════════════════════════════════

  /**
   * 保存当前调度器状态到 checkpoint 文件
   * @param {string} runId - 运行 ID
   * @param {Array} tasks - 当前任务列表
   * @param {Object} extra - 额外数据
   * @returns {string} checkpoint 文件路径
   */
  saveCheckpoint (runId, tasks, extra = {}) {
    if (!fs.existsSync(this.checkpointDir)) {
      fs.mkdirSync(this.checkpointDir, { recursive: true });
    }

    const checkpoint = {
      runId,
      savedAt: new Date().toISOString(),
      currentTaskIndex: this._currentTaskIndex,
      paused: this._paused,
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        role: t.role,
        status: t.status,
        retries: t.retries || 0,
        result: t.result
          ? {
            content: t.result.content ? t.result.content.substring(0, 500) + '...' : null,
            qualityScore: t.result.quality?.qualityScore || null,
            codeBlocks: t.result.codeBlocks?.length || 0
          }
          : null,
        error: t.error || null,
        lastQualityFeedback: t.lastQualityFeedback || null,
        lastQualityScore: t.lastQualityScore || null,
        lastQualityIssues: t.lastQualityIssues || null
      })),
      completedCount: tasks.filter(t => t.status === 'completed').length,
      totalCount: tasks.length,
      ...extra
    };

    const filePath = path.join(this.checkpointDir, `${runId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), 'utf-8');
    return filePath;
  }

  /**
   * 从 checkpoint 恢复任务状态
   * @param {string} runId - 运行 ID
   * @returns {Object|null} checkpoint 数据或 null
   */
  loadCheckpoint (runId) {
    const filePath = path.join(this.checkpointDir, `${runId}.json`);
    if (!fs.existsSync(filePath)) return null;

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return data;
    } catch {
      return null;
    }
  }

  /**
   * 列出所有可用的 checkpoint
   * @returns {Array} checkpoint 列表
   */
  listCheckpoints () {
    if (!fs.existsSync(this.checkpointDir)) return [];
    return fs.readdirSync(this.checkpointDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(this.checkpointDir, f), 'utf-8'));
        return {
          runId: f.replace('.json', ''),
          savedAt: data.savedAt,
          completedCount: data.completedCount,
          totalCount: data.totalCount,
          currentTaskIndex: data.currentTaskIndex
        };
      })
      .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  }

  /**
   * 删除指定 checkpoint
   */
  deleteCheckpoint (runId) {
    const filePath = path.join(this.checkpointDir, `${runId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  /**
   * 自动 checkpoint 保存（每完成一个任务）
   * @private
   */
  _autoCheckpoint (runId, tasks) {
    if (!runId) return;
    try {
      this.saveCheckpoint(runId, tasks, { autoCheckpoint: true });
    } catch {
      // 静默失败，不影响正常执行
    }
  }

  /**
   * 清理过期 checkpoint（默认保留 7 天）
   */
  cleanOldCheckpoints (maxDays = 7) {
    if (!fs.existsSync(this.checkpointDir)) return 0;
    const cutoff = Date.now() - maxDays * 86400000;
    let removed = 0;
    for (const f of fs.readdirSync(this.checkpointDir)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(this.checkpointDir, f);
      const st = fs.statSync(fp);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        removed++;
      }
    }
    return removed;
  }
}

module.exports = TaskScheduler;
