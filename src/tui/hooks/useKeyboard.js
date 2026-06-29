'use strict';

const React = require('react');

/**
 * 键盘事件 Hook
 *
 * 使用方式:
 * const { onCtrlS, onCtrlL } = useKeyboard({
 *   onCtrlS: () => save(),
 *   onCtrlL: () => clear(),
 *   onTab: () => autocomplete()
 * });
 */

const keyMap = {
  '\u0003': 'ctrlC',     // Ctrl+C
  '\r': 'enter',         // Enter
  '\n': 'enter',         // Enter (Unix)
  '\u0013': 'ctrlS',     // Ctrl+S
  '\u0012': 'ctrlR',     // Ctrl+R
  '\u0015': 'ctrlU',     // Ctrl+U
  '\u000C': 'ctrlL',     // Ctrl+L
  '\t': 'tab',           // Tab
  '\u001B': 'escape',    // Escape
  '\u001B[A': 'arrowUp',   // 上箭头
  '\u001B[B': 'arrowDown', // 下箭头
  '\u001B[C': 'arrowRight', // 右箭头
  '\u001B[D': 'arrowLeft',  // 左箭头
  '\u001BOP': 'f1',      // F1
  '\u001BOQ': 'f2',      // F2
  '\u001BOR': 'f3',       // F3
  '\u001BOS': 'f4',       // F4
  '\u001B[15~': 'f5',    // F5
  '\u001B[17~': 'f6',    // F6
  '\u001B[18~': 'f7',    // F7
  '\u001B[19~': 'f8',    // F8
  '\u001B[20~': 'f9',    // F9
  '\u001B[21~': 'f10',   // F10
  '\u001B[23~': 'f11',   // F11
  '\u001B[24~': 'f12'    // F12
};

// 特殊组合键的转义序列
const specialSequences = [
  Buffer.from('1B5B415', 'hex').toString(),  // \u001B[A - 上箭头
  Buffer.from('1B5B425', 'hex').toString(),  // \u001B[B - 下箭头
  Buffer.from('1B5B435', 'hex').toString(),  // \u001B[C - 右箭头
  Buffer.from('1B5B445', 'hex').toString(),  // \u001B[D - 左箭头
  Buffer.from('1B4F50', 'hex').toString(),  // \u001BOP - F1
  Buffer.from('1B4F51', 'hex').toString(),  // \u001BOQ - F2
  Buffer.from('1B4F52', 'hex').toString(),  // \u001BOR - F3
  Buffer.from('1B4F53', 'hex').toString()   // \u001BOS - F4
];

const useKeyboard = (handlers = {}) => {
  const handlersRef = React.useRef(handlers);

  // 更新 handlers ref
  React.useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  React.useEffect(() => {
    let buffer = '';
    let bufferTimeout = null;

    const handleKeyPress = (chunk) => {
      const key = chunk.toString();
      buffer += key;

      // 清除之前的超时
      if (bufferTimeout) {
        clearTimeout(bufferTimeout);
      }

      // 设置超时清除缓冲区
      bufferTimeout = setTimeout(() => {
        buffer = '';
      }, 100);

      // 优先检查特殊序列
      for (const seq of specialSequences) {
        if (buffer.includes(seq)) {
          const action = keyMap[seq];
          if (action && handlersRef.current[action]) {
            handlersRef.current[action](key);
          }
          buffer = '';
          return;
        }
      }

      // 检查完整匹配
      if (keyMap[buffer]) {
        const action = keyMap[buffer];
        if (action && handlersRef.current[action]) {
          handlersRef.current[action](buffer);
        }
        buffer = '';
        return;
      }

      // 未知键，检查是否有 onKey 处理器
      if (handlersRef.current.onKey) {
        handlersRef.current.onKey(key);
      }

      buffer = '';
    };

    // 设置 raw mode
    if (typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on('data', handleKeyPress);

    return () => {
      if (bufferTimeout) {
        clearTimeout(bufferTimeout);
      }
      process.stdin.removeListener('data', handleKeyPress);
    };
  }, []);
};

module.exports = { useKeyboard };
