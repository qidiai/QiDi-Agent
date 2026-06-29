'use strict';

const React = require('react');
const { Box, Text } = require('ink');
const { useTheme } = require('../context/ThemeContext');
const { useTask } = require('../context/TaskContext');
const ProgressBar = require('./ProgressBar').default;

const StatusBar = ({ session }) => {
  const { theme, themeName } = useTheme();
  const { progress, isStreaming, streamingContent, messages } = useTask();

  // 获取最后一条消息
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;

  return (
    <Box
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      borderTopWidth={1}
      borderColor={theme.border}
      justifyContent="space-between"
    >
      {/* 左侧：模式 + 进度 */}
      <Box flexDirection="row">
        <Text color={theme.text.cyan}>
          {session && session.mode === 'privacy' ? '🔒' : '✨'} {session && session.mode || 'privacy'}
        </Text>
        <Text color="gray"> | </Text>
        <ProgressBar
          current={progress.current}
          total={progress.total}
          startTime={progress.startTime}
          width={15}
        />
        {isStreaming && (
          <Text color="cyan" blink> ●</Text>
        )}
      </Box>

      {/* 中间：流式内容预览 */}
      <Box flexGrow={1} justifyContent="center">
        {isStreaming && streamingContent && (
          <Text color="dim" italic>
            {streamingContent.substring(0, 50)}
            {streamingContent.length > 50 ? '...' : ''}
          </Text>
        )}
        {lastMessage && !isStreaming && (
          <Text color="dim">
            {lastMessage.role === 'user' ? '👤' : '🤖'}: {lastMessage.content.substring(0, 40)}
            {lastMessage.content.length > 40 ? '...' : ''}
          </Text>
        )}
      </Box>

      {/* 右侧：快捷键提示 */}
      <Box flexDirection="row">
        <Text color={theme.text.dim}>[F1] Help</Text>
        <Text color="gray"> | </Text>
        <Text color={theme.text.dim}>[Ctrl+T] Theme</Text>
        <Text color="gray"> | </Text>
        <Text color={theme.text.dim}>[Ctrl+L] Clear</Text>
      </Box>
    </Box>
  );
};

module.exports = { default: StatusBar };
