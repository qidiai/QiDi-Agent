'use strict';

/**
 * ai-bridge/db.js — 电脑全局 SQLite 数据库(node:sqlite 内置模块,零外部依赖)
 *
 * 定位:跨项目/跨重启的结果沉淀层。JSON 文件(store.js)仍是运行时真源,
 * 本库是"写穿"副本 + 长期查询层——任何 DB 故障都不得影响中枢主链路(全部操作静默降级)。
 *
 * 默认路径:~/.ai-bridge/bridge.db(全局);env AI_BRIDGE_DB 可覆盖(测试隔离)。
 *
 * 五张表:
 *   dispatches  — 每次 dispatch 的最终结果(含路由依据)
 *   meetings    — 每场讨论会的终态(话题/状态/token/止损原因/共识总结)
 *   reviews     — 交叉评审记录(生产者/评审者/意见)
 *   async_tasks — 异步任务队列(queued/running/done/failed/orphaned)
 *   events      — 全局观测事件流(代理透传/telemetry 上报;只存用量摘要,不存正文/密钥)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

let _db = null;
let _available = false;
let _lastError = null;
let _dbPath = null;

function resolveDbPath () {
  if (process.env.AI_BRIDGE_DB) return process.env.AI_BRIDGE_DB;
  return path.join(os.homedir(), '.ai-bridge', 'bridge.db');
}

function getDb () {
  if (_db) return _db;
  if (_lastError) return null; // 初始化失败过,不反复重试
  try {
    const { DatabaseSync } = require('node:sqlite');
    _dbPath = resolveDbPath();
    fs.mkdirSync(path.dirname(_dbPath), { recursive: true });
    _db = new DatabaseSync(_dbPath);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS dispatches (
        id TEXT PRIMARY KEY, ts TEXT NOT NULL, task TEXT, tools TEXT,
        success_count INTEGER, total INTEGER, total_tokens INTEGER,
        elapsed_ms INTEGER, routing TEXT, results TEXT
      );
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY, ts TEXT NOT NULL, topic TEXT, participants TEXT,
        status TEXT, total_tokens INTEGER, interrupt_reason TEXT,
        summary TEXT, closed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY, dispatch_id TEXT, ts TEXT NOT NULL,
        producer TEXT, reviewer TEXT, skipped INTEGER DEFAULT 0,
        reason TEXT, content TEXT, tokens INTEGER
      );
      CREATE TABLE IF NOT EXISTS async_tasks (
        id TEXT PRIMARY KEY, ts TEXT NOT NULL, task TEXT,
        status TEXT NOT NULL, result TEXT, finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, source TEXT NOT NULL, channel TEXT NOT NULL,
        event_type TEXT NOT NULL, model TEXT,
        input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0, success INTEGER DEFAULT 1, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dispatches_ts ON dispatches(ts);
      CREATE INDEX IF NOT EXISTS idx_meetings_ts ON meetings(ts);
      CREATE INDEX IF NOT EXISTS idx_async_status ON async_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
      CREATE TABLE IF NOT EXISTS traffic (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        direction TEXT NOT NULL,
        tool TEXT NOT NULL,
        task_id TEXT,
        type TEXT,
        success INTEGER,
        duration TEXT,
        error TEXT,
        content TEXT,
        code_blocks TEXT,
        usage TEXT,
        source TEXT DEFAULT 'bridge'
      );
      CREATE INDEX IF NOT EXISTS idx_traffic_ts ON traffic(ts);
      CREATE INDEX IF NOT EXISTS idx_traffic_tool ON traffic(tool);
      CREATE INDEX IF NOT EXISTS idx_traffic_direction ON traffic(direction);
      CREATE INDEX IF NOT EXISTS idx_traffic_source ON traffic(source);
    `);
    _available = true;
    return _db;
  } catch (e) {
    _lastError = e.message;
    _available = false;
    return null;
  }
}

// 所有写操作静默降级:DB 挂了绝不拖垮中枢
function safeRun (fn) {
  const db = getDb();
  if (!db) return false;
  try { fn(db); return true; } catch (e) { _lastError = e.message; return false; }
}

function recordDispatch (rec) {
  return safeRun(db => {
    db.prepare(`INSERT OR REPLACE INTO dispatches
      (id, ts, task, tools, success_count, total, total_tokens, elapsed_ms, routing, results)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rec.dispatchId, new Date().toISOString(), (rec.task || '').substring(0, 500),
        JSON.stringify(rec.tools || []), rec.successCount || 0, rec.total || 0,
        rec.totalTokens || 0, rec.elapsedMs || 0,
        rec.routing ? JSON.stringify(rec.routing) : null,
        JSON.stringify((rec.results || []).map(r => ({ tool: r.tool, success: r.success, tokens: r.tokens?.total || 0, fallback: r.fallback || false }))));
  });
}

function recordMeeting (m) {
  if (!m) return false;
  return safeRun(db => {
    db.prepare(`INSERT OR REPLACE INTO meetings
      (id, ts, topic, participants, status, total_tokens, interrupt_reason, summary, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.id, m.ts || new Date().toISOString(), (m.topic || '').substring(0, 500),
        JSON.stringify(m.participants || []), m.status || 'unknown', m.totalTokens || 0,
        m.interruptReason || null, m.summary || null, m.closedAt || null);
  });
}

function recordReview (r) {
  return safeRun(db => {
    db.prepare(`INSERT OR REPLACE INTO reviews
      (id, dispatch_id, ts, producer, reviewer, skipped, reason, content, tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.dispatchId || null, new Date().toISOString(), r.producer || null,
        r.reviewer || null, r.skipped ? 1 : 0, r.reason || null,
        (r.content || '').substring(0, 8000), r.tokens || 0);
  });
}

// ── 异步任务队列 ──

function createAsyncTask (id, task) {
  return safeRun(db => {
    db.prepare('INSERT INTO async_tasks (id, ts, task, status) VALUES (?, ?, ?, ?)')
      .run(id, new Date().toISOString(), (task || '').substring(0, 500), 'running');
  });
}

function finishAsyncTask (id, status, result) {
  return safeRun(db => {
    db.prepare('UPDATE async_tasks SET status = ?, result = ?, finished_at = ? WHERE id = ?')
      .run(status, result ? JSON.stringify(result) : null, new Date().toISOString(), id);
  });
}

function getAsyncTask (id) {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, result: row.result ? JSON.parse(row.result) : null };
  } catch (e) { _lastError = e.message; return null; }
}

// 中枢重启后,未完成的异步任务标记为孤儿(执行进度已丢失,不谎报 running)
function markOrphanTasks () {
  let count = 0;
  safeRun(db => {
    const r = db.prepare("UPDATE async_tasks SET status = 'orphaned', finished_at = ? WHERE status IN ('queued', 'running')")
      .run(new Date().toISOString());
    count = r.changes || 0;
  });
  return count;
}

// ── 全局观测事件流 ──

// 只存用量摘要:detail 由调用方负责截断+脱敏,本层再做一道硬截断兜底
function recordEvent (ev) {
  return safeRun(db => {
    db.prepare(`INSERT INTO events
      (ts, source, channel, event_type, model, input_tokens, output_tokens, duration_ms, success, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(new Date().toISOString(), String(ev.source || 'unknown').substring(0, 60),
        String(ev.channel || 'telemetry').substring(0, 20), String(ev.type || 'unknown').substring(0, 40),
        ev.model ? String(ev.model).substring(0, 120) : null,
        Number.isFinite(ev.inputTokens) ? ev.inputTokens : 0,
        Number.isFinite(ev.outputTokens) ? ev.outputTokens : 0,
        Number.isFinite(ev.durationMs) ? ev.durationMs : 0,
        ev.success === false ? 0 : 1,
        ev.detail ? String(ev.detail).substring(0, 2000) : null);
  });
}

function eventsSummary (days) {
  const db = getDb();
  if (!db) return null;
  try {
    const since = new Date(Date.now() - (days || 7) * 86400000).toISOString();
    return {
      bySource: db.prepare(`SELECT source, channel, COUNT(*) AS n,
          SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
          SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS successes, AVG(duration_ms) AS avg_ms
        FROM events WHERE ts >= ? GROUP BY source, channel ORDER BY n DESC`).all(since),
      byDay: db.prepare(`SELECT substr(ts, 1, 10) AS day, source, COUNT(*) AS n,
          SUM(input_tokens + output_tokens) AS tokens
        FROM events WHERE ts >= ? GROUP BY day, source ORDER BY day DESC`).all(since),
      recent: db.prepare(`SELECT ts, source, channel, event_type, model,
          input_tokens, output_tokens, duration_ms, success
        FROM events ORDER BY id DESC LIMIT 20`).all()
    };
  } catch (e) { _lastError = e.message; return null; }
}

// ── 查询/统计 ──

// ── 流量记录(完整内容,不截断) ──

function recordTraffic (entry) {
  return safeRun(db => {
    db.prepare(`INSERT INTO traffic
      (ts, direction, tool, task_id, type, success, duration, error, content, code_blocks, usage, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        entry.ts || new Date().toISOString(),
        entry.direction || 'out',
        String(entry.tool || 'unknown').substring(0, 120),
        entry.taskId || null,
        entry.type || null,
        entry.success === false ? 0 : (entry.success === true ? 1 : null),
        entry.duration || null,
        entry.error || null,
        entry.content || '',
        entry.codeBlocks ? JSON.stringify(entry.codeBlocks) : null,
        entry.usage ? JSON.stringify(entry.usage) : null,
        entry.source || 'bridge'
      );
  });
}

function queryTraffic (opts = {}) {
  const db = getDb();
  if (!db) return [];
  try {
    const conditions = [];
    const params = [];
    if (opts.tool) { conditions.push('tool = ?'); params.push(opts.tool); }
    if (opts.direction) { conditions.push('direction = ?'); params.push(opts.direction); }
    if (opts.source) { conditions.push('source = ?'); params.push(opts.source); }
    if (opts.since) { conditions.push('ts > ?'); params.push(opts.since); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = Math.max(1, Math.min(opts.limit || 50, 500));
    const rows = db.prepare(`SELECT * FROM traffic ${where} ORDER BY id DESC LIMIT ?`).all(...params, limit);
    return rows.map(r => ({
      ...r,
      success: r.success === null ? null : !!r.success,
      code_blocks: r.code_blocks ? JSON.parse(r.code_blocks) : null,
      usage: r.usage ? JSON.parse(r.usage) : null
    }));
  } catch (e) { _lastError = e.message; return []; }
}

function clearTraffic () {
  return safeRun(db => {
    db.prepare('DELETE FROM traffic').run();
  });
}

function stats () {
  const db = getDb();
  const base = { available: _available, dbPath: _dbPath, lastError: _lastError };
  if (!db) return base;
  try {
    const one = (sql) => db.prepare(sql).get();
    return {
      ...base,
      dispatches: one('SELECT COUNT(*) AS n, COALESCE(SUM(total_tokens),0) AS tokens FROM dispatches'),
      meetings: one('SELECT COUNT(*) AS n, COALESCE(SUM(total_tokens),0) AS tokens FROM meetings'),
      reviews: one('SELECT COUNT(*) AS n FROM reviews'),
      events: one('SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens + output_tokens),0) AS tokens FROM events'),
      asyncTasks: one("SELECT COUNT(*) AS n, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done, SUM(CASE WHEN status='orphaned' THEN 1 ELSE 0 END) AS orphaned FROM async_tasks"),
      recentDispatches: db.prepare('SELECT id, ts, task, success_count, total, total_tokens FROM dispatches ORDER BY ts DESC LIMIT 5').all(),
      recentMeetings: db.prepare('SELECT id, ts, topic, status, total_tokens FROM meetings ORDER BY ts DESC LIMIT 5').all()
    };
  } catch (e) { _lastError = e.message; return { ...base, lastError: _lastError }; }
}

module.exports = {
  getDb, recordDispatch, recordMeeting, recordReview,
  createAsyncTask, finishAsyncTask, getAsyncTask, markOrphanTasks,
  recordEvent, eventsSummary,
  recordTraffic, queryTraffic, clearTraffic,
  stats,
  get available () { return _available; },
  get dbPath () { return _dbPath; }
};
