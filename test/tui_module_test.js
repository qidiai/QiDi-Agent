'use strict';

/**
 * TUI 模块测试
 */

const fs = require('fs');
const path = require('path');

// 测试模块加载
// 注意：JSX文件需要JSX转换器，在Node.js中无法直接require
const testModules = [
  { name: 'TUI Index', path: '../src/tui/index.js' },
  { name: 'TUISession', path: '../src/tui/TUISession.js' },
  // JSX组件（需要JSX转换器，无法直接require）
  // { name: 'App', path: '../src/tui/App.jsx' },
  // { name: 'SplitPane', path: '../src/tui/components/SplitPane.jsx' },
  // { name: 'TaskList', path: '../src/tui/components/TaskList.jsx' },
  // { name: 'TaskItem', path: '../src/tui/components/TaskItem.jsx' },
  // { name: 'ProgressBar', path: '../src/tui/components/ProgressBar.jsx' },
  // { name: 'StatusBar', path: '../src/tui/components/StatusBar.jsx' },
  // { name: 'Header', path: '../src/tui/components/Header.jsx' },
  // { name: 'HelpPanel', path: '../src/tui/components/HelpPanel.jsx' },
  // { name: 'CodePreview', path: '../src/tui/components/CodePreview.jsx' },
  // { name: 'CodeBlock', path: '../src/tui/components/CodeBlock.jsx' },
  // { name: 'StreamOutput', path: '../src/tui/components/StreamOutput.jsx' },
  // { name: 'InputLine', path: '../src/tui/components/InputLine.jsx' },
  // { name: 'ThemeContext', path: '../src/tui/context/ThemeContext.jsx' },
  // { name: 'TaskContext', path: '../src/tui/context/TaskContext.jsx' },
  // 非JSX模块
  { name: 'useKeyboard', path: '../src/tui/hooks/useKeyboard.js' },
  { name: 'useTheme', path: '../src/tui/hooks/useTheme.js' },
  { name: 'useFuzzyMatch', path: '../src/tui/hooks/useFuzzyMatch.js' },
  { name: 'useTaskEvents', path: '../src/tui/hooks/useTaskEvents.js' },
  { name: 'useStream', path: '../src/tui/hooks/useStream.js' },
  { name: 'themes', path: '../src/tui/styles/themes.js' },
  { name: 'fuzzyMatch', path: '../src/tui/utils/fuzzyMatch.js' },
  { name: 'TUIEventAdapter', path: '../src/tui/adapters/TUIEventAdapter.js' }
];

let passed = 0;
let failed = 0;

console.log('╔═══════════════════════════════════════════╗');
console.log('║    Qidi Agent TUI 模块测试               ║');
console.log('╚═══════════════════════════════════════════╝\n');

for (const mod of testModules) {
  try {
    require(mod.path);
    console.log(`✅ ${mod.name}`);
    passed++;
  } catch (err) {
    console.log(`❌ ${mod.name}: ${err.message}`);
    failed++;
  }
}

console.log('\n══════════════════════════════════════');
console.log(`  测试结果: ${passed}/${testModules.length} 通过`);
if (failed > 0) {
  console.log(`  ❌ 失败: ${failed}`);
}
console.log('══════════════════════════════════════\n');

// 退出码
process.exit(failed > 0 ? 1 : 0);
