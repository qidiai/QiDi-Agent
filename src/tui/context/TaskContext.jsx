'use strict';

const React = require('react');

const TaskContext = React.createContext({
  tasks: [],
  currentTask: null,
  completedCount: 0,
  totalCount: 0,
  codeBlocks: [],
  selectedFileIndex: 0,
  streamingContent: '',
  isStreaming: false,
  progress: { current: 0, total: 0, startTime: null },
  overview: '',
  plan: '',
  messages: [],
  setTasks: () => {},
  setCurrentTask: () => {},
  updateTask: () => {},
  appendCodeBlocks: () => {},
  setProgress: () => {},
  setOverview: () => {},
  setPlan: () => {},
  setMessages: () => {},
  addMessage: () => {},
  startStream: () => {},
  appendStreamToken: () => {},
  endStream: () => {},
  setSelectedFileIndex: () => {},
  reset: () => {}
});

const useTask = () => React.useContext(TaskContext);

const TaskProvider = ({ children }) => {
  const [tasks, setTasks] = React.useState([]);
  const [currentTask, setCurrentTask] = React.useState(null);
  const [codeBlocks, setCodeBlocks] = React.useState([]);
  const [selectedFileIndex, setSelectedFileIndex] = React.useState(0);
  const [streamingContent, setStreamingContent] = React.useState('');
  const [isStreaming, setIsStreaming] = React.useState(false);
  const [progress, setProgress] = React.useState({ current: 0, total: 0, startTime: null });
  const [overview, setOverview] = React.useState('');
  const [plan, setPlan] = React.useState('');
  const [messages, setMessages] = React.useState([]);

  const completedCount = React.useMemo(
    () => tasks.filter(t => t.status === 'completed').length,
    [tasks]
  );
  const totalCount = tasks.length;

  const updateTask = React.useCallback((id, updates) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
  }, []);

  const appendCodeBlocks = React.useCallback((blocks) => {
    if (!blocks || !Array.isArray(blocks)) return;
    setCodeBlocks(prev => [...prev, ...blocks]);
  }, []);

  const addMessage = React.useCallback((msg) => {
    setMessages(prev => [...prev, { ...msg, ts: Date.now() }]);
  }, []);

  const startStream = React.useCallback((type = 'code') => {
    setIsStreaming(true);
    setStreamingContent('');
  }, []);

  const appendStreamToken = React.useCallback((token) => {
    setStreamingContent(prev => prev + token);
  }, []);

  const endStream = React.useCallback((data) => {
    setIsStreaming(false);
    setStreamingContent('');
    if (data && data.codeBlocks) {
      appendCodeBlocks(data.codeBlocks);
    }
  }, [appendCodeBlocks]);

  const reset = React.useCallback(() => {
    setTasks([]);
    setCurrentTask(null);
    setCodeBlocks([]);
    setSelectedFileIndex(0);
    setStreamingContent('');
    setIsStreaming(false);
    setProgress({ current: 0, total: 0, startTime: null });
    setOverview('');
    setPlan('');
    setMessages([]);
  }, []);

  const value = React.useMemo(() => ({
    tasks,
    currentTask,
    completedCount,
    totalCount,
    codeBlocks,
    selectedFileIndex,
    streamingContent,
    isStreaming,
    progress,
    overview,
    plan,
    messages,
    setTasks,
    setCurrentTask,
    updateTask,
    appendCodeBlocks,
    setProgress,
    setOverview,
    setPlan,
    setMessages,
    addMessage,
    startStream,
    appendStreamToken,
    endStream,
    setSelectedFileIndex,
    reset
  }), [
    tasks, currentTask, completedCount, totalCount, codeBlocks,
    selectedFileIndex, streamingContent, isStreaming, progress,
    overview, plan, messages, setTasks, setCurrentTask, updateTask,
    appendCodeBlocks, setProgress, setOverview, setPlan, setMessages,
    addMessage, startStream, appendStreamToken, endStream, reset
  ]);

  return (
    <TaskContext.Provider value={value}>
      {children}
    </TaskContext.Provider>
  );
};

module.exports = { TaskContext, TaskProvider, useTask };
