'use strict';

const React = require('react');
const { Box, Text } = require('ink');
const { useTheme } = require('../context/ThemeContext');
const { useTask } = require('../context/TaskContext');
const TaskItem = require('./TaskItem').default;

const TaskList = () => {
  const { theme } = useTheme();
  const { tasks, currentTask, overview, plan } = useTask();

  if (tasks.length === 0) {
    return (
      <Box flexDirection="column" padding={1} justifyContent="center" alignItems="center" flexGrow={1}>
        <Text dimColor>No tasks yet</Text>
        <Text dimColor>Enter a task description to start</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* 执行计划摘要 */}
      {(overview || plan) && (
        <Box padding={1} borderBottomWidth={1} borderColor={theme.border}>
          {overview && (
            <Text dimColor wrap="wrap">{overview.substring(0, 100)}...</Text>
          )}
          {plan && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Plan: {plan}</Text>
            </Box>
          )}
        </Box>
      )}

      {/* 任务列表 */}
      <Box flexDirection="column" flexGrow={1} padding={1}>
        {tasks.map((task, index) => (
          <TaskItem
            key={task.id}
            task={task}
            index={index}
            isActive={currentTask && currentTask.id === task.id}
          />
        ))}
      </Box>
    </Box>
  );
};

module.exports = { default: TaskList };
