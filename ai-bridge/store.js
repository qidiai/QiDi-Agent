/**
 * ai-bridge/store.js — 持久化存储(JSON 文件,带锁)
 *
 * 三类数据:
 *   switches.json    — 工具开关
 *   token-stats.json — Token 统计
 *   memory.json      — 项目记忆(任务历史/经验/工具偏好)
 *   logs.jsonl       — 运行日志(每行一条 JSON,按时间追加)
 */

const fs = require('fs');
const path = require('path');

// 生产默认仍落在 ai-bridge 目录；测试可通过环境变量使用独立运行目录，
// 避免隔离端口的 E2E 在执行期间改写生产服务正在读取的 JSON 文件。
const DATA_DIR = process.env.AI_BRIDGE_DATA_DIR
  ? path.resolve(process.env.AI_BRIDGE_DATA_DIR)
  : __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILES = {
  switches: path.join(DATA_DIR, 'switches.json'),
  stats: path.join(DATA_DIR, 'token-stats.json'),
  memory: path.join(DATA_DIR, 'memory.json'),
  logs: path.join(DATA_DIR, 'logs.jsonl'),
  traffic: path.join(DATA_DIR, 'traffic.jsonl'),
  acl: path.join(DATA_DIR, 'clients-acl.json')
};

const _locks = new Map();

function load (key) {
  try {
    const f = FILES[key];
    if (f && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch (_) {}
  return {};
}

function loadList (key) {
  try {
    const f = FILES[key];
    if (f && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch (_) {}
  return [];
}

async function save (key, data) {
  const f = FILES[key];
  while (_locks.get(f)) { await new Promise(r => setTimeout(r, 10)); }
  _locks.set(f, true);
  try {
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, f);
  } finally {
    _locks.set(f, false);
  }
}

const _syncLocks = new Map();

function saveSync (key, data) {
  // 自旋等待锁(同步版,最多等 2 秒)
  let waited = 0;
  while (_syncLocks.get(key) && waited < 2000) {
    const start = Date.now();
    // 同步等待:用 Atomics.wait 或简单 spin
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, 10);
    waited += 10;
  }
  _syncLocks.set(key, true);
  try {
    const f = FILES[key];
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, f);
  } finally {
    _syncLocks.set(key, false);
  }
}

// ── 日志(JSONL 追加,带简单锁防交错 + 按大小轮转) ──

let _logQueue = [];
let _logWriting = false;

// 日志单文件上限 5MB,超出则轮转为 .1(最多保留 current + .1,总量约 10MB 封顶)
const LOG_MAX_BYTES = 5 * 1024 * 1024;

function rotateLogsIfNeeded (incomingBytes) {
  try {
    if (!fs.existsSync(FILES.logs)) return;
    const size = fs.statSync(FILES.logs).size;
    if (size + incomingBytes > LOG_MAX_BYTES) {
      // 当前日志转为 .1(覆盖旧的 .1),新日志从空开始
      fs.renameSync(FILES.logs, FILES.logs + '.1');
    }
  } catch (_) { /* 轮转失败不阻塞写入 */ }
}

function flushLogQueue () {
  if (_logWriting || _logQueue.length === 0) return;
  _logWriting = true;
  const batch = _logQueue.join('\n') + '\n';
  _logQueue = [];
  rotateLogsIfNeeded(Buffer.byteLength(batch));
  fs.appendFile(FILES.logs, batch, 'utf-8', (err) => {
    _logWriting = false;
    if (err) console.error('[store] 日志写入失败:', err.message);
    if (_logQueue.length > 0) flushLogQueue();
  });
}

function appendLog (level, msg, extra = {}) {
  // 基础字段在前,extra 在后但不允许覆盖 ts/level/msg
  const { ts: _x, level: _y, msg: _z, ...safeExtra } = extra;
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: typeof msg === 'string' ? msg : JSON.stringify(msg),
    ...safeExtra
  });
  _logQueue.push(entry);
  flushLogQueue();
}

function readLogs (opts = {}) {
  const { level, limit = 50, since } = opts;
  const maxLimit = Math.max(1, Math.min(limit || 50, 500));
  try {
    if (!fs.existsSync(FILES.logs)) return [];
    const lines = fs.readFileSync(FILES.logs, 'utf-8').trim().split('\n').filter(Boolean);
    let entries = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    if (level) entries = entries.filter(e => e.level === level);
    if (since) entries = entries.filter(e => { try { return new Date(e.ts) > new Date(since); } catch (_) { return false; } });
    return entries.slice(-maxLimit);
  } catch (_) { return []; }
}

function clearLogs () {
  try { fs.writeFileSync(FILES.logs, '', 'utf-8'); } catch (_) {}
  try { if (fs.existsSync(FILES.logs + '.1')) fs.unlinkSync(FILES.logs + '.1'); } catch (_) {}
}

// ── 流量日志(完整内容,不截断) ──

let _trafficQueue = [];
let _trafficWriting = false;
const TRAFFIC_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB 单文件上限

