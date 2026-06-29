'use strict';

const React = require('react');

/**
 * 流式输出 Hook
 *
 * 使用方式:
 * const { content, isStreaming, start, append, end, clear } = useStream();
 */
const useStream = () => {
  const [content, setContent] = React.useState('');
  const [isStreaming, setIsStreaming] = React.useState(false);
  const [buffer, setBuffer] = React.useState('');

  // 开始流式
  const start = React.useCallback((type = 'code') => {
    setContent('');
    setBuffer('');
    setIsStreaming(true);
  }, []);

  // 追加 token
  const append = React.useCallback((token) => {
    if (!token) return;
    setContent(prev => prev + token);
    setBuffer(prev => prev + token);
  }, []);

  // 结束流式
  const end = React.useCallback((finalData) => {
    setIsStreaming(false);
    setBuffer('');
    // 如果有最终数据，可以在回调中处理
  }, []);

  // 清空
  const clear = React.useCallback(() => {
    setContent('');
    setBuffer('');
    setIsStreaming(false);
  }, []);

  // 刷新（用于批量更新）
  const flush = React.useCallback(() => {
    setContent(buffer);
  }, [buffer]);

  return {
    content,
    isStreaming,
    start,
    append,
    end,
    clear,
    flush
  };
};

module.exports = { useStream };
