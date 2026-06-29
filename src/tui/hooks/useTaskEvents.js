'use strict';

const React = require('react');

/**
 * 任务事件 Hook
 *
 * 订阅 TaskOrchestrator 的事件并更新 TUI 状态
 *
 * 使用方式:
 * useTaskEvents(session, orchestrator);
 */
const useTaskEvents = (session, orchestrator) => {
  const {
    setTasks,
    setCurrentTask,
    updateTask,
    appendCodeBlocks,
    setProgress,
    setOverview,
    setPlan,
    addMessage,
    startStream,
    appendStreamToken,
    endStream
  } = React.useContext(require('../context/TaskContext').TaskContext);

  React.useEffect(() => {
    if (!orchestrator) return;

    const events = {
      taskSplit: (data) => {
        setTasks(data.tasks || []);
        setOverview(data.overview || '');
        setPlan(data.plan || '');
        setProgress({
          current: 0,
          total: data.tasks ? data.tasks.length : 0,
          startTime: Date.now()
        });
      },
      taskStart_sub: (data) => {
        setCurrentTask(data.task);
        setProgress(prev => ({
          ...prev,
          current: (data.index || 0) + 1
        }));
      },
      taskComplete_sub: (data) => {
        if (data.task && data.task.id) {
          updateTask(data.task.id, {
            status: 'completed',
            result: data.result
          });
        }
        if (data.result && data.result.codeBlocks) {
          appendCodeBlocks(data.result.codeBlocks);
        }
      },
      taskFailed: (data) => {
        if (data.task && data.task.id) {
          updateTask(data.task.id, {
            status: 'failed',
            error: data.error
          });
        }
      },
      agentWorking: (data) => {
        addMessage({
          role: 'agent',
          content: `[${data.agent}] 正在生成代码...`
        });
      },
      toolSelected: (data) => {
        addMessage({
          role: 'system',
          content: `选择工具: ${data.tool}`
        });
      },
      multiToolDispatch: (data) => {
        addMessage({
          role: 'system',
          content: `派发到 ${data.tools ? data.tools.length : 0} 个工具`
        });
      },
      toolFailed: (data) => {
        addMessage({
          role: 'system',
          content: `[${data.tool}] 失败: ${data.error}`
        });
      },
      streamStart: (data) => {
        startStream(data.type || 'code');
      },
      streamToken: (data) => {
        appendStreamToken(data.token || '');
      },
      streamEnd: (data) => {
        endStream(data);
        if (data && data.codeBlocks) {
          appendCodeBlocks(data.codeBlocks);
        }
      }
    };

    // 附加事件监听
    for (const [event, handler] of Object.entries(events)) {
      orchestrator.on(event, handler);
    }

    // 清理
    return () => {
      for (const [event, handler] of Object.entries(events)) {
        orchestrator.removeListener(event, handler);
      }
    };
  }, [orchestrator, setTasks, setCurrentTask, updateTask, appendCodeBlocks, setProgress, setOverview, setPlan, addMessage, startStream, appendStreamToken, endStream]);
};

module.exports = { useTaskEvents };
