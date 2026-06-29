'use strict';

const React = require('react');
const { Box, Text } = require('ink');
const { useTheme } = require('../context/ThemeContext');
const { useTask } = require('../context/TaskContext');
const { useKeyboard } = require('../hooks/useKeyboard');
const TaskList = require('./TaskList').default;
const CodePreview = require('./CodePreview').default;
const HelpPanel = require('./HelpPanel').default;

const SplitPane = ({ session, mode, setMode }) => {
  const { theme } = useTheme();
  const { tasks, completedCount, totalCount } = useTask();
  const [leftRatio, setLeftRatio] = React.useState(0.35);

  // Ctrl+H/L 调整分屏比例
  useKeyboard({
    onCtrlH: () => setLeftRatio(Math.max(0.2, leftRatio - 0.05)),
    onCtrlL: () => setLeftRatio(Math.min(0.6, leftRatio + 0.05))
  });

  const columns = process.stdout.columns || 120;
  const leftWidth = Math.floor(columns * leftRatio);
  const rightWidth = columns - leftWidth - 1;

  // 帮助面板模式
  if (mode === 'help') {
    return (
      <Box flexGrow={1}>
        <HelpPanel />
      </Box>
    );
  }

  return (
    <Box flexGrow={1} flexDirection="row">
      {/* 左侧：任务列表 */}
      <Box
        width={leftWidth}
        borderStyle="single"
        borderColor={theme.border}
        flexDirection="column"
      >
        <Box padding={1} borderBottomWidth={1} borderColor={theme.border}>
          <Text bold color="cyan">
            Tasks ({completedCount}/{totalCount})
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <TaskList />
        </Box>
      </Box>

      {/* 分隔线 */}
      <Box width={1} flexDirection="column">
        {Array.from({ length: 20 }).map((_, i) => (
          <Text key={i} dimColor>│</Text>
        ))}
      </Box>

      {/* 右侧：代码预览 */}
      <Box
        width={rightWidth}
        borderStyle="single"
        borderColor={theme.border}
        flexDirection="column"
      >
        <Box padding={1} borderBottomWidth={1} borderColor={theme.border}>
          <Text bold color="cyan">Output</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <CodePreview />
        </Box>
      </Box>
    </Box>
  );
};

module.exports = { default: SplitPane };
