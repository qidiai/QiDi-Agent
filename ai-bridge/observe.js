'use strict';

/**
 * ai-bridge/observe.js — 全局观测:工具配置接管/还原 + 代理路由注册表
 *
 * 借鉴 cc-switch 的配置注册表设计(五款工具的配置文件路径与字段写法),
 * 把各工具的 LLM base_url 改写指向中枢内建透传代理,实现全量流量观测。
 *
 * 铁律:
 *   1. 只改 baseUrl 类字段,绝不读取/记录/传输 apiKey
 *   2. 改写前先备份原配置,可一键还原;解析失败直接拒绝接管(绝不写坏用户配置)
 *   3. 跳过 loopback 上游(本地 ollama 等,代理无意义还添故障点)和已接管条目(防递归)
 *
 * 目录:默认 ~/.ai-bridge;env AI_BRIDGE_OBSERVE_DIR 可覆盖(测试隔离)。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

function dataDir () {
  return process.env.AI_BRIDGE_OBSERVE_DIR || path.join(os.homedir(), '.ai-bridge');
}
function routesFile () { return path.join(dataDir(), 'proxy-routes.json'); }
function stateFile () { return path.join(dataDir(), 'takeover-state.json'); }
function backupDir () { return path.join(dataDir(), 'takeover-backups'); }

// ── 工具配置注册表(路径与写法来自 cc-switch 源码核实) ──
// supported=false 的条目只做存在性检测,不做接管(codex 是 TOML/gemini 走 env,零依赖前提下暂不改写)
function registry () {
  const home = os.homedir();
  return {
    openclaw: { file: path.join(home, '.openclaw', 'openclaw.json'), supported: true, desc: 'models.providers.<名>.baseUrl' },
    claude: { file: path.join(home, '.claude', 'settings.json'), supported: true, desc: 'env.ANTHROPIC_BASE_URL' },
    codex: { file: path.join(home, '.codex', 'config.toml'), supported: false, desc: 'TOML 格式,暂不支持自动接管' },
    opencode: { file: path.join(home, '.config', 'opencode', 'opencode.json'), supported: false, desc: '字段写法未核实,暂不支持自动接管' },
    gemini: { file: path.join(home, '.gemini', 'settings.json'), supported: false, desc: '走环境变量,暂不支持自动接管' }
  };
}

// ── JSON 文件小工具(全部失败安全) ──
function loadJSON (file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return fallback; }
}
function saveJSON (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ── 代理路由注册表:key = "<source>/<route>" → { upstream } ──
function loadRoutes () { return loadJSON(routesFile(), {}); }

function addRoute (source, key, upstream) {
  if (!/^https?:\/\//.test(upstream)) throw new Error('upstream 必须是 http(s) URL');
  const routes = loadRoutes();
  routes[`${source}/${key}`] = { upstream: upstream.replace(/\/+$/, ''), addedAt: new Date().toISOString() };
  saveJSON(routesFile(), routes);
  return routes;
}

function getRoute (source, key) {
  return loadRoutes()[`${source}/${key}`] || null;
}

function removeRoutesBySource (source) {
  const routes = loadRoutes();
  let n = 0;
  for (const k of Object.keys(routes)) {
    if (k.startsWith(source + '/')) { delete routes[k]; n++; }
  }
  saveJSON(routesFile(), routes);
  return n;
}

// ── 接管/还原 ──

function isLoopback (u) {
  try { const h = new URL(u).hostname; return h === '127.0.0.1' || h === 'localhost' || h === '::1'; } catch (_) { return true; }
}

function backupFile (tool, file) {
  fs.mkdirSync(backupDir(), { recursive: true });
  const dest = path.join(backupDir(), `${tool}-${Date.now()}${path.extname(file)}.bak`);
  fs.copyFileSync(file, dest);
  return dest;
}

// openclaw:遍历 models.providers,把非 loopback/未接管的 baseUrl 指向代理,原地址登记为路由上游
function takeoverOpenclaw (file, proxyBase) {
  const raw = fs.readFileSync(file, 'utf-8');
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { throw new Error('openclaw.json 不是标准 JSON(可能含 JSON5 注释),拒绝改写以免写坏: ' + e.message); }
  const providers = cfg?.models?.providers;
  if (!providers || typeof providers !== 'object') throw new Error('openclaw.json 缺少 models.providers,无可接管条目');
  const changed = [];
  for (const [name, p] of Object.entries(providers)) {
    if (!p || typeof p.baseUrl !== 'string') continue;
    if (p.baseUrl.startsWith(proxyBase)) continue; // 已接管,防递归
    if (isLoopback(p.baseUrl)) continue; // 本地上游(ollama 等)跳过
    addRoute('openclaw', name, p.baseUrl);
    p.baseUrl = `${proxyBase}/proxy/openclaw/${name}`;
    changed.push(name);
  }
  if (!changed.length) throw new Error('没有可接管的 provider(全部为本地上游或已接管)');
  const backup = backupFile('openclaw', file);
  saveJSON(file, cfg);
  return { backup, changed };
}

// claude:settings.json env.ANTHROPIC_BASE_URL → 代理;原值(缺省为官方地址)登记为上游
function takeoverClaude (file, proxyBase) {
  const raw = fs.readFileSync(file, 'utf-8');
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { throw new Error('settings.json 解析失败,拒绝改写: ' + e.message); }
  if (!cfg.env) cfg.env = {};
  const current = cfg.env.ANTHROPIC_BASE_URL;
  if (typeof current === 'string' && current.startsWith(proxyBase)) throw new Error('已处于接管状态');
  const upstream = (typeof current === 'string' && /^https?:\/\//.test(current)) ? current : 'https://api.anthropic.com';
  addRoute('claude', 'anthropic', upstream);
  cfg.env.ANTHROPIC_BASE_URL = `${proxyBase}/proxy/claude/anthropic`;
  const backup = backupFile('claude', file);
  saveJSON(file, cfg);
  return { backup, changed: ['ANTHROPIC_BASE_URL'] };
}

function takeover (tool, proxyBase) {
  const reg = registry()[tool];
  if (!reg) throw new Error(`未知工具: ${tool}`);
  if (!reg.supported) throw new Error(`${tool} 暂不支持自动接管(${reg.desc})`);
  if (!fs.existsSync(reg.file)) throw new Error(`配置文件不存在: ${reg.file}`);
  const state = loadJSON(stateFile(), {});
  if (state[tool]) throw new Error(`${tool} 已处于接管状态(${state[tool].takenAt}),请先还原`);
  const result = tool === 'openclaw' ? takeoverOpenclaw(reg.file, proxyBase) : takeoverClaude(reg.file, proxyBase);
  state[tool] = { backup: result.backup, file: reg.file, changed: result.changed, takenAt: new Date().toISOString() };
  saveJSON(stateFile(), state);
  return { tool, ...result, note: '需重启该工具使新 baseUrl 生效' };
}

function restore (tool) {
  const state = loadJSON(stateFile(), {});
  const rec = state[tool];
  if (!rec) throw new Error(`${tool} 不在接管状态,无可还原`);
  if (!fs.existsSync(rec.backup)) throw new Error(`备份文件丢失: ${rec.backup},请手动检查 ${rec.file}`);
  fs.copyFileSync(rec.backup, rec.file);
  delete state[tool];
  saveJSON(stateFile(), state);
  const removed = removeRoutesBySource(tool);
  return { tool, restoredFrom: rec.backup, routesRemoved: removed, note: '需重启该工具使还原生效' };
}

function status () {
  const state = loadJSON(stateFile(), {});
  const routes = loadRoutes();
  const tools = {};
  for (const [name, reg] of Object.entries(registry())) {
    tools[name] = {
      configFile: reg.file,
      exists: fs.existsSync(reg.file),
      supported: reg.supported,
      method: reg.desc,
      takenOver: !!state[name],
      takenAt: state[name]?.takenAt || null
    };
  }
  return { tools, routes };
}

module.exports = { takeover, restore, status, addRoute, getRoute, loadRoutes, removeRoutesBySource };
