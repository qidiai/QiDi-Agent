'use strict';

/**
 * ai-bridge/workspace-manager.js — 任务工作区生命周期
 *
 * 此前 CLI 工具都在一次性 output/ 目录里执行,多个 AI 无法协作同一份项目代码。
 * 本模块维护工作区登记表,dispatch/handoff 时把工作区路径作为子进程 cwd 传下去:
 *   - linked  : 登记已有目录(只解除登记,绝不删除用户文件)
 *   - managed : 在 AI_BRIDGE_WORKSPACE_ROOT 下创建的空目录,可连同文件安全回收
 *
 * workspaces.json 是运行时真源(store.js 原子写);活动租约只存内存,进程重启即失效。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const NAME_MAX = 64;
const DESCRIPTION_MAX = 500;
const MAX_WORKSPACES = 200;

const STATUS_ACTIVE = 'active';
const STATUS_ARCHIVED = 'archived';
const MODE_LINKED = 'linked';
const MODE_MANAGED = 'managed';

const _activeRuns = new Map(); // workspaceId → Set<runId>

function fail (statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function nowIso () { return new Date().toISOString(); }

function isWindows () { return process.platform === 'win32'; }

function pathKey (p) {
  const resolved = path.resolve(p);
  return isWindows() ? resolved.toLowerCase() : resolved;
}

/** child 是否严格位于 parent 内部(相等不算) */
function isInside (child, parent) {
  const rel = path.relative(pathKey(parent), pathKey(child));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function realPathOrNull (p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch (_) {
    return null;
  }
}

function workspaceRoot () {
  const configured = process.env.AI_BRIDGE_WORKSPACE_ROOT;
  return path.resolve(configured || path.join(os.homedir(), '.ai-bridge', 'workspaces'));
}

/** 名称 → 目录名:保留中英文/数字/点/横线,其余折叠为 '-' */
function slugify (name) {
  const cleaned = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9\u3400-\u4dbf\u4e00-\u9fff._-]+/g, '-')
    .replace(/^[.\-_\s]+|[.\-_\s]+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48);
  return cleaned || 'workspace';
}

