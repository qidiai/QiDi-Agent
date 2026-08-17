#!/usr/bin/env node
'use strict';

/**
 * AI Bridge HTTP 常驻服务 v1.1
 *
 * 修复:鉴权/CORS/并发安全/长轮询泄漏/graceful shutdown/常量配置化/全局错误处理
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { TOOLS, findInPath, estimateTokens, extractCodeBlocks } = require('./tool-registry');
const {
  decorateToolIdentity,
  resolveToolReference,
  switchKeysFor,
  statsKeysFor
} = require('./tool-identity');
const {
  classifyTask,
  buildRoutingProfile,
  rankRoutingProfiles
} = require('./routing-score');
const { CliAdapter } = require('./adapters/cli-adapter');
const store = require('./store');
const db = require('./db');
const observe = require('./observe');

// ── 配置(集中管理,不再分散硬编码) ──
// 解析正整数 env:非数字/0/负数一律回退默认值
function parsePositiveInt (v, def) {
  const n = parseInt(v);
  return (Number.isFinite(n) && n > 0) ? n : def;
}
const CONFIG = {
  PORT: parseInt(process.env.AI_BRIDGE_PORT) || 9800,
  HOST: process.env.AI_BRIDGE_HOST || '127.0.0.1',
  EXECUTE_TIMEOUT: parseInt(process.env.AI_BRIDGE_EXECUTE_TIMEOUT) || 900000, // 可配:默认 15 分钟,慢客户端(如本地大模型宿主)可再放宽单次执行窗口
  POLL_TIMEOUT: 30000,
  MAX_TASK_LENGTH: 50000,
  MAX_CONCURRENT_DISPATCH: parsePositiveInt(process.env.AI_BRIDGE_MAX_CONCURRENT_DISPATCH, 5),
  RESULT_MAX_CHARS: parsePositiveInt(process.env.AI_BRIDGE_RESULT_MAX_CHARS, 2000), // dispatch 结果 content 截断上限(可配,防长产出被硬砍)
  MAX_CONCURRENT_MEETINGS: 3,
  TOOL_STATUS_TTL: 60000,
  CLIENT_TTL: parsePositiveInt(process.env.AI_BRIDGE_CLIENT_TTL, 5 * 60 * 1000),
  MAX_MEETING_TOKENS: parseInt(process.env.AI_BRIDGE_MEETING_MAX_TOKENS) || 100000,
  MEETING_MAX_MS: parseInt(process.env.AI_BRIDGE_MEETING_MAX_MS) || 10 * 60 * 1000,
  AUTH_TOKEN: process.env.AI_BRIDGE_TOKEN || null,
  CORS_ORIGIN: process.env.AI_BRIDGE_CORS || null
};

const CONFIG_DIR = __dirname;
const SWITCHES_FILE = store.FILES.switches;
const STATS_FILE = store.FILES.stats;

// ── 数据操作委托给 store.js ──
function loadJSON (file) {
  if (file === SWITCHES_FILE) return store.load('switches');
  if (file === STATS_FILE) return store.load('stats');
  return {};
}
function saveJSONSync (file, data) {
  if (file === SWITCHES_FILE || file === 'switches') store.saveSync('switches', data);
  else if (file === STATS_FILE || file === 'stats') store.saveSync('stats', data);
}

function recordTokens (tool, usage, duration) {
  // 新调用写入稳定实例键（cli:* / client:*）；历史裸名称继续只读聚合，不破坏旧数据。
  const statsKey = typeof tool === 'string' ? tool : tool.id;
  const stats = store.load('stats');
  if (!stats.total) stats.total = { input: 0, output: 0, total: 0, calls: 0 };
  if (!stats.tools) stats.tools = {};
  if (!stats.tools[statsKey]) stats.tools[statsKey] = { input: 0, output: 0, total: 0, calls: 0, lastUsed: null };
  const input = usage?.input || 0;
  const output = usage?.output || 0;
  const total = input + output;
  stats.tools[statsKey].input += input;
  stats.tools[statsKey].output += output;
  stats.tools[statsKey].total += total;
  stats.tools[statsKey].calls += 1;
  stats.tools[statsKey].lastUsed = new Date().toISOString();
  stats.tools[statsKey].lastDuration = duration;
  stats.total.input += input;
  stats.total.output += output;
  stats.total.total += total;
  stats.total.calls += 1;
  store.saveSync('stats', stats); // store.saveSync 内部有自旋锁保护
  store.appendLog('debug', `recordTokens: ${statsKey} ${JSON.stringify({input,output,total})}`, { tool: statsKey });
}

// ── 日志快捷方法 ──
function log (level, msg, extra) { store.appendLog(level, msg, extra); }

// ── AgnesCode 凭据读取(Windows Credential Manager) ──
const { execSync } = require('child_process');
let _agnesToken = null;
let _agnesTokenTime = 0;
const AGNES_TOKEN_TTL = 3600000;

function readAgnesToken () {
  if (_agnesToken && Date.now() - _agnesTokenTime < AGNES_TOKEN_TTL) return _agnesToken;
  try {
    const script = path.join(__dirname, 'read-cred.ps1');
    const result = execSync(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`,
      { encoding: 'utf-8', timeout: 10000, windowsHide: true }
    ).trim();
    if (!result) return null;
    // 结果可能是 JSON: {"AGNES_AI_API_KEY":"..."}
    try {
      const parsed = JSON.parse(result);
      _agnesToken = parsed.AGNES_AI_API_KEY || parsed.api_key || parsed.token || result;
    } catch (_) {
      _agnesToken = result;
    }
    _agnesTokenTime = Date.now();
    log('info', 'AgnesCode token refreshed from Windows Credential Manager');
    return _agnesToken;
  } catch (e) {
    log('error', `Failed to read AgnesCode credential: ${e.message}`);
    return null;
  }
}

// ── AtomCode 凭据读取(auth.toml) ──
let _atomToken = null;
let _atomTokenTime = 0;

function readAtomToken () {
  if (_atomToken && Date.now() - _atomTokenTime < AGNES_TOKEN_TTL) return _atomToken;
  try {
    const authPath = path.join(os.homedir(), '.atomcode', 'auth.toml');
    if (!fs.existsSync(authPath)) return null;
    const content = fs.readFileSync(authPath, 'utf-8');
    const match = content.match(/access_token\s*=\s*"([^"]+)"/);
    if (!match) return null;
    _atomToken = match[1];
    _atomTokenTime = Date.now();
    log('info', 'AtomCode token refreshed from auth.toml');
    return _atomToken;
  } catch (e) {
    log('error', `Failed to read AtomCode credential: ${e.message}`);
    return null;
  }
}

// ── Codely(团结 Cowork)凭据与 cli_api_key ──
const CODELY_API_BASE = 'https://codely.tuanjie.cn';
const CODELY_LITELLM_BASE = 'https://codely-litellm.tuanjie.cn';
let _codelyKey = null;
let _codelyKeyTime = 0;
const CODELY_KEY_TTL = 3600000;

// 服务以 LocalSystem 运行时 os.homedir() 指向系统目录,这里探测真实用户目录下的 .codely-cli
function codelyAuthDir () {
  const envDir = process.env.CODELY_AUTH_DIR;
  const candidates = [];
  if (envDir) candidates.push(envDir);
  candidates.push(os.homedir());
  if (process.env.USERPROFILE) candidates.push(process.env.USERPROFILE);
  for (const base of candidates) {
    if (!base) continue;
    const p = path.join(base, '.codely-cli');
    if (fs.existsSync(path.join(p, 'oauth_creds.json'))) return p;
  }
  // 兜底:扫描 C:\Users\* 下已登录的 .codely-cli
  try {
    const usersRoot = 'C:\\Users';
    for (const name of fs.readdirSync(usersRoot)) {
      const p = path.join(usersRoot, name, '.codely-cli');
      if (fs.existsSync(path.join(p, 'oauth_creds.json'))) return p;
    }
  } catch (_) {}
  return null;
}

function readCodelyCreds () {
  const dir = codelyAuthDir();
  if (!dir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'oauth_creds.json'), 'utf-8'));
  } catch (e) {
    return null;
  }
}

function codelyOrgId (creds) {
  const dir = codelyAuthDir();
  try {
    if (dir && fs.existsSync(path.join(dir, 'org.json'))) {
      const orgData = JSON.parse(fs.readFileSync(path.join(dir, 'org.json'), 'utf-8'));
      const accounts = orgData.accounts || {};
      const uid = String(creds.user_id || '');
      if (uid && accounts[uid]) return accounts[uid].currentOrgId || '';
    }
  } catch (_) {}
  return creds.org_id || '';
}

function fetchCodelyCliApiKey () {
  const creds = readCodelyCreds();
  if (!creds || !creds.access_token) throw new Error('未找到团结登录态(~/.codely-cli/oauth_creds.json)');
  const orgId = codelyOrgId(creds);
  const params = new URLSearchParams();
  if (orgId) params.set('teamId', orgId);
  const qs = params.toString();
  return new Promise((resolve, reject) => {
    const url = `${CODELY_API_BASE}/api/api-token/cli-api-key${qs ? '?' + qs : ''}`;
    const req = https.get(url, {
      headers: { Authorization: `Bearer ${creds.access_token}`, Accept: 'application/json' },
      timeout: 15000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(d);
          if (data.cli_api_key) resolve(data.cli_api_key);
          else reject(new Error(`cli-api-key 响应无 key: ${d.substring(0, 200)}`));
        } catch (e) { reject(new Error(`cli-api-key 解析失败: ${d.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('获取 cli_api_key 超时')); });
  });
}

function getCodelyCliApiKey () {
  if (_codelyKey && Date.now() - _codelyKeyTime < CODELY_KEY_TTL) return Promise.resolve(_codelyKey);
  return fetchCodelyCliApiKey().then(key => {
    _codelyKey = key;
    _codelyKeyTime = Date.now();
    log('info', 'Codely cli_api_key refreshed');
    return key;
  });
}

// ── OpenAI 兼容反代:模型注册表(配置驱动,新增模型只改 models.json,不改代码) ──
let _modelsCache = null;
let _modelsCacheTime = 0;
function loadModels () {
  if (_modelsCache && Date.now() - _modelsCacheTime < 30000) return _modelsCache;
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(__dirname, 'models.json'), 'utf-8'));
    _modelsCache = Array.isArray(arr) ? arr : [];
  } catch (e) {
    log('error', `models.json 加载失败: ${e.message}`);
    _modelsCache = [];
  }
  _modelsCacheTime = Date.now();
  return _modelsCache;
}

function findModel (id) {
  const wanted = String(id || '').toLowerCase();
  return loadModels().find(m => String(m.id).toLowerCase() === wanted) || null;
}

// 模型是否可用:绑定的工具开关未被显式关闭(与 dispatch 共用 switches.json)
function modelEnabled (m) {
  return !m.switch || isToolEnabled(m.switch);
}

// OpenAI messages[] → 单条 prompt(CLI 型订阅一次性输入用;兼容 content 为字符串或分段数组)
function messagesToPrompt (messages) {
  if (!Array.isArray(messages)) return '';
  return messages.map(m => {
    const c = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content) ? m.content.map(x => (x && typeof x.text === 'string') ? x.text : '').join('') : '';
    return c ? `${m.role || 'user'}: ${c}` : '';
  }).filter(Boolean).join('\n\n');
}

// ── 状态 ──
let _toolStatus = null;
let _toolStatusTime = 0;
const connectedClients = new Map();
// 仅保留最近一次离线/过期原因，不参与调度；用于把 ACL 权限态与运行态分开呈现。
const clientTombstones = new Map();
const activeDispatches = new Set();
// 异步任务内存结果表(主查询层;全局库是持久化副本,重启后可查历史)
const asyncTaskResults = new Map();
function rememberAsyncTask (id, entry) {
  asyncTaskResults.set(id, entry);
  if (asyncTaskResults.size > 100) asyncTaskResults.delete(asyncTaskResults.keys().next().value);
}
let activeDispatchCount = 0;
let isShuttingDown = false;
const START_TIME = Date.now();

// ── 运行指标(可观测性:进程级轻量内存计数,重启归零) ──
const METRICS = {
  dispatchTotal: 0, dispatchSuccess: 0, dispatchFail: 0,
  fallbackTotal: 0, fallbackSuccess: 0,
  clientTimeouts: 0,
  meetingsStarted: 0,
  meetingsAutoStopped: 0,
  errors5xx: 0
};

let _statusPromise = null; // in-flight 去重:防并发刷新交叉写入同一缓存数组产生重复工具项
async function getToolStatus () {
  // 加 TTL,60 秒后自动刷新
  if (_toolStatus && Date.now() - _toolStatusTime < CONFIG.TOOL_STATUS_TTL) return _toolStatus;
  if (_statusPromise) return _statusPromise;
  _statusPromise = (async () => {
    try {
      const list = []; // 构建局部数组,完成后一次性赋值,避免半成品暴露
      for (const tool of TOOLS) {
        const available = await tool.detect();
        list.push({ name: tool.name, displayName: tool.displayName, description: tool.description, available });
      }
      _toolStatus = list;
      _toolStatusTime = Date.now();
      return list;
    } finally {
      _statusPromise = null;
    }
  })();
  return _statusPromise;
}

function refreshToolStatus () {
  _toolStatus = null;
  _toolStatusTime = 0;
}

async function getAllTools () {
  const status = await getToolStatus();
  const tools = status.map(t => decorateToolIdentity({ ...t, type: 'cli', sourceId: t.name }));
  for (const [name, info] of connectedClients) {
    // 只有完成首次 poll、连接健康且宿主明确支持 MCP sampling 的客户端才进入执行调度。
    // 不支持 sampling 的客户端仍保留控制连接，可调用 AI Bridge 工具，但不能承接反向任务。
    if (!info.firstPollAt || clientState(info) === 'stale' || info.supportsSampling !== true) continue;
    const clientTool = {
      name,
      sourceId: info.name,
      displayName: info.name,
      description: `已连接的 AI 编程软件 (${info.name})`,
      available: true,
      type: 'client',
      clientKey: name
    };
    tools.push(decorateToolIdentity(clientTool));
  }
  return tools;
}

function isToolEnabled (tool, switches = null) {
  const sw = switches || loadJSON(SWITCHES_FILE);
  const t = typeof tool === 'string' ? null : tool;
  if (!t) return sw[tool] !== false; // 模型开关等非工具调用保持兼容。
  const keys = switchKeysFor(t);
  const configured = keys.find(key => Object.prototype.hasOwnProperty.call(sw, key));
  return configured ? sw[configured] !== false : true;
}

function aggregateTokenStats (tool, stats, allTools) {
  const rows = stats.tools || {};
  const keys = statsKeysFor(tool, allTools);
  const summary = { input: 0, output: 0, total: 0, calls: 0, lastUsed: null, lastDuration: null };
  for (const key of keys) {
    const row = rows[key];
    if (!row) continue;
    summary.input += row.input || 0;
    summary.output += row.output || 0;
    summary.total += row.total || 0;
    summary.calls += row.calls || 0;
    if (row.lastUsed && (!summary.lastUsed || row.lastUsed > summary.lastUsed)) {
      summary.lastUsed = row.lastUsed;
      summary.lastDuration = row.lastDuration || null;
    }
  }
  return summary;
}

function buildToolRoutingProfile (tool, allTools, tokenStats, now = Date.now()) {
  const keys = statsKeysFor(tool, allTools);
  const observations = store.getToolObservations(keys);
  const usage = aggregateTokenStats(tool, tokenStats, allTools);
  return buildRoutingProfile(tool, observations, usage, now);
}

function assignedClientId (name) {
  return TOOLS.some(t => t.name === name) ? `client-${name}` : name;
}

function aclClientKeys (id) {
  const keys = new Set([id]);
  if (id.startsWith('client-')) {
    const source = id.substring('client-'.length);
    if (TOOLS.some(t => t.name === source)) keys.add(source);
  } else {
    keys.add(assignedClientId(id));
  }
  return [...keys];
}

function clientState (info, now = Date.now()) {
  if (!info) return 'approved_offline';
  if (now - (info.lastSeen || info.registeredAt || 0) > CONFIG.CLIENT_TTL) return 'stale';
  if (!info.firstPollAt) return info.reconnectCount > 0 ? 'reconnecting' : 'connecting';
  return (info.pendingResolve || info._busy || info.taskPending) ? 'online_busy' : 'online_idle';
}

function clientView (id, info, approved = true) {
  const state = clientState(info);
  return {
    id,
    name: info?.name || id.replace(/^client-/, ''),
    canonicalId: decorateToolIdentity({ name: id, sourceId: info?.name || id, type: 'client' }).canonicalId,
    type: 'client',
    approved,
    state,
    online: state === 'online_idle' || state === 'online_busy',
    busy: state === 'online_busy',
    connectedAt: info?.connectedAt || null,
    registeredAt: info?.registeredAt ? new Date(info.registeredAt).toISOString() : null,
    firstPollAt: info?.firstPollAt ? new Date(info.firstPollAt).toISOString() : null,
    lastSeen: info?.lastSeen ? new Date(info.lastSeen).toISOString() : null,
    lastError: info?.lastError || null,
    disconnectReason: info?.disconnectReason || null,
    reconnectCount: info?.reconnectCount || 0,
    supportsSampling: info?.supportsSampling === true,
    executionEligible: (state === 'online_idle' || state === 'online_busy') && info?.supportsSampling === true
  };
}

function onlineClientCount () {
  let count = 0;
  for (const info of connectedClients.values()) {
    const state = clientState(info);
    if (state === 'online_idle' || state === 'online_busy') count++;
  }
  return count;
}

function rememberClientDisconnect (id, info, reason, lastError = null) {
  clientTombstones.set(id, {
    name: info?.name || id.replace(/^client-/, ''),
    disconnectedAt: Date.now(),
    lastSeen: info?.lastSeen || null,
    lastError,
    disconnectReason: reason
  });
  if (clientTombstones.size > 100) clientTombstones.delete(clientTombstones.keys().next().value);
}

function isToolFailed (result, error) {
  if (error) return { failed: true, reason: error.message || String(error), partialCode: '' };
  const text = (result.content || '').toLowerCase();
  const failKeywords = ['insufficient balance', '额度', '限额', 'rate limit', 'quota', 'exceeded', 'unauthorized', '402', '429', '401'];
  if (result.codeBlocks.length === 0 && failKeywords.some(k => text.includes(k))) {
    return { failed: true, reason: text.substring(0, 200), partialCode: '' };
  }
  if (result.codeBlocks.length > 0 && result.codeBlocks[0].code.length < 50 && failKeywords.some(k => text.includes(k))) {
    return { failed: true, reason: text.substring(0, 200), partialCode: result.codeBlocks[0].code };
  }
  return { failed: false };
}

// ── 核心逻辑 ──

async function executeTool (name, task, opts = {}) {
  const allTools = await getAllTools();
  const toolDef = resolveToolReference(name, allTools);
  if (!toolDef) throw new Error(`未知或有歧义的工具: ${name}`);
  const executionName = toolDef.name;

  const taskId = opts.taskId || `${executionName}_${Date.now()}`;
  const startTime = Date.now();

  // 流量记录:发出
  db.recordTraffic({
    ts: new Date().toISOString(),
    direction: 'out',
    tool: toolDef.id,
    taskId,
    type: toolDef.type || 'cli',
    content: task
  });

  let result;
  let execError = null;
  try {
    if (toolDef.type === 'client') {
      result = await executeClient(toolDef.clientKey || executionName, task, opts);
    } else {
      const tool = TOOLS.find(t => t.name === executionName);
      result = await tool.execute(task, { taskId, timeout: opts.timeout || CONFIG.EXECUTE_TIMEOUT });
    }
  } catch (e) {
    execError = e;
  }

  // 流量记录:返回
  if (execError) {
    db.recordTraffic({
      ts: new Date().toISOString(),
      direction: 'in',
      tool: toolDef.id,
      taskId,
      type: toolDef.type || 'cli',
      success: false,
      error: execError.message,
      content: ''
    });
    throw execError;
  }

  db.recordTraffic({
    ts: new Date().toISOString(),
    direction: 'in',
    tool: toolDef.id,
    taskId,
    type: toolDef.type || 'cli',
    success: true,
    duration: ((Date.now() - startTime) / 1000).toFixed(1) + 's',
    content: result.content || '',
    codeBlocks: (result.codeBlocks || []).map(b => ({ language: b.language, code: b.code })),
    usage: result.usage || null
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  // 统一 token 统计:total 永远 = input + output
  const rawUsage = result.usage;
  const usage = rawUsage
    ? { input: rawUsage.input || 0, output: rawUsage.output || 0, total: (rawUsage.input || 0) + (rawUsage.output || 0), estimated: rawUsage.estimated || false }
    : { input: estimateTokens(task), output: estimateTokens(result.content), total: 0, estimated: true };
  usage.total = usage.input + usage.output;
  recordTokens(toolDef, usage, `${duration}s`);
  return { tool: executionName, toolId: toolDef.id, canonicalId: toolDef.canonicalId, displayName: toolDef.displayName, success: true, duration: `${duration}s`, codeBlocks: result.codeBlocks || [], content: result.content, tokens: usage };
}

/** 反向调用客户端(防并发:一个 client 同时只处理一个任务) */
async function executeClient (clientName, task, opts = {}) {
  const client = connectedClients.get(clientName);
  if (!client) throw new Error(`客户端未连接: ${clientName}`);
  if (!client.firstPollAt) throw new Error(`客户端尚未完成首次轮询: ${clientName}`);
  if (clientState(client) === 'stale') throw new Error(`客户端连接已过期: ${clientName}`);

  // CAS: 检查并原子设置 pendingResolve
  if (client.pendingResolve) {
    throw new Error(`客户端 ${clientName} 正在处理另一个任务,请稍后重试`);
  }

  // 立即标记为 busy,防止并发请求绕过检查
  client._busy = true;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const c = connectedClients.get(clientName);
      if (c) {
        c.pendingTask = null;
        c.pendingResolve = null;
        c.pendingReject = null;
        c._busy = false;
      }
      METRICS.clientTimeouts++;
      reject(new Error(`客户端 ${clientName} 响应超时`));
    }, opts.timeout || CONFIG.EXECUTE_TIMEOUT);

    connectedClients.set(clientName, {
      ...client,
      pendingTask: { task, taskId: opts.taskId || `${clientName}_${Date.now()}` },
      pendingResolve: (result) => {
        clearTimeout(timeout);
        const current = connectedClients.get(clientName);
        if (current) current._busy = false;
        resolve(result);
      },
      pendingReject: (err) => {
        clearTimeout(timeout);
        const current = connectedClients.get(clientName);
        if (current) current._busy = false;
        reject(err);
      }
    });
  });
}

