'use strict';

const React = require('react');
const { Box, Text } = require('ink');
const { useTheme } = require('../context/ThemeContext');

const statusIcons = {
  pending: '○',
  running: '◐',
  completed: '●',
  failed: '✗',
  paused: '⏸'
};

const statusColors = {
  pending: 'dim',
  running: 'cyan',
  completed: 'green',
  failed: 'red',
  paused: 'yellow'
};

const TaskItem = ({ task, index, isActive }) => {
  const { theme } = useTheme();
  const statusColor = statusColors[task.status] || 'dim';
  const icon = statusIcons[task.status] || '○';

  return (
    <Box
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
    >
      {/* 状态图标 */}
      <Text color={statusColor}>
        {icon}
      </Text>

      {/* 序号 */}
      <Text color={theme.text.dim} width={3}>
        {String(index + 1).padStart(2, ' ')}.
      </Text>

      {/* 任务标题 */}
      <Text
        color={isActive ? theme.text.cyan : theme.text.normal}
        bold={isActive}
        flexGrow={1}
      >
        {task.title || task.id}
      </Text>

      {/* 质量分数 */}
      {task.qualityScore !== undefined && task.qualityScore !== null && (
        <Text color={task.qualityScore >= 60 ? 'green' : 'yellow'}>
          [{task.qualityScore}]
        </Text>
      )}
    </Box>
  );
};

module.exports = { default: TaskItem };
