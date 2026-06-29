'use strict';

const React = require('react');
const { Box } = require('ink');
const { ThemeProvider, useTheme } = require('./context/ThemeContext');
const { TaskProvider } = require('./context/TaskContext');
const { useKeyboard } = require('./hooks/useKeyboard');
const Header = require('./components/Header').default;
const SplitPane = require('./components/SplitPane').default;
const StatusBar = require('./components/StatusBar').default;

const AppContent = ({ session }) => {
  const { theme } = useTheme();
  const [mode, setMode] = React.useState('split'); // split | input | help

  // 键盘快捷键
  useKeyboard({
    onCtrlL: () => {
      console.clear && console.clear();
    },
    onCtrlT: () => {
      // 主题切换由 ThemeProvider 处理
    },
    onF1: () => setMode(mode === 'help' ? 'split' : 'help'),
    onEscape: () => setMode('split')
  });

  // 获取终端大小
  const [终端大小, set终端大小] = React.useState({
    rows: process.stdout.rows || 40,
    columns: process.stdout.columns || 120
  });

  React.useEffect(() => {
    const handleResize = () => {
      set终端大小({
        rows: process.stdout.rows || 40,
        columns: process.stdout.columns || 120
      });
    };

    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.removeListener('resize', handleResize);
    };
  }, []);

  return (
    <Box
      flexDirection="column"
      height={终端大小.rows}
      width={终端大小.columns}
      backgroundColor={theme.background}
    >
      <Header session={session} />
      <SplitPane session={session} mode={mode} setMode={setMode} />
      <StatusBar session={session} />
    </Box>
  );
};

const App = ({ session }) => {
  return (
    <ThemeProvider>
      <TaskProvider>
        <AppContent session={session} />
      </TaskProvider>
    </ThemeProvider>
  );
};

module.exports = { default: App };