async function doDispatch (task, toolNames, autoFallback = true, context = '', withReview = false, reviewerPref = null) {
  // 入参校验
  if (!task || typeof task !== 'string') return { error: '缺少 task 参数' };
  if (task.length > CONFIG.MAX_TASK_LENGTH) return { error: `任务描述过长(>${CONFIG.MAX_TASK_LENGTH}字符)` };
  // tools 入参硬化:非数组一律视为未指定(回退全量可用工具),防畸形入参 crash
  if (toolNames != null && !Array.isArray(toolNames)) toolNames = null;

  // 上下文注入:若有 context 则前置到任务(修复 HTTP 链路静默丢弃上下文的问题)
  const effectiveTask = (context && typeof context === 'string' && context.trim())
    ? `## 上下文\n${context}\n\n## 任务\n${task}`
    : task;

  // 并发限制
  if (activeDispatchCount >= CONFIG.MAX_CONCURRENT_DISPATCH) {
    return { error: `并发数已达上限(${CONFIG.MAX_CONCURRENT_DISPATCH}),请稍后重试` };
  }
  activeDispatchCount++;
  const dispatchId = `dispatch_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const dispatchStart = Date.now();
  METRICS.dispatchTotal++;
  activeDispatches.add(dispatchId);

  try {
    const allTools = await getAllTools();
    const availableTools = allTools.filter(t => t.available);
    const availableNames = availableTools.map(t => t.name);
    // 智能路由:未指定 tools 时按真实历史构建可解释综合评分；失败仍有接力链兜底。
    let routing = { mode: 'manual' };
    let coolingToolIds = new Set();
    let targets;
    if (toolNames && toolNames.length > 0) {
      targets = toolNames
        .map(ref => resolveToolReference(ref, availableTools))
        .filter(Boolean)
        .filter(t => isToolEnabled(t))
        .map(t => t.name);
    } else {
      const enabledTools = availableTools.filter(t => isToolEnabled(t));
      const tokenStats = loadJSON(STATS_FILE);
      const profiles = enabledTools.map(t => buildToolRoutingProfile(t, allTools, tokenStats));
      const ranking = rankRoutingProfiles(profiles, task).map(row => ({
        tool: row.tool,
        toolId: row.toolId,
        canonicalId: row.canonicalId,
        category: row.category,
        score: row.score,
        calls: row.calls,
        successes: row.successes,
        averageDurationMs: row.averageDurationMs,
        averageTokens: row.averageTokens,
        lastObservedAt: row.lastObservedAt,
        lastSuccessAt: row.lastSuccessAt,
        lastFailureAt: row.lastFailureAt,
        coolingDown: row.coolingDown,
        cooldownUntil: row.cooldownUntil,
        components: row.components,
        explorationBonus: row.explorationBonus,
        reason: row.reason
      }));
      coolingToolIds = new Set(ranking.filter(row => row.coolingDown).map(row => row.toolId));
      const selectable = ranking.filter(row => !row.coolingDown);
      targets = selectable.length > 0 ? [selectable[0].tool] : [];
      routing = {
        mode: 'auto',
        strategy: 'composite-v1',
        taskCategory: classifyTask(task),
        selected: targets[0] || null,
        selectedId: selectable[0]?.toolId || null,
        selectedReason: selectable[0]?.reason || null,
        ranking
      };
    }
    targets = [...new Set(targets)];
    const skipped = (toolNames || []).filter(ref => {
      const tool = resolveToolReference(ref, availableTools);
      return tool && !isToolEnabled(tool);
    });

    if (targets.length === 0) {
      return { error: `没有可用工具。检测到: ${availableNames.join(', ') || '无'}` };
    }

    const rawResults = await Promise.allSettled(
      targets.map(async (name) => {
        try {
          const result = await executeTool(name, effectiveTask);
          const check = isToolFailed(result, null);
          if (check.failed) return { tool: name, failed: true, reason: check.reason, partialCode: check.partialCode, result };
          return { tool: name, failed: false, result };
        } catch (e) {
          return { tool: name, failed: true, reason: e.message, partialCode: '' };
        }
      })
    );

    const fallbackLog = [];
    const usedFallback = new Set(); // 防止同一个接力工具被多个失败目标重复占用
    if (autoFallback) {
      for (let i = 0; i < rawResults.length; i++) {
        const r = rawResults[i];
        if (r.status !== 'fulfilled' || !r.value.failed) continue;
        const failed = r.value;
        const others = targets.filter(n => n !== failed.tool);
        const okFallback = others.find(n => { const idx = targets.indexOf(n); const rr = rawResults[idx]; return rr.status === 'fulfilled' && !rr.value.failed; });
        if (okFallback) {
          fallbackLog.push({ from: failed.tool, to: okFallback, success: true, skipped: '已有成功结果,无需接力' });
          continue;
        }
        // 接力链:依次尝试所有未用过的可用工具,直到有一个真正成功(而非只试第一个)
        const untried = availableTools.filter(t => !targets.includes(t.name) && isToolEnabled(t) && !usedFallback.has(t.name) && !coolingToolIds.has(t.id)).map(t => t.name);
        const handoffPrompt = `以下是之前另一个 AI 工具写到一半的代码(工具突然限额/断开),请在此基础上继续完成。\n\n## 任务\n${effectiveTask}\n\n## 已有代码(可能不完整)\n\`\`\`\n${failed.partialCode || '(无可用代码,请从头开始)'}\n\`\`\`\n\n请输出完整的最终代码。`;
        for (const fb of untried) {
          usedFallback.add(fb);
          METRICS.fallbackTotal++;
          try {
            const fbResult = await executeTool(fb, handoffPrompt);
            // 接力结果二次校验:接力工具本身也可能限额/断连,别把失败回复当成功
            const fbCheck = isToolFailed(fbResult, null);
            if (fbCheck.failed) { fallbackLog.push({ from: failed.tool, to: fb, success: false, reason: fbCheck.reason }); continue; }
            fallbackLog.push({ from: failed.tool, to: fb, success: true, duration: fbResult.duration });
            rawResults[i] = { status: 'fulfilled', value: { tool: fb, failed: false, result: fbResult, fallback: true, fallbackFrom: failed.tool, fallbackTo: fb } };
            METRICS.fallbackSuccess++;
            break;
          } catch (e2) {
            fallbackLog.push({ from: failed.tool, to: fb, success: false, error: e2.message });
          }
        }
      }
    }

    const results = [];
    let successCount = 0, totalTokens = 0;
    for (let i = 0; i < rawResults.length; i++) {
      const r = rawResults[i];
      const name = targets[i];
      if (r.status === 'fulfilled' && !r.value.failed) {
        successCount++;
        const res = r.value.result;
        totalTokens += res.tokens.total || 0;
        results.push({ tool: r.value.tool || name, toolId: res.toolId, canonicalId: res.canonicalId, displayName: res.displayName, success: true, duration: res.duration, codeBlocks: res.codeBlocks, content: res.content.substring(0, CONFIG.RESULT_MAX_CHARS), tokens: res.tokens, fallback: r.value.fallback || false, fallbackFrom: r.value.fallbackFrom, fallbackTo: r.value.fallbackTo });
      } else if (r.status === 'fulfilled' && r.value.failed) {
        const failedTool = resolveToolReference(name, availableTools);
        results.push({ tool: name, toolId: failedTool?.id || null, canonicalId: failedTool?.canonicalId || null, success: false, reason: r.value.reason });
      } else {
        const failedTool = resolveToolReference(name, availableTools);
        results.push({ tool: name, toolId: failedTool?.id || null, canonicalId: failedTool?.canonicalId || null, success: false, reason: r.reason?.message });
      }
    }

    // 交叉评审闭环:产出后自动派另一工具评审(评审者必须不同于生产者,失败不阻断主结果)
    let review = null;
    if (withReview) {
      if (successCount === 0) {
        review = { skipped: true, reason: '无成功产出,无可评审内容' };
      } else {
        const producer = results.find(r => r.success);
        const tokenStats = loadJSON(STATS_FILE);
        const reviewerProfiles = availableTools
          .filter(t => isToolEnabled(t) && t.name !== producer.tool)
          .map(t => buildToolRoutingProfile(t, allTools, tokenStats));
        const candidates = rankRoutingProfiles(reviewerProfiles, '代码审查 review audit')
          .map(t => t.tool);
        const preferredReviewer = reviewerPref ? resolveToolReference(reviewerPref, availableTools)?.name : null;
        const reviewer = (preferredReviewer && candidates.includes(preferredReviewer)) ? preferredReviewer : candidates[0];
        if (!reviewer) {
          review = { skipped: true, reason: '没有可用的独立评审工具(评审者须不同于生产者)' };
        } else {
          try {
            const code = producer.codeBlocks?.[0]?.code || producer.content || '';
            const rvResult = await executeTool(reviewer, `你是代码评审专家。请评审以下由 ${producer.tool} 生成的代码,指出潜在问题与改进建议,简洁列点。\n\n## 原任务\n${task.substring(0, 2000)}\n\n## 产出代码\n\`\`\`\n${code.substring(0, 4000)}\n\`\`\``, { taskId: `review_${dispatchId}` });
            totalTokens += rvResult.tokens.total || 0;
            review = { reviewer, producer: producer.tool, content: rvResult.content.substring(0, 2000), tokens: rvResult.tokens.total || 0 };
          } catch (e) {
            review = { skipped: true, reviewer, reason: `评审执行失败: ${e.message}` };
          }
        }
      }
      db.recordReview({ id: `review_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`, dispatchId, producer: review.producer || null, reviewer: review.reviewer || null, skipped: !!review.skipped, reason: review.reason || null, content: review.content || '', tokens: review.tokens || 0 });
    }

    // 记录任务到记忆 + 日志 + 全局库写穿
    const elapsedMs = Date.now() - dispatchStart;
    const taskRecord = { id: `task_${Date.now()}`, dispatchId, results, successCount, total: targets.length, totalTokens, fallbackLog, skipped, task: task.substring(0, 200), tools: targets, routing };
    store.recordTask(taskRecord);
    db.recordDispatch({ ...taskRecord, elapsedMs });
    if (successCount > 0) METRICS.dispatchSuccess++; else METRICS.dispatchFail++;
    log('info', `dispatch 完成: ${successCount}/${targets.length} 成功, ${totalTokens} tokens`, { dispatchId, tools: targets, successCount, totalTokens, elapsedMs });
    return { dispatchId, results, successCount, total: targets.length, totalTokens, elapsedMs, fallbackLog, skipped, routing, ...(review ? { review } : {}) };
  } finally {
    activeDispatches.delete(dispatchId);
    activeDispatchCount--;
  }
}

