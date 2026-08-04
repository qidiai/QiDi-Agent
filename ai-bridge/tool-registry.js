'use strict';

/**
 * tool-registry.js — 工具注册表（配置驱动）
 *
 * 从 tools.json 加载工具配置，按 transport 字段创建对应适配器实例。
 * 新增工具只需在 tools.json 加一段配置，不改代码。
 *
 * 导出（向后兼容，server.js / bridge-stdio.js 依赖）:
 *   - TOOLS:       适配器实例数组（每个有 name/displayName/description/detect/execute）
 *   - findInPath:  PATH 可执行探测
 *   - estimateTokens:  中文友好 token 估算
 *   - extractCodeBlocks: 代码块提取
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { BaseAdapter, estimateTokens, extractCodeBlocks } = require('./adapters/base');
const { CliAdapter } = require('./adapters/cli-adapter');
const { HttpAdapter } = require('./adapters/http-adapter');

// ============================================================
// Routing Marker Adapter（agnes-mcp 专用，不 spawn 进程）
// ============================================================
class RoutingMarkerAdapter extends BaseAdapter {
  constructor (config) { super(config); }
  async detect () { return true; }
  async execute (task) {
    return {
      content: `[AGNES_TASK]\n${task}\n[END_AGNES_TASK]\n\n⚠️ This task is routed to Agnes for direct handling. Do not forward to other AI tools.`,
      codeBlocks: [],
      usage: { input: estimateTokens(task), output: 0, total: estimateTokens(task), estimated: true }
    };
  }
}

// ============================================================
// 从 tools.json 加载工具
// ============================================================
function loadTools () {
  const configPath = path.join(__dirname, 'tools.json');
  if (!fs.existsSync(configPath)) {
    console.warn('[tool-registry] tools.json 不存在，返回空列表');
    return [];
  }
  const configs = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const tools = [];
  for (const config of configs) {
    try {
      let adapter;
      switch (config.transport) {
        case 'cli': adapter = new CliAdapter(config); break;
        case 'http': adapter = new HttpAdapter(config); break;
        case 'routing-marker': adapter = new RoutingMarkerAdapter(config); break;
        default: console.warn(`[tool-registry] 未知 transport "${config.transport}" for tool "${config.name}"，跳过`); continue;
      }
      tools.push(adapter);
    } catch (e) {
      console.error(`[tool-registry] 加载工具 "${config.name}" 失败: ${e.message}`);
    }
  }
  return tools;
}

const TOOLS = loadTools();

// ============================================================
// 共享工具函数（向后兼容导出）
// ============================================================

/** Find command in PATH */
async function findInPath (name) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const checker = isWin ? 'where' : 'which';
    const child = spawn(checker, [name], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let found = '';
    child.stdout.on('data', d => found += d);
    child.on('close', code => resolve(code === 0 && found.trim().length > 0));
    child.on('error', () => resolve(false));
  });
}

module.exports = { TOOLS, findInPath, estimateTokens, extractCodeBlocks };
