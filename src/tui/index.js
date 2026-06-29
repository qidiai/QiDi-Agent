'use strict';

/**
 * Qidi Agent TUI - Ink React-based Terminal UI
 *
 * 启动方式:
 *   node src/tui/index.js
 *   node src/cli/index.js tui
 */

const { render, Box, Text } = require('ink');
const React = require('react');
const path = require('path');
const fs = require('fs');

// 动态导入以避免 require 顺序问题
let App;
try {
  App = require('./App').default;
} catch (e) {
  // App 尚未创建，使用占位符
  App = () => React.createElement(Box, null,
    React.createElement(Text, { color: 'red' }, 'App component not found. Run: npm run build:tui')
  );
}

/**
 * TUI 启动选项
 * @typedef {Object} TUIOptions
 * @property {string} workspaceDir - 工作目录
 * @property {string} mode - 执行模式: privacy|quality
 * @property {string} provider - 默认提供商: ollama|openai|anthropic
 */

/**
 * 启动 TUI
 * @param {TUIOptions} options
 */
async function startTUI (options = {}) {
  const {
    workspaceDir = path.join(process.cwd(), 'workspace'),
    mode = 'privacy',
    provider = process.env.MODEL_PROVIDER || 'ollama'
  } = options;

  // 确保工作目录存在
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }

  // 创建 TUI 会话
  const TUISession = loadTUISession();
  const session = new TUISession({
    workspaceDir,
    mode,
    provider
  });

  // 渲染 App
  const app = React.createElement(App, { session });

  // Ink 渲染
  return new Promise((resolve, reject) => {
    try {
      const { unmount, waitUntilExit } = render(app);

      // 等待用户退出
      waitUntilExit()
        .then(() => resolve({ exit: 'normal' }))
        .catch(err => reject(err));

      // 处理 SIGINT
      process.on('SIGINT', () => {
        unmount();
        resolve({ exit: 'interrupt' });
      });
    } catch (err) {
      reject(err);
    }
  });
}

function loadTUISession () {
  try {
    return require('./TUISession');
  } catch (e) {
    // TUISession 尚未创建，返回空类
    return class EmptySession {
      constructor () {
        this.workspaceDir = '.';
        this.mode = 'privacy';
      }

      async start () {
        console.log('TUISession not implemented yet');
      }
    };
  }
}

// CLI 直接运行
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {
    workspaceDir: './workspace',
    mode: 'privacy',
    provider: 'ollama'
  };

  // 简单参数解析
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      options.mode = args[i + 1];
      i++;
    } else if (args[i] === '--provider' && args[i + 1]) {
      options.provider = args[i + 1];
      i++;
    } else if (args[i] === '--workspace' && args[i + 1]) {
      options.workspaceDir = args[i + 1];
      i++;
    }
  }

  startTUI(options)
    .then(() => process.exit(0))
    .catch(err => {
      console.error('TUI Error:', err);
      process.exit(1);
    });
}

module.exports = { startTUI };