async function doHandoff (task, existingCode, fromTool, toTool) {
  if (!task) return { error: '缺少 task' };
  if (!existingCode) return { error: '缺少 existing_code' };
  if (!toTool) return { error: '缺少 to' };

  const allTools = await getAllTools();
  const target = resolveToolReference(toTool, allTools);
  if (!target) return { error: `未知或有歧义的工具: ${toTool}` };
  if (!target.available) return { error: `${target.displayName} 不可用` };
  if (!isToolEnabled(target)) return { error: `${target.displayName} 开关已关闭` };

  const handoffPrompt = `以下是之前另一个 AI 工具写到一半的代码,请在此基础上继续完成。\n\n## 还需要完成的任务\n${task}\n\n## 已有代码\n\`\`\`\n${existingCode}\n\`\`\`\n\n请基于已有代码继续完成,输出完整的最终代码。`;
  try {
    const result = await executeTool(target.name, handoffPrompt);
    return { success: true, tool: target.name, toolId: target.id, canonicalId: target.canonicalId, displayName: target.displayName, duration: result.duration, codeBlocks: result.codeBlocks, content: result.content, tokens: result.tokens, from: fromTool || 'unknown' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── HTTP 路由(带全局 try/catch + 鉴权 + CORS 限制) ──

function checkAuth (req) {
  if (!CONFIG.AUTH_TOKEN) return true;
  const auth = req.headers['authorization'];
  return auth === `Bearer ${CONFIG.AUTH_TOKEN}`;
}

function sendJSON (res, code, data) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  // CORS 只允许本地,不再通配
  if (CONFIG.CORS_ORIGIN) headers['Access-Control-Allow-Origin'] = CONFIG.CORS_ORIGIN;
  else headers['Access-Control-Allow-Origin'] = 'http://127.0.0.1:' + CONFIG.PORT;
  res.writeHead(code, headers);
  res.end(JSON.stringify(data));
}

function readBody (req, cap = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', c => {
      body += c; size += c.length;
      if (size > cap) { reject(new Error('请求体过大')); req.destroy(); return; }
    });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve({}); } });
    req.on('error', reject);
  });
}

// ── 透传代理(全局观测层):/proxy/<source>/<key>/<上游路径> ──
const PROXY_TIMEOUT = parseInt(process.env.AI_BRIDGE_PROXY_TIMEOUT) || 600000;
const PROXY_MAX_BODY = 20 * 1024 * 1024; // LLM 长上下文请求体可达数 MB,独立于 readBody 的 1MB 上限

