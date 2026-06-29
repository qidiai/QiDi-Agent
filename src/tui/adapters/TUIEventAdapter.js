'use strict';

/**
 * TUI 事件适配器
 *
 * 将 TaskOrchestrator 的 EventEmitter 事件转换为 TUI 状态更新
 */

class TUIEventAdapter {
  constructor (tuiContext) {
    this.tui = tuiContext;
    this.startTime = null;
  }

  /**
   * 附加到编排器
   */
  attach (orchestrator) {
    if (!orchestrator) return this;

    const events = {
      // 任务生命周期
      init: (d) => this.onInit(d),
      splitting: (d) => this.onSplitting(d),
      taskSplit: (d) => this.onTaskSplit(d),
      taskStart: (d) => this.onTaskStart(d),
      taskStart_sub: (d) => this.onSubtaskStart(d),
      taskComplete_sub: (d) => this.onSubtaskComplete(d),
      taskFailed: (d) => this.onTaskFailed(d),
      taskComplete: (d) => this.onTaskComplete(d),
      taskError: (d) => this.onTaskError(d),

      // 代理事件
      agentWorking: (d) => this.onAgentWorking(d),
      qualityReview: (d) => this.onQualityReview(d),

      // 工具事件
      toolSelected: (d) => this.onToolSelected(d),
      multiToolDispatch: (d) => this.onMultiToolDispatch(d),
      toolFailed: (d) => this.onToolFailed(d),
      multiToolMerged: (d) => this.onMultiToolMerged(d),

      // 流式输出
      streamStart: (d) => this.onStreamStart(d),
      streamToken: (d) => this.onStreamToken(d),
      streamEnd: (d) => this.onStreamEnd(d),

      // 报告
      reportGenerated: (d) => this.onReportGenerated(d),

      // 隐私模式
      privacyModeStart: (d) => this.onPrivacyModeStart(d),
      privacyModeComplete: (d) => this.onPrivacyModeComplete(d),

      // 契约组装
      contractAssemblyComplete: (d) => this.onContractComplete(d)
    };

    for (const [event, handler] of Object.entries(events)) {
      orchestrator.on(event, handler.bind(this));
    }

    return this;
  }

  // 初始化
  onInit (data) {
    this.startTime = Date.now();
    this.tui.emit && this.tui.emit('status', { status: 'connecting', ...data });
  }

  // 拆分中
  onSplitting (data) {
    this.tui.emit && this.tui.emit('status', { status: 'splitting', ...data });
  }

  // 任务拆分完成
  onTaskSplit (data) {
    if (this.tui.setTasks) {
      this.tui.setTasks(data.tasks || []);
    }
    if (this.tui.setOverview) {
      this.tui.setOverview(data.overview || '');
    }
    if (this.tui.setPlan) {
      this.tui.setPlan(data.plan || '');
    }
    if (this.tui.setProgress) {
      this.tui.setProgress({
        current: 0,
        total: data.tasks ? data.tasks.length : 0,
        startTime: this.startTime
      });
    }
    this.tui.emit && this.tui.emit('task:split', data);
  }

  // 任务开始
  onTaskStart (data) {
    this.tui.emit && this.tui.emit('status', { status: 'running', ...data });
  }

  // 子任务开始
  onSubtaskStart (data) {
    if (this.tui.setCurrentTask) {
      this.tui.setCurrentTask(data.task);
    }
    if (this.tui.setProgress) {
      this.tui.setProgress(prev => ({
        ...prev,
        current: (data.index || 0) + 1
      }));
    }
    this.tui.emit && this.tui.emit('subtask:start', data);
  }

  // 子任务完成
  onSubtaskComplete (data) {
    if (this.tui.updateTask && data.task && data.task.id) {
      this.tui.updateTask(data.task.id, {
        status: 'completed',
        result: data.result
      });
    }
    if (this.tui.appendCodeBlocks && data.result && data.result.codeBlocks) {
      this.tui.appendCodeBlocks(data.result.codeBlocks);
    }
    this.tui.emit && this.tui.emit('subtask:complete', data);
  }

  // 任务失败
  onTaskFailed (data) {
    if (this.tui.updateTask && data.task && data.task.id) {
      this.tui.updateTask(data.task.id, {
        status: 'failed',
        error: data.error
      });
    }
    this.tui.emit && this.tui.emit('task:failed', data);
  }

  // 任务完成
  onTaskComplete (data) {
    this.tui.emit && this.tui.emit('task:complete', data);
  }

  // 任务错误
  onTaskError (data) {
    this.tui.emit && this.tui.emit('error', data);
  }

  // Agent 工作中
  onAgentWorking (data) {
    this.tui.emit && this.tui.emit('agent:working', data);
  }

  // 质量审查
  onQualityReview (data) {
    this.tui.emit && this.tui.emit('quality:review', data);
  }

  // 工具选中
  onToolSelected (data) {
    this.tui.emit && this.tui.emit('tool:selected', data);
  }

  // 多工具派发
  onMultiToolDispatch (data) {
    this.tui.emit && this.tui.emit('tool:dispatch', data);
  }

  // 工具失败
  onToolFailed (data) {
    this.tui.emit && this.tui.emit('tool:failed', data);
  }

  // 多工具合并
  onMultiToolMerged (data) {
    this.tui.emit && this.tui.emit('tool:merged', data);
  }

  // 流式开始
  onStreamStart (data) {
    if (this.tui.startStream) {
      this.tui.startStream(data.type || 'code');
    }
    this.tui.emit && this.tui.emit('stream:start', data);
  }

  // 流式 token
  onStreamToken (data) {
    if (this.tui.appendStreamToken) {
      this.tui.appendStreamToken(data.token || '');
    }
    this.tui.emit && this.tui.emit('stream:token', data);
  }

  // 流式结束
  onStreamEnd (data) {
    if (this.tui.endStream) {
      this.tui.endStream(data);
    }
    this.tui.emit && this.tui.emit('stream:end', data);
  }

  // 报告生成
  onReportGenerated (data) {
    this.tui.emit && this.tui.emit('report:generated', data);
  }

  // 隐私模式开始
  onPrivacyModeStart (data) {
    this.tui.emit && this.tui.emit('privacy:start', data);
  }

  // 隐私模式完成
  onPrivacyModeComplete (data) {
    this.tui.emit && this.tui.emit('privacy:complete', data);
  }

  // 契约组装完成
  onContractComplete (data) {
    this.tui.emit && this.tui.emit('contract:complete', data);
  }
}

module.exports = TUIEventAdapter;