function normalizeName (name, fallback) {
  let value = name == null ? '' : String(name).normalize('NFKC').trim();
  if (!value) value = fallback || `workspace-${Date.now().toString(36)}`;
  if (value.length > NAME_MAX) throw fail(400, `工作区名称过长(>${NAME_MAX} 字符)`);
  if (/[\u0000-\u001f\u007f<>:"/\\|?*]/.test(value)) throw fail(400, '工作区名称包含非法字符');
  return value;
}

function normalizeDescription (description) {
  if (description == null) return '';
  const value = String(description).trim();
  if (value.length > DESCRIPTION_MAX) throw fail(400, `描述过长(>${DESCRIPTION_MAX} 字符)`);
  // 保留换行/制表,剔除其余控制字符
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function loadState () {
  const state = store.load('workspaces');
  if (!Array.isArray(state.workspaces)) state.workspaces = [];
  if (!Number.isFinite(state.version)) state.version = 1;
  return state;
}

function saveState (state) {
  store.saveSync('workspaces', state);
}

function safeIsDir (p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function publicView (rec) {
  const exists = fs.existsSync(rec.path);
  return {
    ...rec,
    exists,
    isDirectory: exists ? safeIsDir(rec.path) : false,
    activeRuns: _activeRuns.get(rec.id)?.size || 0
  };
}

function list () {
  return loadState().workspaces
    .map(publicView)
    .sort((a, b) =>
      (a.status === b.status ? 0 : a.status === STATUS_ACTIVE ? -1 : 1) ||
      String(b.lastUsedAt || b.createdAt).localeCompare(String(a.lastUsedAt || a.createdAt)) ||
      a.name.localeCompare(b.name));
}

function summary () {
  const all = loadState().workspaces;
  return {
    total: all.length,
    active: all.filter(w => w.status === STATUS_ACTIVE).length,
    archived: all.filter(w => w.status === STATUS_ARCHIVED).length,
    managed: all.filter(w => w.mode === MODE_MANAGED).length,
    linked: all.filter(w => w.mode === MODE_LINKED).length,
    activeRuns: all.reduce((n, w) => n + (_activeRuns.get(w.id)?.size || 0), 0),
    root: workspaceRoot()
  };
}

function findRecord (state, ref) {
  const value = String(ref || '').trim();
  if (!value) return null;
  let rec = state.workspaces.find(w => w.id === value);
  if (rec) return rec;
  rec = state.workspaces.find(w => w.name.toLowerCase() === value.toLowerCase());
  if (rec) return rec;
  if (path.isAbsolute(value)) {
    const key = pathKey(value);
    rec = state.workspaces.find(w => pathKey(w.path) === key);
    if (rec) return rec;
    const real = realPathOrNull(value);
    if (real) rec = state.workspaces.find(w => pathKey(w.path) === pathKey(real));
  }
  return rec || null;
}

function get (ref) {
  const rec = findRecord(loadState(), ref);
  return rec ? publicView(rec) : null;
}

function requireRecord (state, ref) {
  const rec = findRecord(state, ref);
  if (!rec) throw fail(404, `工作区不存在: ${ref}`);
  return rec;
}

function assertPathUsable (rec) {
  if (!fs.existsSync(rec.path)) throw fail(409, `工作区目录已不存在: ${rec.path}`);
  if (!safeIsDir(rec.path)) throw fail(409, `工作区路径不是目录: ${rec.path}`);
}

/** dispatch/handoff 前置校验:必须存在、是目录且未归档 */
function resolveForDispatch (ref) {
  const rec = requireRecord(loadState(), ref);
  if (rec.status !== STATUS_ACTIVE) throw fail(409, `工作区已归档: ${rec.name}`);
  assertPathUsable(rec);
  return publicView(rec);
}

function resolveExistingDirectory (inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) throw fail(400, 'path 必须是非空绝对路径');
  const value = inputPath.trim();
  if (!path.isAbsolute(value)) throw fail(400, 'path 必须是绝对路径');
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw fail(400, `路径不存在: ${resolved}`);
  if (!safeIsDir(resolved)) throw fail(400, `路径不是目录: ${resolved}`);
  const real = realPathOrNull(resolved);
  if (!real) throw fail(400, `无法解析路径: ${resolved}`);
  if (pathKey(real) === pathKey(path.parse(real).root)) throw fail(400, '不允许把文件系统根目录登记为工作区');
  if (pathKey(real) === pathKey(workspaceRoot())) throw fail(400, '不允许把工作区根目录登记为独立工作区');
  return real;
}

function nextManagedDir (root, slug) {
  for (let i = 1; i <= 100; i++) {
    const candidate = path.join(root, i === 1 ? slug : `${slug}-${i}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw fail(409, `同名受管工作区目录过多: ${slug}`);
}

function create (input = {}) {
  const state = loadState();
  if (state.workspaces.length >= MAX_WORKSPACES) throw fail(409, `工作区数量已达上限(${MAX_WORKSPACES})`);

  const wantsLinked = input.path != null && String(input.path).trim() !== '';
  const mode = wantsLinked ? MODE_LINKED : MODE_MANAGED;
  const wsPath = wantsLinked ? resolveExistingDirectory(String(input.path)) : null;
  const name = normalizeName(input.name, wantsLinked ? path.basename(wsPath) : undefined);
  const description = normalizeDescription(input.description);

  if (state.workspaces.some(w => w.name.toLowerCase() === name.toLowerCase())) {
    throw fail(409, `工作区名称已存在: ${name}`);
  }
  if (wsPath) {
    const key = pathKey(wsPath);
    const dup = state.workspaces.find(w => pathKey(w.path) === key);
    if (dup) throw fail(409, `路径已登记为工作区 ${dup.name}: ${wsPath}`);
  }

  let managedPath = null;
  let created = false;
  if (!wantsLinked) {
    const root = workspaceRoot();
    fs.mkdirSync(root, { recursive: true });
    for (let attempt = 0; attempt < 10 && !created; attempt++) {
      managedPath = nextManagedDir(root, slugify(name));
      try {
        fs.mkdirSync(managedPath); // 不带 recursive:确保目录一定是本次新建的
        created = true;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    if (!created) throw fail(409, `无法分配受管工作区目录: ${name}`);
  }

  const rec = {
    id: `ws_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    name,
    path: wantsLinked ? wsPath : managedPath,
    mode,
    description,
    status: STATUS_ACTIVE,
    exclusive: input.exclusive === true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastUsedAt: null,
    useCount: 0
  };
  state.workspaces.unshift(rec);
  try {
    saveState(state);
  } catch (e) {
    if (managedPath) { try { fs.rmSync(managedPath, { recursive: true, force: true }); } catch (_) {} }
    throw e;
  }
  return publicView(rec);
}

function archive (ref) {
  const state = loadState();
  const rec = requireRecord(state, ref);
  if (rec.status === STATUS_ARCHIVED) return publicView(rec);
  if ((_activeRuns.get(rec.id)?.size || 0) > 0) throw fail(409, `工作区正在执行任务,无法归档: ${rec.name}`);
  rec.status = STATUS_ARCHIVED;
  rec.updatedAt = nowIso();
  saveState(state);
  return publicView(rec);
}

function restore (ref) {
  const state = loadState();
  const rec = requireRecord(state, ref);
  if (rec.status === STATUS_ACTIVE) return publicView(rec);
  assertPathUsable(rec);
  rec.status = STATUS_ACTIVE;
  rec.updatedAt = nowIso();
  saveState(state);
  return publicView(rec);
}

/**
 * 解除登记。deleteFiles=true 时仅允许回收受管目录,并再次校验路径确实位于
 * 受管根目录内(防符号链接/配置篡改导致误删用户目录)。
 */
function remove (ref, opts = {}) {
  const state = loadState();
  const rec = requireRecord(state, ref);
  if ((_activeRuns.get(rec.id)?.size || 0) > 0) throw fail(409, `工作区正在执行任务,无法删除: ${rec.name}`);

  const deleteFiles = opts.deleteFiles === true;
  let filesDeleted = false;
  if (deleteFiles) {
    if (rec.mode !== MODE_MANAGED) throw fail(400, '只能回收受管工作区的目录文件;登记目录仅解除登记');
    const root = workspaceRoot();
    const realRoot = realPathOrNull(root);
    const realTarget = realPathOrNull(rec.path);
    if (!realRoot || !realTarget || !isInside(realTarget, realRoot)) {
      throw fail(400, '受管工作区路径越界,拒绝删除文件');
    }
    fs.rmSync(realTarget, { recursive: true, force: true });
    filesDeleted = true;
  }

  const deleted = publicView(rec);
  state.workspaces = state.workspaces.filter(w => w.id !== rec.id);
  saveState(state);
  _activeRuns.delete(rec.id);
  return { deleted, filesDeleted };
}

/** 占用工作区(按 dispatch 粒度):独占工作区同时只允许一个 run */
function beginRun (ref, runId) {
  const rec = resolveForDispatch(ref);
  const runs = _activeRuns.get(rec.id) || new Set();
  if (rec.exclusive && runs.size > 0) throw fail(409, `工作区 ${rec.name} 正被另一个任务独占使用`);
  const rid = String(runId || `run_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`);
  runs.add(rid);
  _activeRuns.set(rec.id, runs);

  try {
    const state = loadState();
    const raw = state.workspaces.find(w => w.id === rec.id);
    if (raw) {
      raw.useCount = (raw.useCount || 0) + 1;
      raw.lastUsedAt = nowIso();
      raw.updatedAt = raw.lastUsedAt;
      saveState(state);
    }
  } catch (e) {
    runs.delete(rid);
    if (runs.size === 0) _activeRuns.delete(rec.id);
    throw e;
  }
  return { id: rec.id, runId: rid };
}

function endRun (workspaceId, runId) {
  const runs = _activeRuns.get(workspaceId);
  if (!runs) return false;
  runs.delete(runId);
  if (runs.size === 0) _activeRuns.delete(workspaceId);
  return true;
}

module.exports = {
  STATUS_ACTIVE,
  STATUS_ARCHIVED,
  MODE_LINKED,
  MODE_MANAGED,
  workspaceRoot,
  slugify,
  isInside,
  list,
  summary,
  get,
  resolveForDispatch,
  create,
  archive,
  restore,
  remove,
  beginRun,
  endRun
};