function readRawBody (req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > cap) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 从响应文本尽力提取用量(OpenAI prompt/completion_tokens 与 Anthropic input/output_tokens 两种风格;SSE 取末次出现值)
function extractUsage (text) {
  if (!text) return null;
  const grab = (re) => { let m; let last = null; while ((m = re.exec(text))) last = parseInt(m[1]); return last; };
  const input = grab(/"prompt_tokens"\s*:\s*(\d+)/g) ?? grab(/"input_tokens"\s*:\s*(\d+)/g);
  const output = grab(/"completion_tokens"\s*:\s*(\d+)/g) ?? grab(/"output_tokens"\s*:\s*(\d+)/g);
  if (input === null && output === null) return null;
  return { input: input || 0, output: output || 0 };
}

async function handleProxy (req, res, p, search) {
  const parts = p.split('/').filter(Boolean); // ['proxy', source, key, ...rest]
  if (parts.length < 3) { sendJSON(res, 400, { error: '路径格式: /proxy/<source>/<key>/<上游路径>' }); return; }
  const source = parts[1];
  const key = parts[2];
  const route = observe.getRoute(source, key);
  if (!route) { sendJSON(res, 404, { error: `未登记的代理路由: ${source}/${key}` }); return; }
  const started = Date.now();
  let body;
  try { body = await readRawBody(req, PROXY_MAX_BODY); } catch (e) { sendJSON(res, 413, { error: e.message }); return; }
  // 只提取模型名用于观测,绝不落盘请求正文/鉴权头
  let model = null;
  try { if (body.length && body.length < 2 * 1024 * 1024) model = JSON.parse(body.toString('utf-8')).model || null; } catch (_) {}
  const restPath = parts.length > 3 ? '/' + parts.slice(3).join('/') : '';
  let upstreamUrl;
  try { upstreamUrl = new URL(route.upstream + restPath + (search || '')); } catch (e) { sendJSON(res, 502, { error: '上游 URL 非法: ' + e.message }); return; }
  const mod = upstreamUrl.protocol === 'https:' ? https : http;
  const headers = { ...req.headers };
  delete headers.host; delete headers.connection; delete headers['content-length'];
  headers['accept-encoding'] = 'identity'; // 禁压缩,便于解析用量;鉴权头原样透传(密钥始终留在客户端一侧)
  if (body.length) headers['content-length'] = body.length;
  const upReq = mod.request(upstreamUrl, { method: req.method, headers, timeout: PROXY_TIMEOUT }, upRes => {
    res.writeHead(upRes.statusCode, upRes.headers);
    let captured = ''; // 仅缓存前 256KB 文本供用量解析,流式内容原样直通
    upRes.on('data', c => { if (captured.length < 256 * 1024) captured += c.toString('utf-8'); res.write(c); });
    upRes.on('end', () => {
      res.end();
      const usage = extractUsage(captured);
      db.recordEvent({
        source, channel: 'proxy', type: 'llm_request', model,
        inputTokens: usage?.input || 0, outputTokens: usage?.output || 0,
        durationMs: Date.now() - started, success: upRes.statusCode < 400,
        detail: `${req.method} ${restPath || '/'} → ${upRes.statusCode}`
      });
    });
  });
  upReq.on('timeout', () => upReq.destroy(new Error('上游超时')));
  upReq.on('error', e => {
    db.recordEvent({
      source, channel: 'proxy', type: 'llm_request', model,
      durationMs: Date.now() - started, success: false,
      detail: ('上游错误: ' + e.message).substring(0, 200)
    });
    if (!res.headersSent) sendJSON(res, 502, { error: '上游请求失败: ' + e.message });
    else res.end();
  });
  if (body.length) upReq.write(body);
  upReq.end();
}

