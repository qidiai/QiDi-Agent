'use strict';

const React = require('react');
const { Box, Text } = require('ink');
const { useTheme } = require('../context/ThemeContext');

const StreamOutput = ({ content }) => {
  const { theme } = useTheme();

  // 简单的 ANSI 去除和渲染
  const lines = content.split('\n');
  const displayLines = lines.slice(-50); // 只显示最后50行

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {/* 流式状态指示器 */}
      <Box marginBottom={1}>
        <Text color="cyan" italic>● Streaming...</Text>
      </Box>

      {/* 内容 */}
      <Box flexDirection="column" flexGrow={1}>
        {displayLines.map((line, i) => (
          <Text
            key={i}
            color={theme.text.normal}
            wrap="wrap"
          >
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
};

module.exports = { default: StreamOutput };