function rotateTrafficIfNeeded (appendSize) {
  try {
    if (!fs.existsSync(FILES.traffic)) return;
    const stat = fs.statSync(FILES.traffic);
    if (stat.size + appendSize > TRAFFIC_MAX_FILE_SIZE) {
      // 轮转:traffic.jsonl → traffic.jsonl.1(覆盖旧)
      try { fs.unlinkSync(FILES.traffic + '.1'); } catch (_) {}
      fs.renameSync(FILES.traffic, FILES.traffic + '.1');
    }
  } catch (_) {}
}

function flushTrafficQueue () {
  if (_trafficWriting || _trafficQueue.length === 0) return;
  _trafficWriting = true;
  const batch = _trafficQueue.join('\n') + '\n';
  _trafficQueue = [];
  rotateTrafficIfNeeded(Buffer.byteLength(batch));
  fs.appendFile(FILES.traffic, batch, 'utf-8', (err) => {
    _trafficWriting = false;
    if (err) console.error('[store] 流量日志写入失败:', err.message);
    if (_trafficQueue.length > 0) flushTrafficQueue();
  });
}

function appendTraffic (entry) {
  const line = JSON.stringify(entry);
  _trafficQueue.push(line);
  flushTrafficQueue();
}

function readTraffic (opts = {}) {
  const { tool, direction, limit = 50, since } = opts;
  const maxLimit = Math.max(1, Math.min(limit || 50, 500));
  try {
    if (!fs.existsSync(FILES.traffic)) return [];
    const lines = fs.readFileSync(FILES.traffic, 'utf-8').trim().split('\n').filter(Boolean);
    let entries = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    if (tool) entries = entries.filter(e => e.tool === tool);
    if (direction) entries = entries.filter(e => e.direction === direction);
    if (since) entries = entries.filter(e => { try { return new Date(e.ts) > new Date(since); } catch (_) { return false; } });
    return entries.slice(-maxLimit);
  } catch (_) { return []; }
}

function clearTraffic () {
  try { fs.writeFileSync(FILES.traffic, '', 'utf-8'); } catch (_) {}
  try { if (fs.existsSync(FILES.traffic + '.1')) fs.unlinkSync(FILES.traffic + '.1'); } catch (_) {}
}

// ── 记忆(任务历史 + 经验 + 工具偏好 + 会议) ──

function loadMemory () {
  const mem = load('memory');
  if (!mem.tasks) mem.tasks = [];
  if (!mem.experiences) mem.experiences = [];
  if (!mem.preferences) mem.preferences = {};
  if (!mem.meetings) mem.meetings = [];
  return mem;
}

// ── 会议(多 Agent 讨论) ──

function createMeeting (topic, participants) {
  const mem = loadMemory();
  const meeting = {
    id: `meeting_${Date.now()}`,
    ts: new Date().toISOString(),
    topic,
    participants: participants || [],
    messages: [],
    status: 'active'
  };
  mem.meetings.unshift(meeting);
  if (mem.meetings.length > 50) mem.meetings = mem.meetings.slice(0, 50);
  saveSync('memory', mem);
  return meeting;
}

// 单条发言内容上限与单会议发言条数上限(缓解 memory.json 全量重写膨胀)
const MAX_MSG_CONTENT = 8000;
const MAX_MEETING_MESSAGES = 200;

function addMessage (meetingId, speaker, content) {
  const mem = loadMemory();
  const meeting = mem.meetings.find(m => m.id === meetingId);
  if (!meeting) return null;
  if (meeting.status === 'closed') return null;
  let text = typeof content === 'string' ? content : JSON.stringify(content);
  if (text.length > MAX_MSG_CONTENT) text = text.substring(0, MAX_MSG_CONTENT) + `\n…(已截断,原长 ${text.length} 字符)`;
  meeting.messages.push({
    ts: new Date().toISOString(),
    speaker,
    content: text
  });
  // 单会议发言条数上限:超出则保留最新的
  if (meeting.messages.length > MAX_MEETING_MESSAGES) {
    meeting.messages = meeting.messages.slice(-MAX_MEETING_MESSAGES);
  }
  saveSync('memory', mem);
  return meeting;
}

function getMeeting (meetingId) {
  const mem = loadMemory();
  return mem.meetings.find(m => m.id === meetingId) || null;
}

function getRecentMeetings (limit = 10) {
  const safeLimit = Math.max(1, Math.min(limit || 10, 50));
  return loadMemory().meetings.slice(0, safeLimit);
}

function closeMeeting (meetingId, summary) {
  const mem = loadMemory();
  const meeting = mem.meetings.find(m => m.id === meetingId);
  if (!meeting) return null;
  meeting.status = 'closed';
  meeting.summary = summary || '';
  meeting.closedAt = new Date().toISOString();
  saveSync('memory', mem);
  return meeting;
}