const server = http.createServer(async (req, res) => {
  // 全局错误处理:任何未捕获异常不会崩溃服务
  try {
    if (isShuttingDown) { sendJSON(res, 503, { error: '服务正在关闭' }); return; }

    const url = new URL(req.url, `http://${CONFIG.HOST}:${CONFIG.PORT}`);
    const p = url.pathname;

    // CORS preflight(限制来源)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': CONFIG.CORS_ORIGIN || `http://127.0.0.1:${CONFIG.PORT}`,
        'Access-Control-Allow-Methods': 'GET,POST',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      res.end();
      return;
    }

    // 健康检查(免鉴权/免工具检测,供守护进程/服务管理器探活)
    if (p === '/api/health' && req.method === 'GET') {
      sendJSON(res, 200, {
        status: isShuttingDown ? 'shutting_down' : 'ok',
        uptime: Math.floor((Date.now() - START_TIME) / 1000),
        port: CONFIG.PORT,
        clients: onlineClientCount(),
        activeDispatches: activeDispatchCount,
        dispatchTotal: METRICS.dispatchTotal,
        version: '1.1'
      });
      return;
    }

    // 透传代理(免鉴权:被接管工具不感知中枢存在;仅监听本地回环,风险受控)
    if (p.startsWith('/proxy/')) {
      await handleProxy(req, res, p, url.search);
      return;
    }

    // 鉴权:API 端点需要 Token(如果配置了)
    if (p.startsWith('/api/') && !checkAuth(req)) {
      sendJSON(res, 401, { error: '未授权' });
      return;
    }

    // Web UI(不需要鉴权,但只允许本地访问)
    if (p === '/' && req.method === 'GET') {
      const html = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (p === '/api/tools' && req.method === 'GET') {
      const allTools = await getAllTools();
      const sw = loadJSON(SWITCHES_FILE);
      const stats = loadJSON(STATS_FILE);
      const tools = allTools.map(t => {
        const usage = aggregateTokenStats(t, stats, allTools);
        return {
          name: t.name, id: t.id, canonicalId: t.canonicalId, sourceId: t.sourceId,
          aliases: t.aliases, displayName: t.displayName, description: t.description,
          available: t.available, enabled: isToolEnabled(t, sw),
          type: t.type || 'cli',
          tokens: usage.total, calls: usage.calls,
          lastUsed: usage.lastUsed, lastDuration: usage.lastDuration
        };
      });
      const total = stats.total || { input: 0, output: 0, total: 0, calls: 0 };
      sendJSON(res, 200, { tools, total });
      return;
    }

    if (p === '/api/toggle' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.tool) { sendJSON(res, 400, { error: '缺少 tool 参数' }); return; }
      const allTools = await getAllTools();
      const tool = resolveToolReference(body.tool, allTools);
      if (!tool) { sendJSON(res, 404, { error: `未知或有歧义的工具: ${body.tool}` }); return; }
      const sw = loadJSON(SWITCHES_FILE);
      sw[tool.id] = !!body.enabled;
      saveJSONSync(SWITCHES_FILE, sw);
      refreshToolStatus();
      sendJSON(res, 200, { success: true, tool: tool.name, toolId: tool.id, canonicalId: tool.canonicalId, enabled: !!body.enabled });
      return;
    }

    // ── 全局观测:配置接管/还原/代理路由/事件上报/用量洞察 ──

    if (p === '/api/observe/status' && req.method === 'GET') {
      sendJSON(res, 200, observe.status());
      return;
    }

    if (p === '/api/observe/takeover' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.tool || typeof body.tool !== 'string') { sendJSON(res, 400, { error: '缺少 tool 参数' }); return; }
      try {
        const r = observe.takeover(body.tool, `http://127.0.0.1:${CONFIG.PORT}`);
        log('info', `观测接管: ${body.tool} (${r.changed.join(',')})`);
        sendJSON(res, 200, { success: true, ...r });
      } catch (e) { sendJSON(res, 400, { error: e.message }); }
      return;
    }

    if (p === '/api/observe/restore' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.tool || typeof body.tool !== 'string') { sendJSON(res, 400, { error: '缺少 tool 参数' }); return; }
      try {
        const r = observe.restore(body.tool);
        log('info', `观测还原: ${body.tool}`);
        sendJSON(res, 200, { success: true, ...r });
      } catch (e) { sendJSON(res, 400, { error: e.message }); }
      return;
    }

    // 手动登记代理路由(未进注册表的工具也能接入观测)
    if (p === '/api/observe/route' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.source || !body.key || !body.upstream) { sendJSON(res, 400, { error: 'source/key/upstream 必填' }); return; }
      try {
        observe.addRoute(String(body.source), String(body.key), String(body.upstream));
        sendJSON(res, 200, { success: true, route: `${body.source}/${body.key}` });
      } catch (e) { sendJSON(res, 400, { error: e.message }); }
      return;
    }

    // 事件上报(hooks/bridge-stdio 等工具侧主动推送)
    if (p === '/api/telemetry' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.source || typeof body.source !== 'string' || !Array.isArray(body.events)) {
        sendJSON(res, 400, { error: 'source(字符串)与 events(数组)必填' });
        return;
      }
      let recorded = 0;
      for (const ev of body.events.slice(0, 100)) {
        if (!ev || typeof ev !== 'object') continue;
        const detail = ev.detail ? String(ev.detail).substring(0, 2000).replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***') : null;
        const ok = db.recordEvent({
          source: body.source, channel: 'telemetry', type: ev.type, model: ev.model,
          inputTokens: Number(ev.inputTokens) || 0, outputTokens: Number(ev.outputTokens) || 0,
          durationMs: Number(ev.durationMs) || 0, success: ev.success !== false, detail
        });
        if (ok) recorded++;
      }
      sendJSON(res, 200, { success: true, recorded });
      return;
    }

    if (p === '/api/insights' && req.method === 'GET') {
      const days = Math.min(parseInt(url.searchParams.get('days')) || 7, 365);
      sendJSON(res, 200, { days, dbAvailable: db.available, summary: db.eventsSummary(days) });
      return;
    }

    if (p === '/api/refresh' && req.method === 'POST') {
      refreshToolStatus();
      sendJSON(res, 200, { success: true });
      return;
    }

    if (p === '/api/dispatch' && req.method === 'POST') {
      const body = await readBody(req);
      // 异步模式:立即返回 taskId,后台执行,结果写内存表+全局库(跨重启可查)
      if (body.async === true) {
        if (!body.task || typeof body.task !== 'string') { sendJSON(res, 400, { error: '缺少 task 参数' }); return; }
        if (body.task.length > CONFIG.MAX_TASK_LENGTH) { sendJSON(res, 400, { error: `任务描述过长(>${CONFIG.MAX_TASK_LENGTH}字符)` }); return; }
        const taskId = `atask_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        rememberAsyncTask(taskId, { status: 'running', result: null, ts: new Date().toISOString() });
        db.createAsyncTask(taskId, body.task);
        doDispatch(body.task, body.tools, body.auto_fallback !== false, body.context, body.review === true, body.reviewer || null)
          .then(r => {
            const status = r.error ? 'failed' : 'done';
            rememberAsyncTask(taskId, { status, result: r, ts: new Date().toISOString() });
            db.finishAsyncTask(taskId, status, r);
          })
          .catch(e => {
            rememberAsyncTask(taskId, { status: 'failed', result: { error: e.message }, ts: new Date().toISOString() });
            db.finishAsyncTask(taskId, 'failed', { error: e.message });
          });
        sendJSON(res, 202, { taskId, status: 'running', message: '任务已入队,用 GET /api/task/' + taskId + ' 查询结果' });
        return;
      }
      const result = await doDispatch(body.task, body.tools, body.auto_fallback !== false, body.context, body.review === true, body.reviewer || null);
      sendJSON(res, 200, result);
      return;
    }

    // ── 异步任务查询(内存优先,其次全局库——重启后仍可查历史/孤儿状态) ──
    if (p.startsWith('/api/task/') && req.method === 'GET') {
      const id = p.split('/').pop();
      const inMem = asyncTaskResults.get(id);
      if (inMem) { sendJSON(res, 200, { taskId: id, ...inMem }); return; }
      const row = db.getAsyncTask(id);
      if (row) { sendJSON(res, 200, { taskId: id, status: row.status, result: row.result, ts: row.ts, finishedAt: row.finished_at }); return; }
      sendJSON(res, 404, { error: '任务不存在' });
      return;
    }

    // ── 全局库统计(跨重启/跨项目的长期沉淀层) ──
    if (p === '/api/db/stats' && req.method === 'GET') {
      sendJSON(res, 200, db.stats());
      return;
    }

    if (p === '/api/handoff' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await doHandoff(body.task, body.existing_code, body.from, body.to);
      sendJSON(res, 200, result);
      return;
    }

    if (p === '/api/stats' && req.method === 'GET') {
      sendJSON(res, 200, loadJSON(STATS_FILE));
      return;
    }

    // ── 运行指标(可观测性:计数器 + 配置快照 + 数据文件体积) ──
    if (p === '/api/metrics' && req.method === 'GET') {
      const dataFileBytes = {};
      for (const [k, f] of Object.entries(store.FILES)) {
        try { dataFileBytes[k] = fs.existsSync(f) ? fs.statSync(f).size : 0; } catch (_) { dataFileBytes[k] = -1; }
      }
      sendJSON(res, 200, {
        uptime: Math.floor((Date.now() - START_TIME) / 1000),
        clients: onlineClientCount(),
        activeDispatches: activeDispatchCount,
        counters: METRICS,
        config: {
          maxConcurrentDispatch: CONFIG.MAX_CONCURRENT_DISPATCH,
          maxConcurrentMeetings: CONFIG.MAX_CONCURRENT_MEETINGS,
          maxMeetingTokens: CONFIG.MAX_MEETING_TOKENS,
          meetingMaxMs: CONFIG.MEETING_MAX_MS,
          clientTtlMs: CONFIG.CLIENT_TTL,
          authEnabled: !!CONFIG.AUTH_TOKEN
        },
        dataFileBytes,
        db: { available: db.available, path: db.dbPath }
      });
      return;
    }

    if (p === '/api/clients' && req.method === 'GET') {
      const acl = store.loadACL();
      const approvedIds = new Set(acl.allowlist.map(assignedClientId));
      const allIds = new Set([...approvedIds, ...connectedClients.keys()]);
      const clients = [...allIds].map(id => {
        const live = connectedClients.get(id);
        if (live) return clientView(id, live, approvedIds.has(id) || acl.allowlist.includes(live.name));
        const tombstone = clientTombstones.get(id);
        return {
          ...clientView(id, null, true),
          name: tombstone?.name || id.replace(/^client-/, ''),
          lastSeen: tombstone?.lastSeen ? new Date(tombstone.lastSeen).toISOString() : null,
          lastError: tombstone?.lastError || null,
          disconnectReason: tombstone?.disconnectReason || null,
          disconnectedAt: tombstone?.disconnectedAt ? new Date(tombstone.disconnectedAt).toISOString() : null
        };
      }).sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));
      const onlineCount = clients.filter(c => c.online).length;
      sendJSON(res, 200, { clients, count: onlineCount, totalApproved: approvedIds.size, pending: acl.pending, allowlist: acl.allowlist, blocklist: acl.blocklist });
      return;
    }

    if (p === '/api/client/register' && req.method === 'POST') {
      const body = await readBody(req);
      const clientId = body.name || `client-${Date.now()}`;
      // 防同名:如果已存在同名 CLI 工具,加前缀
      const finalName = assignedClientId(clientId);

      // ── 准入控制:白名单 + 手动审批 ──
      const acl = store.loadACL();
      // 1) 黑名单:直接拒绝
      if (acl.blocklist.includes(finalName) || acl.blocklist.includes(clientId)) {
        log('warn', `客户端 ${finalName} 在黑名单,拒绝加入`);
        sendJSON(res, 403, { success: false, status: 'denied', clientId: finalName, message: '已被管理员拒绝加入' });
        return;
      }
      // 2) 白名单:放行
      if (acl.allowlist.includes(finalName) || acl.allowlist.includes(clientId)) {
        const old = connectedClients.get(finalName);
        if (old) {
          // 注册接口幂等：保留在途任务。若旧连接已 stale，则显式进入 reconnecting，
          // 仍须重新完成一次 poll 才能恢复为在线。
          const wasStale = clientState(old) === 'stale';
          old.lastSeen = Date.now();
          if (typeof body.capabilities?.sampling === 'boolean') old.supportsSampling = body.capabilities.sampling;
          if (wasStale) {
            old.firstPollAt = null;
            old.reconnectCount = (old.reconnectCount || 0) + 1;
            old.lastError = null;
            old.disconnectReason = null;
          }
          sendJSON(res, 200, { success: true, status: 'approved', clientId: finalName, reused: true, lifecycle: clientState(old) });
          return;
        }
        const now = Date.now();
        const tombstone = clientTombstones.get(finalName);
        connectedClients.set(finalName, {
          name: clientId,
          connectedAt: new Date(now).toISOString(),
          registeredAt: now,
          firstPollAt: null,
          lastSeen: now,
          reconnectCount: tombstone ? 1 : 0,
          supportsSampling: body.capabilities?.sampling === true,
          lastError: null,
          disconnectReason: null
        });
        clientTombstones.delete(finalName);
        // 加入后从待审批队列清除
        if (acl.pending.some(pd => pd.clientId === finalName)) {
          acl.pending = acl.pending.filter(pd => pd.clientId !== finalName);
          store.saveACL(acl);
        }
        log('info', `客户端 ${finalName} 已加入(白名单)`);
        sendJSON(res, 200, { success: true, status: 'approved', clientId: finalName, reused: false, lifecycle: 'connecting', supportsSampling: body.capabilities?.sampling === true });
        return;
      }
      // 3) 陌生客户端:进待审批队列,不占用调度
      if (!acl.pending.some(pd => pd.clientId === finalName)) {
        acl.pending.push({ clientId: finalName, name: clientId, requestedAt: new Date().toISOString() });
        store.saveACL(acl);
      }
      log('info', `客户端 ${finalName} 请求加入,进入待审批队列`);
      sendJSON(res, 200, { success: false, status: 'pending', clientId: finalName, message: '等待管理员批准' });
      return;
    }

    // ── 准入管理:批准 ──
    if (p === '/api/clients/approve' && req.method === 'POST') {
      const body = await readBody(req);
      const id = body.clientId;
      if (!id) { sendJSON(res, 400, { error: '缺少 clientId' }); return; }
      const acl = store.loadACL();
      if (!acl.allowlist.includes(id)) acl.allowlist.push(id);
      acl.blocklist = acl.blocklist.filter(x => x !== id);
      acl.pending = acl.pending.filter(pd => pd.clientId !== id);
      store.saveACL(acl);
      log('info', `客户端 ${id} 已批准加入`);
      sendJSON(res, 200, { success: true, clientId: id, status: 'approved' });
      return;
    }

    // ── 准入管理:拒绝(拉黑) ──
    if (p === '/api/clients/deny' && req.method === 'POST') {
      const body = await readBody(req);
      const id = body.clientId;
      if (!id) { sendJSON(res, 400, { error: '缺少 clientId' }); return; }
      const acl = store.loadACL();
      const aclKeys = aclClientKeys(id);
      if (!acl.blocklist.includes(id)) acl.blocklist.push(id);
      acl.allowlist = acl.allowlist.filter(x => !aclKeys.includes(x));
      acl.pending = acl.pending.filter(pd => !aclKeys.includes(pd.clientId));
      store.saveACL(acl);
      // 若已连接,同时踢出
      const client = connectedClients.get(id);
      if (client) {
        if (client.pendingReject) client.pendingReject(new Error('已被管理员拒绝'));
        rememberClientDisconnect(id, client, 'admin_denied');
        connectedClients.delete(id);
      }
      log('info', `客户端 ${id} 已被拒绝并拉黑`);
      sendJSON(res, 200, { success: true, clientId: id, status: 'denied' });
      return;
    }

    // ── 准入管理:踢出(可选拉黑) ──
    if (p === '/api/clients/kick' && req.method === 'POST') {
      const body = await readBody(req);
      const id = body.clientId;
      if (!id) { sendJSON(res, 400, { error: '缺少 clientId' }); return; }
      const client = connectedClients.get(id);
      if (client) {
        if (client.pendingReject) client.pendingReject(new Error('已被管理员踢出'));
        rememberClientDisconnect(id, client, body.block ? 'admin_blocked' : 'admin_kicked');
        connectedClients.delete(id);
      }
      const acl = store.loadACL();
      const aclKeys = aclClientKeys(id);
      // 踢出同时移出白名单,避免立即自动重连(需重新审批);block=true 则拉黑。
      // 同时移除同名 CLI 冲突客户端的原始授权名（如 openclaw/client-openclaw）。
      acl.allowlist = acl.allowlist.filter(x => !aclKeys.includes(x));
      if (body.block && !acl.blocklist.includes(id)) acl.blocklist.push(id);
      store.saveACL(acl);
      log('info', `客户端 ${id} 已被踢出${body.block ? '并拉黑' : ''}`);
      sendJSON(res, 200, { success: true, clientId: id, kicked: !!client, blocked: !!body.block });
      return;
    }

    if (p === '/api/client/unregister' && req.method === 'POST') {
      const body = await readBody(req);
      const client = connectedClients.get(body.clientId);
      if (client?.pendingReject) client.pendingReject(new Error('客户端断开'));
      if (client) rememberClientDisconnect(body.clientId, client, body.reason || 'client_unregister', body.error || null);
      connectedClients.delete(body.clientId);
      sendJSON(res, 200, { success: true, lifecycle: 'approved_offline' });
      return;
    }

    // 长轮询(带 req 关闭检测,防泄漏)
    if (p === '/api/poll' && req.method === 'POST') {
      const body = await readBody(req);
      const client = connectedClients.get(body.clientId);
      if (!client) { sendJSON(res, 404, { error: '未注册' }); return; }
      const now = Date.now();
      client.lastSeen = now; // 轮询即视为活跃,TTL 按最后活动时间判定
      if (!client.firstPollAt) client.firstPollAt = now; // 首轮 poll 是健康在线的边界
      client.lastError = null;
      client.disconnectReason = null;

      if (client.pendingTask) {
        sendJSON(res, 200, { task: client.pendingTask });
        connectedClients.set(body.clientId, { ...client, pendingTask: null, taskPending: true });
        return;
      }

      // 长轮询:等 30 秒,但 req 关闭时立即清理
      let resolved = false;
      const finish = (data) => {
        if (resolved) return;
        resolved = true;
        clearInterval(interval);
        clearTimeout(pollTimer); // 修:超时定时器一并清理,防每个已完成请求挂 30 秒闭包
        sendJSON(res, 200, data);
      };

      const interval = setInterval(() => {
        const c = connectedClients.get(body.clientId);
        // 必须仍是本次 poll 启动时捕获的连接对象。注销后同 ID 重注册会创建新对象，
        // 旧长轮询不得跨会话抢走新连接的任务。
        if (!c || c !== client) {
          finish({ task: null });
          return;
        }
        c.lastSeen = Date.now(); // 打开的长轮询就是活跃心跳
        if (c.pendingTask) {
          finish({ task: c.pendingTask });
          connectedClients.set(body.clientId, { ...c, pendingTask: null, taskPending: true });
        }
      }, 1000);

      // 30 秒超时
      const pollTimer = setTimeout(() => finish({ task: null }), CONFIG.POLL_TIMEOUT);

      // req 关闭时清理(防泄漏)
      req.on('close', () => finish({ task: null }));
      return;
    }

    // 提交结果(防过期:检查 pendingResolve 是否存在)
    if (p === '/api/result' && req.method === 'POST') {
      const body = await readBody(req);
      const client = connectedClients.get(body.clientId);
      if (client && client.pendingResolve) {
        // 客户端明确上报 failed 时走 reject:让 dispatch 接力链/会议失败标注正确生效,不再把失败当成功记入成功率
        if (body.failed === true) {
          client.pendingReject(new Error((body.content || '客户端执行失败').substring(0, 300)));
        } else {
          const result = { content: body.content || '', codeBlocks: body.codeBlocks || [], usage: body.usage || null };
          client.pendingResolve(result);
        }
        connectedClients.set(body.clientId, { ...client, pendingResolve: null, pendingReject: null, taskPending: false, _busy: false, lastSeen: Date.now(), lastError: body.failed === true ? (body.content || '客户端执行失败').substring(0, 300) : null });
        sendJSON(res, 200, { success: true });
      } else {
        // pendingResolve 已过期(超时被清了),通知客户端;留 warn 日志便于事后追查丢结果
        log('warn', `结果抵达但 pending 已被超时清空,结果丢弃: clientId=${body.clientId || ''} taskId=${body.taskId || ''} contentLength=${(body.content || '').length}`);
        sendJSON(res, 200, { success: false, reason: '任务已超时,结果被丢弃' });
      }
      return;
    }

    // ── 记忆 API ──
    if (p === '/api/memory/search' && req.method === 'POST') {
      const body = await readBody(req);
      const results = store.searchMemory(body.query || '');
      sendJSON(res, 200, results);
      return;
    }

    if (p === '/api/memory/recent' && req.method === 'GET') {
      const limit = Math.max(1, parseInt(url.searchParams.get('limit') || '10') || 10);
      sendJSON(res, 200, { tasks: store.getRecentTasks(limit) });
      return;
    }

    if (p === '/api/memory/experience' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.content) { sendJSON(res, 400, { error: '缺少 content' }); return; }
      store.writeExperience(body.category || 'general', body.content, body.tags || []);
      sendJSON(res, 200, { success: true });
      return;
    }

    if (p === '/api/memory/stats' && req.method === 'GET') {
      sendJSON(res, 200, store.getToolStats());
      return;
    }

    // ── 日志 API ──
    if (p === '/api/logs' && req.method === 'GET') {
      const level = url.searchParams.get('level') || null;
      const limit = Math.max(1, parseInt(url.searchParams.get('limit') || '50') || 50);
      const since = url.searchParams.get('since') || null;
      sendJSON(res, 200, { logs: store.readLogs({ level, limit, since }) });
      return;
    }

    if (p === '/api/logs/clear' && req.method === 'POST') {
      store.clearLogs();
      sendJSON(res, 200, { success: true });
      return;
    }

    // ── 流量日志 API(完整内容,SQLite 查询) ──
    if (p === '/api/traffic' && req.method === 'GET') {
      const tool = url.searchParams.get('tool') || null;
      const direction = url.searchParams.get('direction') || null;
      const source = url.searchParams.get('source') || null;
      const limit = Math.max(1, parseInt(url.searchParams.get('limit') || '50') || 50);
      const since = url.searchParams.get('since') || null;
      // bridge 流量 + AgnesCode llm_request 采集
      const bridgeTraffic = db.queryTraffic({ tool, direction, source: source || null, limit, since });
      // 如果请求包含 source=agnes 或 source=all，也查 AgnesCode 日志
      let agnesTraffic = [];
      if (!source || source === 'agnes' || source === 'all') {
        agnesTraffic = readAgnesLLMLogs({ limit, since });
      }
      const combined = [...bridgeTraffic, ...agnesTraffic].sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, limit);
      sendJSON(res, 200, { traffic: combined, count: combined.length });
      return;
    }

    if (p === '/api/traffic/clear' && req.method === 'POST') {
      db.clearTraffic();
      sendJSON(res, 200, { success: true });
      return;
    }

    // ── mitmproxy 流量采集端点(由 mitm-addon.py 回调) ──
    if (p === '/api/traffic/capture' && req.method === 'POST') {
      const body = await readBody(req);
      db.recordTraffic({
        ts: body.ts || new Date().toISOString(),
        direction: body.direction || 'out',
        tool: String(body.tool || 'unknown').substring(0, 120),
        taskId: body.taskId || null,
        type: body.type || 'mitm-proxy',
        source: 'mitm',
        content: body.content || '',
        usage: null,
        success: body.status_code ? body.status_code < 400 : null,
        error: body.status_code && body.status_code >= 400 ? `HTTP ${body.status_code}` : null
      });
      sendJSON(res, 200, { success: true });
      return;
    }

    // ── mitmproxy 控制端点 ──
    if (p === '/api/mitm/status' && req.method === 'GET') {
      // 检查 mitmproxy 是否在运行(尝试连接 8888 端口)
      const net = require('net');
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.on('connect', () => { try { socket.destroy(); } catch(_){} sendJSON(res, 200, { running: true, port: 8888 }); });
      socket.on('error', () => sendJSON(res, 200, { running: false, port: 8888 }));
      socket.on('timeout', () => { try { socket.destroy(); } catch(_){} sendJSON(res, 200, { running: false, port: 8888 }); });
      socket.connect(8888, '127.0.0.1');
      return;
    }

    // ── OpenAI 兼容反代:把各 AI 编程软件绑定的免费订阅统一以 OpenAI 格式暴露 ──
    // 模型清单由 models.json 动态生成,受 switches 开关约束(禁用的工具不出现在清单里)
    if (p === '/v1/models' && req.method === 'GET') {
      const created = Math.floor(START_TIME / 1000);
      const data = loadModels().filter(modelEnabled).map(m => ({
        id: m.id, object: 'model', created, owned_by: m.owned_by || 'ai-bridge'
      }));
      sendJSON(res, 200, { object: 'list', data });
      return;
    }

    if (p === '/v1/chat/completions' && req.method === 'POST') {
      const body = await readBody(req, PROXY_MAX_BODY);
      const isStream = body.stream === true;
      const model = findModel(body.model);
      if (!model) { sendJSON(res, 404, { error: `未知模型: ${body.model || '(空)'}。可用模型见 GET /v1/models` }); return; }
      if (!modelEnabled(model)) { sendJSON(res, 403, { error: `模型 ${model.id} 已被开关禁用(${model.switch})` }); return; }
      const taskId = `proxy_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

      // ── 分支 A:HTTP 直连订阅(Agnes,支持流式 SSE) ──
      if (model.transport === 'agnes-http') {
        const token = readAgnesToken();
        if (!token) { sendJSON(res, 500, { error: 'AgnesCode token 未找到(Windows 凭据管理器)' }); return; }
        const fwdBody = { ...body, model: model.upstreamModel || model.id };
        const reqData = JSON.stringify(fwdBody);
        db.recordTraffic({ ts: new Date().toISOString(), direction: 'out', tool: model.id, taskId, type: 'openai-proxy', content: JSON.stringify(fwdBody.messages || []).substring(0, 8000), source: 'bridge' });
        const proxyReq = https.request(model.upstream, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqData), 'Authorization': 'Bearer ' + token }
        }, (proxyRes) => {
          if (proxyRes.statusCode !== 200) {
            let errBody = '';
            proxyRes.on('data', d => errBody += d);
            proxyRes.on('end', () => sendJSON(res, proxyRes.statusCode, { error: '上游错误', detail: errBody.substring(0, 500) }));
            return;
          }
          if (isStream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            let fullContent = '';
            proxyRes.on('data', chunk => {
              res.write(chunk);
              for (const line of chunk.toString().split('\n').filter(Boolean)) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  try { fullContent += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || ''; } catch (_) {}
                }
              }
            });
            proxyRes.on('end', () => {
              res.end();
              db.recordTraffic({ ts: new Date().toISOString(), direction: 'in', tool: model.id, taskId, type: 'openai-proxy', success: true, content: fullContent.substring(0, 8000), source: 'bridge' });
              recordTokens(model.id, { input: estimateTokens(JSON.stringify(body.messages || [])), output: estimateTokens(fullContent), estimated: true }, '—');
            });
          } else {
            let respData = '';
            proxyRes.on('data', d => respData += d);
            proxyRes.on('end', () => {
              res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
              res.end(respData);
              try {
                const parsed = JSON.parse(respData);
                db.recordTraffic({ ts: new Date().toISOString(), direction: 'in', tool: model.id, taskId, type: 'openai-proxy', success: true, content: (parsed.choices?.[0]?.message?.content || '').substring(0, 8000), usage: parsed.usage || null, source: 'bridge' });
                if (parsed.usage) recordTokens(model.id, { input: parsed.usage.prompt_tokens || 0, output: parsed.usage.completion_tokens || 0 }, '—');
              } catch (_) {}
            });
          }
        });
        proxyReq.on('error', e => { if (!res.headersSent) sendJSON(res, 502, { error: '上游请求失败', detail: e.message }); else res.end(); });
        proxyReq.write(reqData);
        proxyReq.end();
        return;
      }

      // ── 分支 A2:Codely(团结 Cowork)LiteLLM 转发(先用 access_token 换 cli_api_key,再带特殊 header 转发) ──
      if (model.transport === 'codely-http') {
        let cliKey;
        try {
          cliKey = await getCodelyCliApiKey();
        } catch (e) {
          sendJSON(res, 500, { error: '获取 Codely cli_api_key 失败', detail: String(e.message || e).substring(0, 300) });
          return;
        }
        const fwdBody = { ...body, model: model.upstreamModel || model.id };
        const reqData = JSON.stringify(fwdBody);
        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${cliKey}`,
          'User-Agent': 'codely-cli/1.0.0-release.43 (win32; x64)',
          'x-litellm-session-id': crypto.randomUUID()
        };
        db.recordTraffic({ ts: new Date().toISOString(), direction: 'out', tool: model.id, taskId, type: 'openai-proxy', content: JSON.stringify(fwdBody.messages || []).substring(0, 8000), source: 'bridge' });
        const proxyReq = https.request(`${CODELY_LITELLM_BASE}/v1/chat/completions`, {
          method: 'POST',
          headers
        }, (proxyRes) => {
          if (proxyRes.statusCode !== 200) {
            let errBody = '';
            proxyRes.on('data', d => errBody += d);
            proxyRes.on('end', () => sendJSON(res, proxyRes.statusCode, { error: '上游错误', detail: errBody.substring(0, 500) }));
            return;
          }
          if (isStream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            let fullContent = '';
            proxyRes.on('data', chunk => {
              res.write(chunk);
              for (const line of chunk.toString().split('\n').filter(Boolean)) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  try { fullContent += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || ''; } catch (_) {}
                }
              }
            });
            proxyRes.on('end', () => {
              res.end();
              db.recordTraffic({ ts: new Date().toISOString(), direction: 'in', tool: model.id, taskId, type: 'openai-proxy', success: true, content: fullContent.substring(0, 8000), source: 'bridge' });
              recordTokens(model.id, { input: estimateTokens(JSON.stringify(body.messages || [])), output: estimateTokens(fullContent), estimated: true }, '—');
            });
          } else {
            let respData = '';
            proxyRes.on('data', d => respData += d);
            proxyRes.on('end', () => {
              res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
              res.end(respData);
              try {
                const parsed = JSON.parse(respData);
                db.recordTraffic({ ts: new Date().toISOString(), direction: 'in', tool: model.id, taskId, type: 'openai-proxy', success: true, content: (parsed.choices?.[0]?.message?.content || '').substring(0, 8000), usage: parsed.usage || null, source: 'bridge' });
                if (parsed.usage) recordTokens(model.id, { input: parsed.usage.prompt_tokens || 0, output: parsed.usage.completion_tokens || 0 }, '—');
              } catch (_) {}
            });
          }
        });
        proxyReq.on('error', e => { if (!res.headersSent) sendJSON(res, 502, { error: '上游请求失败', detail: e.message }); else res.end(); });
        proxyReq.write(reqData);
        proxyReq.end();
        return;
      }

      // ── 分支 B:CLI 型订阅(安全 spawn,shell:false;复用经测试的 CliAdapter,无 execSync 拼接注入面) ──
      if (model.transport === 'cli') {
        const prompt = messagesToPrompt(body.messages);
        if (!prompt) { sendJSON(res, 400, { error: '缺少 messages 内容' }); return; }
        const cliCfg = model.cli || {};
        const adapter = new CliAdapter({
          name: model.owned_by || model.id,
          command: cliCfg.command,
          commandPaths: cliCfg.commandPaths || [],
          args: cliCfg.args || ['-p', '{{task}}'],
          inputMode: cliCfg.inputMode || 'arg',
          outputMode: cliCfg.outputMode || 'stdout-text',
          timeout: cliCfg.timeout || 120000
        });
        db.recordTraffic({ ts: new Date().toISOString(), direction: 'out', tool: model.id, taskId, type: 'openai-proxy', content: prompt.substring(0, 8000), source: 'bridge' });
        let result;
        try {
          result = await adapter.execute(prompt, { taskId });
        } catch (e) {
          db.recordTraffic({ ts: new Date().toISOString(), direction: 'in', tool: model.id, taskId, type: 'openai-proxy', success: false, error: e.message, content: '', source: 'bridge' });
          sendJSON(res, 502, { error: `${model.id} CLI 执行失败`, detail: String(e.message || e).substring(0, 300) });
          return;
        }
        // 剔除 CLI 噪声行([warning]/[error] 前缀)
        const content = (result.content || '').split('\n').filter(l => !/^\[(warning|error)\]/i.test(l.trim())).join('\n').trim();
        const usage = { prompt_tokens: estimateTokens(prompt), completion_tokens: estimateTokens(content), total_tokens: 0 };
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        db.recordTraffic({ ts: new Date().toISOString(), direction: 'in', tool: model.id, taskId, type: 'openai-proxy', success: true, content: content.substring(0, 8000), source: 'bridge' });
        recordTokens(model.id, { input: usage.prompt_tokens, output: usage.completion_tokens, estimated: true }, '—');
        const created = Math.floor(Date.now() / 1000);
        if (isStream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          res.write(`data: ${JSON.stringify({ id: taskId, object: 'chat.completion.chunk', created, model: model.id, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: taskId, object: 'chat.completion.chunk', created, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          sendJSON(res, 200, {
            id: taskId, object: 'chat.completion', created, model: model.id,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage
          });
        }
        return;
      }

      sendJSON(res, 500, { error: `模型 ${model.id} 的 transport "${model.transport}" 暂不支持` });
      return;
    }

    // ── 会议/讨论 API ──
    if (p === '/api/discuss' && req.method === 'POST') {
      const body = await readBody(req);
      // 入参硬化:topic 必须是非空字符串;participants 非数组视为未指定(防会议已落盘但执行器未启动的孤儿会议占满并发闸门)
      if (!body.topic || typeof body.topic !== 'string') { sendJSON(res, 400, { error: '缺少或非法 topic(须为非空字符串)' }); return; }
      if (body.participants != null && !Array.isArray(body.participants)) body.participants = null;
      const allTools = await getAllTools();
      // 并发讨论会闸门:放在所有 await 之后、createMeeting 之前,消除检查与落盘之间的时间窗
      const inflightMeetings = (store.loadMemory().meetings || []).filter(m => m.status === 'discussing' || m.status === 'active' || m.status === 'implementing').length;
      if (inflightMeetings >= CONFIG.MAX_CONCURRENT_MEETINGS) {
        sendJSON(res, 429, { error: `并发讨论会已达上限(${CONFIG.MAX_CONCURRENT_MEETINGS}),请等待现有讨论结束` });
        return;
      }
      const participants = body.participants && body.participants.length > 0
        ? body.participants.map(n => resolveToolReference(n, allTools)).filter(t => t?.available && isToolEnabled(t)).map(t => t.name)
        : allTools.filter(t => t.available && isToolEnabled(t)).map(t => t.name);

      if (participants.length === 0) { sendJSON(res, 400, { error: '没有可用的参与工具' }); return; }

      // 自动止损预算:调用方可通过 max_tokens/max_ms 收紧(只能收紧不能放宽,受 CONFIG 硬顶约束)
      const meetingMaxTokens = Math.min(CONFIG.MAX_MEETING_TOKENS, Number.isFinite(body.max_tokens) ? Math.max(0, body.max_tokens) : CONFIG.MAX_MEETING_TOKENS);
      const meetingMaxMs = Math.min(CONFIG.MEETING_MAX_MS, Number.isFinite(body.max_ms) ? Math.max(0, body.max_ms) : CONFIG.MEETING_MAX_MS);

      // 异步讨论:立即返回 meetingId,后台逐轮执行
      const meeting = store.createMeeting(body.topic, participants);
      // 元数据真正落盘:load→找到该会议→赋值→save(原先改游离对象再 save(loadMemory()) 是空操作)
      {
        const mem = store.loadMemory();
        const m = mem.meetings.find(x => x.id === meeting.id);
        if (m) {
          m.status = 'discussing';
          m.round = 0;
          m.guidance = body.guidance || '';
          m.round2Guidance = body.round2_guidance || '';
          m.round2 = body.round2 !== false;
          m.implement = body.implement || false;
          store.saveSync('memory', mem);
        }
      }
      METRICS.meetingsStarted++;
      log('info', `会议 ${meeting.id} 创建(异步), 话题: "${body.topic.substring(0, 60)}", 参与者: ${participants.join(', ')}`);

      // 后台执行讨论(不阻塞 HTTP 响应)
      runDiscussionAsync(meeting.id, body.topic, participants, body.guidance || '', body.round2_guidance || '', body.round2 !== false, body.implement || false, meetingMaxTokens, meetingMaxMs)
        .catch(e => log('error', `会议 ${meeting.id} 异步执行失败: ${e.message}`));

      sendJSON(res, 200, {
        meetingId: meeting.id,
        topic: body.topic,
        participants,
        status: 'discussing',
        messageCount: 0,
        totalTokens: 0,
        budget: { maxTokens: meetingMaxTokens, maxMs: meetingMaxMs },
        message: '讨论已启动,用 GET /api/discuss/status/' + meeting.id + ' 查看进度'
      });
      return;
    }

    // ── 讨论状态查询 ──
    if (p.startsWith('/api/discuss/status/') && req.method === 'GET') {
      const meetingId = p.split('/').pop();
      const meeting = store.getMeeting(meetingId);
      if (!meeting) { sendJSON(res, 404, { error: '会议不存在' }); return; }
      sendJSON(res, 200, {
        meetingId: meeting.id,
        topic: meeting.topic,
        status: meeting.status,
        round: meeting.round || 0,
        participants: meeting.participants,
        messageCount: (meeting.messages || []).length,
        messages: meeting.messages,
        totalTokens: meeting.totalTokens || 0,
        interrupted: meeting.interrupted || false,
        interruptReason: meeting.interruptReason || null,
        summary: meeting.summary || null
      });
      return;
    }

    // ── 当前活跃讨论 ──
    if (p === '/api/discuss/active' && req.method === 'GET') {
      const mem = store.loadMemory();
      const active = (mem.meetings || []).filter(m => m.status === 'discussing' || m.status === 'active');
      sendJSON(res, 200, { meetings: active, count: active.length });
      return;
    }

    // ── 讨论控制:中断 ──
    if (p === '/api/discuss/interrupt' && req.method === 'POST') {
      const body = await readBody(req);
      const mem = store.loadMemory();
      const meeting = mem.meetings.find(m => m.id === body.meetingId);
      if (!meeting) { sendJSON(res, 404, { error: '会议不存在' }); return; }
      meeting.interrupted = true;
      meeting.interruptReason = body.reason || '用户手动中断';
      meeting.status = 'interrupted';
      store.saveSync('memory', mem);
      db.recordMeeting(meeting); // 终态写穿全局库
      log('info', `会议 ${body.meetingId} 被中断: ${body.reason || '手动'}`);
      sendJSON(res, 200, { success: true, meetingId: body.meetingId, reason: meeting.interruptReason, messages: meeting.messages });
      return;
    }

    // ── 讨论控制:注入 ──
    if (p === '/api/discuss/inject' && req.method === 'POST') {
      const body = await readBody(req);
      const mem = store.loadMemory();
      const meeting = mem.meetings.find(m => m.id === body.meetingId);
      if (!meeting) { sendJSON(res, 404, { error: '会议不存在' }); return; }
      if (meeting.status === 'closed' || meeting.status === 'interrupted') {
        sendJSON(res, 400, { error: '会议已' + meeting.status });
        return;
      }
      // 注入主持人消息
      meeting.messages.push({ ts: new Date().toISOString(), speaker: '主持人', content: body.message || '', injected: true });
      // 更新 guidance 供下一轮使用
      if (meeting.guidance) {
        meeting.guidance += '\n' + body.message;
      } else {
        meeting.guidance = body.message;
      }
      store.saveSync('memory', mem);
      log('info', `会议 ${body.meetingId} 主持人注入: ${(body.message || '').substring(0, 60)}`);
      sendJSON(res, 200, { success: true, meetingId: body.meetingId, message: '注入成功,下一轮生效' });
      return;
    }

    if (p === '/api/meetings' && req.method === 'GET') {
      const limit = Math.max(1, parseInt(url.searchParams.get('limit') || '10') || 10);
      sendJSON(res, 200, { meetings: store.getRecentMeetings(limit) });
      return;
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    // 全局兜底:任何异常不崩溃服务
    METRICS.errors5xx++;
    console.error(`[ai-bridge] 未捕获异常: ${err.message}\n${err.stack}`);
    try { sendJSON(res, 500, { error: '内部错误' }); } catch (_) {}
  }
});

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`[ai-bridge] HTTP 服务已启动: http://${CONFIG.HOST}:${CONFIG.PORT}`);
  console.log(`[ai-bridge] Web UI: 浏览器打开 http://${CONFIG.HOST}:${CONFIG.PORT}`);
  console.log(`[ai-bridge] 鉴权: ${CONFIG.AUTH_TOKEN ? '已启用' : '未启用(设置 AI_BRIDGE_TOKEN 环境变量启用)'}`);
  console.log(`[ai-bridge] 并发上限: ${CONFIG.MAX_CONCURRENT_DISPATCH}`);
});

