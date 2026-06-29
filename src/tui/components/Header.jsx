'use strict';

const React = require('react');
const { Box, Text } = require('ink');
const { useTheme } = require('../context/ThemeContext');
const { useTask } = require('../context/TaskContext');

const logo = `
╔═══════════════════════════════════════════════════════════╗
║   QIQI   ████  █   █  █████  █   █   ║
║     █    █   █  █   █  █   █  █   █   ║
║     █    █████  █████  █████  █████   ║
║     █    █   █      █  █   █      █   ║
║     █    █   █      █  █   █      █   ║
╚═══════════════════════════════════════════════════════════╝
`;

const Header = ({ session }) => {
  const { theme, themeName } = useTheme();
  const { completedCount, totalCount, tasks } = useTask();

  const modeIcon = session && session.mode === 'privacy' ? '🔒' : '✨';
  const modeText = session && session.mode === 'privacy' ? 'Privacy' : 'Quality';

  return (
    <Box
      flexDirection="column"
      borderBottomWidth={1}
      borderColor={theme.border}
      paddingTop={0}
      paddingBottom={1}
    >
      {/* Logo 行 */}
      <Box>
        <Text bold color="cyan">{'{ }'}</Text>
        <Text bold color="white"> QIDI Agent </Text>
        <Text color="gray">-</Text>
        <Text color="yellow"> Ink TUI </Text>
        <Text color="gray">v1.1.0</Text>
      </Box>

      {/* 状态行 */}
      <Box flexDirection="row" marginTop={1}>
        {/* 模式 */}
        <Box marginRight={3}>
          <Text color="gray">Mode: </Text>
          <Text color={session && session.mode === 'privacy' ? 'cyan' : 'magenta'}>
            {modeIcon} {modeText}
          </Text>
        </Box>

        {/* 任务进度 */}
        <Box marginRight={3}>
          <Text color="gray">Tasks: </Text>
          <Text color="white">
            {completedCount}/{totalCount}
          </Text>
          {totalCount > 0 && (
            <Text color="gray"> ({Math.round((completedCount / totalCount) * 100)}%)</Text>
          )}
        </Box>

        {/* 提供商 */}
        <Box marginRight={3}>
          <Text color="gray">Provider: </Text>
          <Text color="green">{session && session.provider || 'ollama'}</Text>
        </Box>

        {/* 工具数量 */}
        <Box>
          <Text color="gray">Tools: </Text>
          <Text color="green">{session && session.registeredTools ? session.registeredTools.length : 0}</Text>
        </Box>
      </Box>
    </Box>
  );
};

module.exports = { default: Header };
