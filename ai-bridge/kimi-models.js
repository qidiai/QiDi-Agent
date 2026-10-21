'use strict';

/**
 * kimi-models.js — 自动同步 Kimi Code 模型到 ai-bridge
 *
 * 读取 Kimi Code CLI 的 config.toml（$KIMI_CODE_HOME/config.toml 或
 * ~/.kimi-code/config.toml），把所有走 kimi 协议 provider 的模型自动导出为：
 *   1. getKimiToolConfigs()  — dispatch 工具配置（tool-registry.js 用）
 *   2. getKimiProxyModels()  — /v1 OpenAI 兼容反代模型条目（server.js 用）
 *
 * Kimi Code 更新模型（新增/下线/改名）后无需手工改 tools.json / models.json：
 * server.js 启动时自动同步；运行期间 config.toml 变化会触发热更新。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function kimiConfigPath () {
  const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  return path.join(home, 'config.toml');
}

/**
 * 极简 TOML 段解析（针对 kimi-code 机器生成的 config.toml）
 * 只提取 [providers."X"] / [models."Y"] 段内的标量键值（字符串/数字），
 * 子表（.oauth / .overrides / .env 等）与其它段一律跳过。
 */
function parseKimiConfig (text) {
  const providers = {};
  const models = {};
  let section = null; // { kind: 'providers'|'models', key }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const secMatch = line.match(/^\[(providers|models)\.(?:"([^"]+)"|(\w+))(\.\w+)?\]$/);
    if (secMatch) {
      if (secMatch[4]) { section = null; continue; } // 子表，跳过
      section = { kind: secMatch[1], key: secMatch[2] || secMatch[3] };
      const bucket = section.kind === 'providers' ? providers : models;
      if (!bucket[section.key]) bucket[section.key] = {};
      continue;
    }
    if (line.startsWith('[')) { section = null; continue; }
    if (!section) continue;

    const kv = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const raw = kv[2].trim();
    const strMatch = raw.match(/^"([^"]*)"/);
    const numMatch = raw.match(/^(-?\d+)/);
    let value;
    if (strMatch) value = strMatch[1];
    else if (numMatch) value = parseInt(numMatch[1], 10);
    else continue; // 数组/布尔等不关心

    const bucket = section.kind === 'providers' ? providers[section.key] : models[section.key];
    bucket[kv[1]] = value;
  }
  return { providers, models };
}

/**
 * 读取 kimi-code 中所有 kimi 协议模型。
 * 返回 null = 配置暂不可读/解析失败(文件可能正在被写入);
 * 返回 []   = 配置可读但确实没有 kimi 模型(权威结果,调用方可安全清空旧条目)。
 * 调用方(getter)在 null 时回退上一次已知结果,避免瞬时写冲突导致清单闪空。
 * 带 30s mtime 缓存:mtime 未变且未过期直接回缓存,变了立即重读(热更新不被缓存拖慢)。
 */
let _kimiCache = null; // { mtimeMs, at, models }
function readKimiModels () {
  const cfgPath = kimiConfigPath();
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(cfgPath).mtimeMs;
  } catch (_) {
    return null; // 文件不存在或暂不可访问(保留旧缓存供回退)
  }
  const now = Date.now();
  if (_kimiCache && _kimiCache.mtimeMs === mtimeMs && now - _kimiCache.at < 30000) {
    return _kimiCache.models;
  }

  let parsed;
  try {
    parsed = parseKimiConfig(fs.readFileSync(cfgPath, 'utf-8'));
  } catch (_) {
    return null; // 读/解析失败:保留旧缓存结论,等下次事件或兜底轮询
  }

  const out = [];
  for (const [alias, m] of Object.entries(parsed.models)) {
    const prov = parsed.providers[m.provider];
    if (!prov || prov.type !== 'kimi') continue; // 只要 Kimi 协议的模型
    if (!m.model) continue;
    out.push({
      alias,
      model: m.model,
      displayName: m.display_name || m.model,
      contextWindow: typeof m.max_context_size === 'number' ? m.max_context_size : 262144,
      toolName: alias.replace(/[/.]/g, '-')
    });
  }
  _kimiCache = { mtimeMs, at: now, models: out };
  return out;
}

/** dispatch 工具配置（tool-registry.js 用）；kimi 配置暂不可读时回退上一次已知结果 */
function getKimiToolConfigs () {
  const models = readKimiModels() ?? (_kimiCache ? _kimiCache.models : []);
  return models.map(m => ({
    name: m.toolName,
    displayName: `Kimi Code (${m.displayName})`,
    description: `Kimi Code 模型 ${m.model}（自动同步自 kimi-code config.toml）`,
    transport: 'cli',
    command: 'kimi',
    args: ['-p', '{{task}}', '-m', m.alias, '--output-format', 'text'],
    inputMode: 'arg',
    outputMode: 'stdout-text',
    timeout: 600000,
    autoSync: 'kimi-code' // 标记：自动同步生成，热更新时整体替换
  }));
}

/** /v1 OpenAI 兼容反代模型条目（server.js loadAllModels 用，与 models.json 同构） */
function getKimiProxyModels () {
  const models = readKimiModels() ?? (_kimiCache ? _kimiCache.models : []);
  return models.map(m => ({
    id: m.model,
    owned_by: 'kimi-code',
    switch: m.toolName, // 与 dispatch 工具共用开关
    transport: 'cli',
    context_window: m.contextWindow,
    display_name: m.displayName,
    autoSync: 'kimi-code',
    cli: {
      command: 'kimi',
      args: ['-p', '{{task}}', '-m', m.alias, '--output-format', 'text'],
      inputMode: 'arg',
      outputMode: 'stdout-text',
      timeout: 600000
    }
  }));
}

module.exports = { getKimiToolConfigs, getKimiProxyModels, kimiConfigPath };