// ── 异步讨论执行器(带顶层 try/catch/finally) ──

async function runDiscussionAsync(meetingId, topic, participants, guidance, round2Guidance, doRound2, doImplement, maxTokens = CONFIG.MAX_MEETING_TOKENS, maxMs = CONFIG.MEETING_MAX_MS) {
  let totalTokens = 0; // 累计实际 token
  const meetingStart = Date.now();
  let autoStop = null; // 非空则记录自动止损原因(token 预算/时长超限)

  // 自动止损判定:token 预算优先,其次壁钟时长;返回原因字符串或 null
  function overBudget () {
    if (totalTokens >= maxTokens) return `token 预算耗尽(${totalTokens}/${maxTokens})`;
    if (Date.now() - meetingStart >= maxMs) return `时长超限(${Math.round((Date.now() - meetingStart) / 1000)}s/${Math.round(maxMs / 1000)}s)`;
    return null;
  }

  function updateMeeting(updates) {
    const mem = store.loadMemory();
    const meeting = mem.meetings.find(m => m.id === meetingId);
    if (!meeting) return null;
    Object.assign(meeting, updates);
    store.saveSync('memory', mem);
    return meeting;
  }

  function checkInterrupted() {
    const mem = store.loadMemory();
    const meeting = mem.meetings.find(m => m.id === meetingId);
    return meeting && (meeting.interrupted || meeting.status === 'interrupted');
  }

  function closeMeeting(summary) {
    updateMeeting({ totalTokens }); // 先把最终 token 落盘,再关会写穿 DB(修:原时序颠倒导致 SQLite 副本 total_tokens 永久少记)
    store.closeMeeting(meetingId, summary);
    db.recordMeeting(store.getMeeting(meetingId)); // 终态写穿全局库(跨重启可查)
  }

  // 自动止损收尾:标注中断原因 + 记一条系统消息 + 关闭会议
  function finalizeAutoStop (reason) {
    METRICS.meetingsAutoStopped++;
    updateMeeting({ interrupted: true, interruptReason: '自动止损: ' + reason });
    store.addMessage(meetingId, '系统', `(自动止损: ${reason},讨论提前结束)`);
    closeMeeting(`自动止损: ${reason}, ${totalTokens} tokens`);
    log('warn', `会议 ${meetingId} 自动止损: ${reason}`);
  }

  try {
    // 第一轮
    updateMeeting({ round: 1, status: 'discussing' });
    log('info', `会议 ${meetingId} 第一轮开始`);
    const round1Results = {};

    for (const name of participants) {
      if (checkInterrupted()) { log('info', `会议 ${meetingId} 第一轮被中断`); break; }
      autoStop = overBudget();
      if (autoStop) { log('warn', `会议 ${meetingId} 第一轮触发自动止损: ${autoStop}`); break; }
      const mem = store.loadMemory();
      const mtg = mem.meetings.find(m => m.id === meetingId);
      const currentGuidance = mtg?.guidance || guidance;
      const gText = currentGuidance ? `\n\n【主持人指示】: ${currentGuidance}` : '';

      try {
        const result = await executeTool(name, `你正在参加一个 AI 技术讨论会。\n\n话题: ${topic}${gText}\n\n请给出你的技术观点和方案,简洁有料。`, { taskId: `${name}_${meetingId}_r1_${Date.now()}` });
        const content = result.content.substring(0, 2000);
        store.addMessage(meetingId, name, content);
        round1Results[name] = { content, tokens: result.tokens.total };
        totalTokens += result.tokens.total;
        log('debug', `会议 ${meetingId}: ${name} 第一轮发言完成, ${result.tokens.total} tokens`);
      } catch (e) {
        store.addMessage(meetingId, name, `(发言失败: ${e.message})`);
        round1Results[name] = { content: `(发言失败: ${e.message})`, tokens: 0 };
      }
    }
    updateMeeting({ totalTokens }); // 每轮结束持久化一次 token(避免每位发言者触发两次全量重写)

    if (autoStop) { finalizeAutoStop(autoStop); return; }
    if (checkInterrupted()) {
      closeMeeting(`第一轮后被中断, ${totalTokens} tokens`);
      log('info', `会议 ${meetingId} 被中断`);
      return;
    }

    // 第二轮
    if (doRound2 && Object.keys(round1Results).length > 1) {
      updateMeeting({ round: 2 });
      log('info', `会议 ${meetingId} 第二轮开始`);

      for (const name of participants) {
        if (checkInterrupted()) { log('info', `会议 ${meetingId} 第二轮被中断`); break; }
        autoStop = overBudget();
        if (autoStop) { log('warn', `会议 ${meetingId} 第二轮触发自动止损: ${autoStop}`); break; }

        const othersText = Object.entries(round1Results)
          .filter(([speaker]) => speaker !== name)
          .filter(([, r]) => r.content && !r.content.startsWith('(发言失败'))
          .map(([speaker, r]) => `${speaker}: ${r.content.substring(0, 500)}`)
          .join('\n\n');

        if (!othersText) continue;

        // 拼接全部注入消息 + round2_guidance(不再二选一)
        const mem = store.loadMemory();
        const mtg = mem.meetings.find(m => m.id === meetingId);
        const injectedMsgs = (mtg?.messages || []).filter(m => m.injected);
        let injectText = '';
        if (injectedMsgs.length > 0) {
          injectText = '\n\n【主持人指示(全部)】:\n' + injectedMsgs.map(m => `- ${m.content}`).join('\n');
        }
        if (round2Guidance) {
          injectText += `\n\n【主持人补充】: ${round2Guidance}`;
        }

        try {
          const result = await executeTool(name, `你正在参加一个 AI 技术讨论会。\n\n话题: ${topic}\n\n以下是其他参与者的观点:\n\n${othersText}${injectText}\n\n请基于讨论,给出你的补充意见或最终结论。`, { taskId: `${name}_${meetingId}_r2_${Date.now()}` });
          store.addMessage(meetingId, name, result.content.substring(0, 2000));
          totalTokens += result.tokens.total;
        } catch (e) {
          store.addMessage(meetingId, name, `(第二轮发言失败: ${e.message})`);
        }
      }
      updateMeeting({ totalTokens }); // 每轮结束持久化一次 token
    }

    if (autoStop) { finalizeAutoStop(autoStop); return; }
    if (checkInterrupted()) {
      closeMeeting(`第二轮后被中断, ${totalTokens} tokens`);
      return;
    }

    // 自动实现前再验一次预算(时长可能在等待中超限)
    const preImplStop = overBudget();
    if (preImplStop) { finalizeAutoStop(preImplStop); return; }

    // 共识引擎:讨论正常结束后自动生成共识总结(结论/分歧/行动项),沉淀到经验库供 memory_search 复用
    const speeches = (store.getMeeting(meetingId)?.messages || []).filter(m => m.content && !m.content.startsWith('(') && m.speaker !== '主持人' && m.speaker !== '系统');
    if (speeches.length >= 2 && !overBudget()) {
      try {
        const digest = speeches.map(m => `【${m.speaker}】: ${m.content.substring(0, 800)}`).join('\n\n');
        const sumResult = await executeTool(participants[0], `你是会议主持人。请对以下 AI 讨论会做共识总结,输出三部分:1)达成的结论 2)主要分歧 3)行动项。简洁列点。\n\n话题: ${topic}\n\n讨论记录:\n${digest}`, { taskId: `consensus_${meetingId}_${Date.now()}` });
        totalTokens += sumResult.tokens.total || 0;
        const consensus = sumResult.content.substring(0, 2000);
        store.addMessage(meetingId, '共识总结', consensus);
        store.writeExperience('会议共识', `话题: ${topic}\n${consensus}`, ['讨论会', '共识']);
        log('info', `会议 ${meetingId} 共识总结完成, ${sumResult.tokens.total} tokens`);
      } catch (e) {
        store.addMessage(meetingId, '系统', `(共识总结失败: ${e.message})`);
      }
    }

    // 自动实现
    let implResult = null;
    if (doImplement) {
      updateMeeting({ round: 3, status: 'implementing' });
      log('info', `会议 ${meetingId} 开始自动实现`);
      const finalMeeting = store.getMeeting(meetingId);
      const discussionSummary = (finalMeeting.messages || [])
        .filter(m => m.content && !m.content.startsWith('(') && m.speaker !== '主持人')
        .map(m => `【${m.speaker}】: ${m.content}`)
        .join('\n\n');
      const implTask = `基于以下 AI 讨论会的结论,编写完整的代码实现。\n\n讨论话题: ${topic}\n\n讨论记录:\n${discussionSummary}\n\n请根据讨论结论,编写完整可运行的代码。`;
      try {
        implResult = await doDispatch(implTask, participants, true);
        totalTokens += implResult.totalTokens || 0;
        store.addMessage(meetingId, '系统', `自动实现完成: ${implResult.successCount}/${implResult.total} 成功, ${implResult.totalTokens} tokens`);
      } catch (e) {
        store.addMessage(meetingId, '系统', `自动实现失败: ${e.message}`);
      }
    }

    // 完成:用 closeMeeting(补 closedAt;内部已先持久化 totalTokens 再写穿)
    const msgCount = (store.getMeeting(meetingId)?.messages || []).length;
    closeMeeting(`${participants.length} 个参与者, ${msgCount} 条发言, ${totalTokens} tokens${implResult ? ', 实现 ' + implResult.successCount + '/' + implResult.total + ' 成功' : ''}`);
    log('info', `会议 ${meetingId} 结束: ${msgCount} 条发言, ${totalTokens} tokens`);

  } catch (err) {
    // 顶层异常兜底:会议不会卡在 'discussing'
    log('error', `会议 ${meetingId} 异常: ${err.message}\n${err.stack}`);
    store.addMessage(meetingId, '系统', `(会议异常: ${err.message})`);
    closeMeeting(`异常终止: ${err.message}, ${totalTokens} tokens`);
  }
}

