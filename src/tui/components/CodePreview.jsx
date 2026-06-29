'use strict';

const React = require('react');
const { Box, Text } = require('ink');
const { useTheme } = require('../context/ThemeContext');
const { useTask } = require('../context/TaskContext');
const { useKeyboard } = require('../hooks/useKeyboard');
const StreamOutput = require('./StreamOutput').default;
const CodeBlock = require('./CodeBlock').default;

const CodePreview = () => {
  const { theme } = useTheme();
  const {
    codeBlocks,
    selectedFileIndex,
    setSelectedFileIndex,
    streamingContent,
    isStreaming
  } = useTask();

  // 键盘选择文件
  useKeyboard({
    onArrowUp: () => setSelectedFileIndex(Math.max(0, selectedFileIndex - 1)),
    onArrowDown: () => setSelectedFileIndex(Math.min(codeBlocks.length - 1, selectedFileIndex + 1))
  });

  // 空状态
  if (codeBlocks.length === 0 && !isStreaming) {
    return (
      <Box flexDirection="column" padding={1} justifyContent="center" alignItems="center" flexGrow={1}>
        <Text dimColor>No output yet</Text>
        <Text dimColor>Task output will appear here</Text>
      </Box>
    );
  }

  // 流式输出
  if (isStreaming) {
    return (
      <Box flexDirection="column" padding={1} flexGrow={1}>
        <StreamOutput content={streamingContent} />
      </Box>
    );
  }

  // 文件列表
  const currentFile = codeBlocks[selectedFileIndex];

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* 文件标签 */}
      <Box flexDirection="column" padding={1} borderBottomWidth={1} borderColor={theme.border}>
        <Text dimColor>Files:</Text>
        {codeBlocks.map((file, i) => (
          <Text
            key={i}
            color={i === selectedFileIndex ? 'cyan' : 'dim'}
            bold={i === selectedFileIndex}
          >
            {i === selectedFileIndex ? '> ' : '  '}
            {file.path || `file_${i + 1}`}
            {file.language && ` [${file.language}]`}
          </Text>
        ))}
      </Box>

      {/* 代码内容 */}
      <Box flexDirection="column" padding={1} flexGrow={1}>
        {currentFile ? (
          <CodeBlock
            code={currentFile.code}
            language={currentFile.language || 'plaintext'}
          />
        ) : (
          <Text dimColor>Select a file to view</Text>
        )}
      </Box>
    </Box>
  );
};

module.exports = { default: CodePreview };