function recordTask (task) {
  const mem = loadMemory();
  mem.tasks.unshift({
    id: task.id,
    ts: new Date().toISOString(),
    task: task.task?.substring(0, 200),
    tools: task.tools,
    results: (task.results || []).map(r => ({
      tool: r.tool,
      toolId: r.toolId || null,
      canonicalId: r.canonicalId || null,
      success: r.success,
      tokens: r.tokens?.total || 0,
      duration: r.duration,
      codeBlocks: r.codeBlocks?.length || 0,
      fallback: r.fallback || false,
      fallbackFrom: r.fallbackFrom
    })),
    successCount: task.successCount,
    totalTokens: task.totalTokens,
    fallbackLog: task.fallbackLog
  });
  // 保留最近 200 条
  if (mem.tasks.length > 200) mem.tasks = mem.tasks.slice(0, 200);
  saveSync('memory', mem);
}

function writeExperience (category, content, tags = []) {
  const mem = loadMemory();
  mem.experiences.unshift({
    id: `exp_${Date.now()}`,
    ts: new Date().toISOString(),
    category,
    content,
    tags
  });
  if (mem.experiences.length > 100) mem.experiences = mem.experiences.slice(0, 100);
  saveSync('memory', mem);
}

function searchMemory (query) {
  const mem = loadMemory();
  const q = (query || '').trim().toLowerCase();
  if (!q) return { tasks: mem.tasks.slice(0, 10), experiences: mem.experiences.slice(0, 10) };
  const taskMatches = mem.tasks.filter(t =>
    t.task?.toLowerCase().includes(q) ||
    t.tools?.some(tool => tool.toLowerCase().includes(q))
  ).slice(0, 10);

  const expMatches = mem.experiences.filter(e =>
    e.content?.toLowerCase().includes(q) ||
    e.category?.toLowerCase().includes(q) ||
    e.tags?.some(tag => tag.toLowerCase().includes(q))
  ).slice(0, 10);

  return { tasks: taskMatches, experiences: expMatches };
}

function getToolStats () {
  const mem = loadMemory();
  const stats = {};
  for (const t of mem.tasks) {
    for (const r of (t.results || [])) {
      const key = r.toolId || r.tool;
      if (!key) continue;
      if (!stats[key]) stats[key] = { calls: 0, successes: 0, failures: 0, fallbacks: 0, totalTokens: 0 };
      stats[key].calls++;
      if (r.success) stats[key].successes++;
      else stats[key].failures++;
      if (r.fallback) stats[key].fallbacks++;
      stats[key].totalTokens += r.tokens || 0;
    }
  }
  return stats;
}

function getToolObservations (keys) {
  const wanted = new Set((keys || []).filter(Boolean));
  const observations = [];
  for (const task of loadMemory().tasks) {
    const observedTools = new Set();
    for (const result of (task.results || [])) {
      const key = result.toolId || result.tool;
      observedTools.add(result.tool);
      if (!wanted.has(key) && !wanted.has(result.tool)) continue;
      observations.push({
        key,
        tool: result.tool,
        toolId: result.toolId || null,
        ts: task.ts,
        task: task.task || '',
        success: result.success === true,
        fallback: result.fallback === true,
        duration: result.duration,
        tokens: result.tokens || 0
      });
    }
    // 旧记录会把原失败结果替换成接力成功结果；从 fallbackLog 补回原工具失败，
    // 否则路由画像会系统性高估经常触发接力的工具。
    for (const fb of (task.fallbackLog || [])) {
      if (!fb.from || fb.skipped) continue;
      // 旧记录会丢失原目标失败；仅在 results 中没有该工具时补回，避免重复计数。
      if (!observedTools.has(fb.from) && wanted.has(fb.from)) {
        observations.push({
          key: fb.from,
          tool: fb.from,
          toolId: null,
          ts: task.ts,
          task: task.task || '',
          success: false,
          fallback: false,
          duration: null,
          tokens: 0,
          inferredFromFallback: true
        });
      }
      // 失败的接力目标同样是真实失败样本；此前遗漏会让 fallback 候选长期保持零失败假象。
      if (fb.to && fb.success === false && !observedTools.has(fb.to) && wanted.has(fb.to)) {
        observations.push({
          key: fb.to,
          tool: fb.to,
          toolId: null,
          ts: task.ts,
          task: task.task || '',
          success: false,
          fallback: true,
          duration: null,
          tokens: 0,
          inferredFromFallbackTarget: true
        });
      }
    }
  }
  return observations;
}

function getRecentTasks (limit = 10) {
  const safeLimit = Math.max(1, Math.min(limit || 10, 200));
  return loadMemory().tasks.slice(0, safeLimit);
}

// ── 客户端准入控制(白名单 + 黑名单 + 待审批) ──

function loadACL () {
  const acl = load('acl');
  if (!Array.isArray(acl.allowlist)) acl.allowlist = [];
  if (!Array.isArray(acl.blocklist)) acl.blocklist = [];
  if (!Array.isArray(acl.pending)) acl.pending = [];
  return acl;
}

function saveACL (acl) {
  saveSync('acl', acl);
}

module.exports = {
  FILES,
  load, save, saveSync,
  appendLog, readLogs, clearLogs,
  appendTraffic, readTraffic, clearTraffic,
  loadMemory, recordTask, writeExperience, searchMemory, getToolStats, getToolObservations, getRecentTasks,
  createMeeting, addMessage, getMeeting, getRecentMeetings, closeMeeting,
  loadACL, saveACL
};
