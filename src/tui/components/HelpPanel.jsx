'use strict';

const React = require('react');
const { Box, Text } = require('ink');
const { useTheme } = require('../context/ThemeContext');

const shortcuts = [
  { key: 'Ctrl+S', desc: '保存 checkpoint' },
  { key: 'Ctrl+R', desc: '重新执行任务' },
  { key: 'Ctrl+U', desc: '重置上下文' },
  { key: 'Ctrl+L', desc: '清屏' },
  { key: 'Ctrl+T', desc: '切换主题' },
  { key: 'Ctrl+H', desc: '左侧分屏 +5%' },
  { key: 'Ctrl+L', desc: '右侧分屏 +5%' },
  { key: '↑/↓', desc: '历史命令' },
  { key: 'Tab', desc: '自动补全' },
  { key: 'F1', desc: '帮助面板' },
  { key: 'Esc', desc: '关闭面板' }
];

const commands = [
  { cmd: 'scan', desc: '扫描本机 AI 编程工具' },
  { cmd: 'tools', desc: '查看已接入工具' },
  { cmd: 'status', desc: '查看当前状态' },
  { cmd: 'mode privacy|quality', desc: '切换执行模式' },
  { cmd: 'provider <name>', desc: '切换模型提供商' },
  { cmd: '<任务描述>', desc: '直接执行编程任务' },
  { cmd: 'run <任务>', desc: '显式执行任务' },
  { cmd: 'tasks', desc: '查看最近任务历史' },
  { cmd: 'reports', desc: '查看最近报告' },
  { cmd: 'report <id>', desc: '查看报告内容' },
  { cmd: 'ls [dir]', desc: '列出工作目录文件' },
  { cmd: 'view <path>', desc: '查看文件内容' },
  { cmd: 'pwd', desc: '显示当前目录' },
  { cmd: 'history', desc: '查看命令历史' },
  { cmd: 'reset', desc: '重置上下文记忆' },
  { cmd: 'clear/cls', desc: '清屏' },
  { cmd: 'help/h/?', desc: '显示帮助' },
  { cmd: 'exit/quit/q', desc: '退出' }
];

const HelpPanel = () => {
  const { theme } = useTheme();

  return (
    <Box flexDirection="column" padding={1} flexGrow={1}>
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text bold color="cyan">📖 QIDI Agent TUI 帮助</Text>
      </Box>

      {/* 快捷键 */}
      <Box marginBottom={2}>
        <Text bold color="yellow" underline>键盘快捷键</Text>
        <Box flexDirection="column" marginTop={1}>
          {shortcuts.map((s, i) => (
            <Box key={i} flexDirection="row">
              <Text color="cyan" width={16}>{s.key}</Text>
              <Text color={theme.text.dim}>{s.desc}</Text>
            </Box>
          ))}
        </Box>
      </Box>

      {/* 命令 */}
      <Box flexGrow={1}>
        <Text bold color="yellow" underline>命令参考</Text>
        <Box flexDirection="column" marginTop={1} flexGrow={1} justifyContent="flex-start">
          {commands.map((c, i) => (
            <Box key={i} flexDirection="row">
              <Text color="green" width={24}>{c.cmd}</Text>
              <Text color={theme.text.dim} flexGrow={1}>{c.desc}</Text>
            </Box>
          ))}
        </Box>
      </Box>

      {/* 底部提示 */}
      <Box marginTop={1} borderTopWidth={1} borderColor={theme.border} paddingTop={1}>
        <Text dimColor>按 [Esc] 或 [F1] 关闭帮助面板</Text>
      </Box>
    </Box>
  );
};

module.exports = { default: HelpPanel };