// ── AgnesCode llm_request 日志采集 ──
// 文件格式:第一行是请求(model_config+input),后续每行是流式响应 chunk(data.content[])
function readAgnesLLMLogs (opts = {}) {
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const since = opts.since || null;
  try {
    const logDir = path.join(os.homedir(), '.agnes', 'state', 'logs');
    if (!fs.existsSync(logDir)) return [];
    const files = fs.readdirSync(logDir)
      .filter(f => /^llm_request\.\d+\.jsonl$/.test(f))
      .map(f => ({ name: f, path: path.join(logDir, f), mtime: fs.statSync(path.join(logDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);

    const results = [];
    for (const file of files) {
      if (results.length >= limit) break;
      try {
        const lines = fs.readFileSync(file.path, 'utf-8').trim().split('\n').filter(Boolean);
        let currentReq = null;
        let respChunks = [];

        const flush = () => {
          if (!currentReq) return;
          const model = currentReq.model_config?.model_name || currentReq.input?.model || 'unknown';
          const messages = currentReq.input?.messages || [];
          const userMsg = messages.find(m => m.role === 'user');
          const systemMsg = messages.find(m => m.role === 'system');
          const ts = new Date(currentReq._created || Date.now()).toISOString();
          if (since && ts < since) { currentReq = null; respChunks = []; return; }
          // 请求
          results.push({
            ts, direction: 'out', tool: 'agnes-code', source: 'agnes', model,
            content: (userMsg?.content || '').substring(0, 8000),
            system_prompt: (systemMsg?.content || '').substring(0, 2000) || null,
            usage: null
          });
          // 响应（聚合所有 chunk）
          if (respChunks.length > 0) {
            results.push({
              ts, direction: 'in', tool: 'agnes-code', source: 'agnes', model,
              content: respChunks.join('').substring(0, 8000),
              usage: currentReq._usage || null
            });
          }
          currentReq = null;
          respChunks = [];
        };

        for (const line of lines) {
          if (results.length >= limit * 2) break;
          try {
            const entry = JSON.parse(line);
            if (entry.model_config && entry.input) {
              // 新请求行
              flush();
              currentReq = entry;
            } else if (entry.data && entry.data.content) {
              // 响应 chunk
              const chunk = Array.isArray(entry.data.content)
                ? entry.data.content.map(c => c.text || '').join('')
                : String(entry.data.content || '');
              if (chunk) respChunks.push(chunk);
              if (entry.data.created && !currentReq?._created) currentReq._created = entry.data.created * 1000;
              if (entry.usage) currentReq._usage = entry.usage;
            }
          } catch (_) {}
        }
        flush();
      } catch (_) {}
    }
    return results.sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, limit);
  } catch (_) { return []; }
}

// ── Graceful shutdown ──
function shutdown (signal) {
  console.log(`[ai-bridge] 收到 ${signal},正在关闭...`);
  isShuttingDown = true;

  // 拒绝新请求,等待活跃 dispatch 完成(最多 10 秒)
  const shutdownTimeout = setTimeout(() => {
    console.log('[ai-bridge] 强制关闭(等待超时)');
    process.exit(1);
  }, 10000);

  // 检查活跃 dispatch
  const checkInterval = setInterval(() => {
    if (activeDispatchCount === 0) {
      clearInterval(checkInterval);
      clearTimeout(shutdownTimeout);

      // 清理客户端
      for (const [name, client] of connectedClients) {
        if (client.pendingReject) client.pendingReject(new Error('服务关闭'));
      }
      connectedClients.clear();

      server.close(() => {
        console.log('[ai-bridge] 已关闭');
        process.exit(0);
      });
    }
  }, 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGBREAK', () => shutdown('SIGBREAK')); // Windows

// ── 客户端 TTL 清理(每 60 秒清理超过 5 分钟无活动的客户端) ──
setInterval(() => {
  const now = Date.now();
  for (const [name, client] of connectedClients) {
    // 按最后活动时间(lastSeen)判定,持续轮询的活跃客户端不会被误清
    const lastActive = client.lastSeen || new Date(client.connectedAt).getTime();
    if (now - lastActive > CONFIG.CLIENT_TTL && !client.pendingResolve) {
      rememberClientDisconnect(name, client, 'ttl_expired', `超过 ${Math.round((now - lastActive) / 1000)}s 无活动`);
      connectedClients.delete(name);
      log('warn', `清理超时客户端(${Math.round((now - lastActive) / 1000)}s 无活动): ${name}`);
    }
  }
}, 60000);

// ── 全局库:启动时标记重启前遗留的孤儿异步任务(执行进度已丢,不谎报 running) ──
const orphanedTasks = db.markOrphanTasks();
if (orphanedTasks > 0) log('warn', `启动时标记 ${orphanedTasks} 个孤儿异步任务(中枢重启导致执行中断)`);
if (db.available) console.log(`[ai-bridge] 全局库已就绪: ${db.dbPath}`);
else console.warn(`[ai-bridge] ⚠️ 全局库不可用(不影响主链路): ${db.stats().lastError || 'unknown'}`);

// ── 启动时鉴权警告 ──
if (!CONFIG.AUTH_TOKEN) {
  console.warn('[ai-bridge] ⚠️ 警告: 未设置 AI_BRIDGE_TOKEN,API 无鉴权保护! 设置环境变量启用鉴权。');
}
