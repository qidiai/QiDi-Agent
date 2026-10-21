'use strict';

/**
 * qidi-sync.js — ai-bridge 模型清单自动同步到 QIDI Code 配置
 *
 * 背景：qidi (~/.qidi/config.toml) 通过若干 [model.*] 条目把
 * base_url 指向 ai-bridge 的 OpenAI 兼容端点 (http://127.0.0.1:9800/v1)
 * 来使用桥接模型。以前每加/删一个桥接模型都要手改 qidi 配置。
 *
 * 本模块把这件事自动化：
 *   - 以 ai-bridge 当前模型清单（models.json + 自动同步的 kimi 模型，
 *     经开关过滤）为准；
 *   - 重写 qidi config.toml 中所有 base_url 指向本桥（127.0.0.1:9800）
 *     的 [model.*] 段——旧的全部移除，按最新清单重新生成，
 *     写在标记块内（# >>> ai-bridge auto-sync ... # <<<）；
 *   - 其它段（直连 API、LAN 222 桥等）一律原样保留；
 *   - server 启动时同步一次，并监听 models.json / switches.json /
 *     kimi-code config.toml 的变化自动重同步（防抖 1s）。
 *
 * 注意：被接管的桥接条目上的手工定制（如 fallback_models）会在重生成时丢失；
 * 需要定制的条目请把 base_url 指向别处或改名避开桥地址。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const BRIDGE_BASE_URL = process.env.AI_BRIDGE_BASE_URL || 'http://127.0.0.1:9800/v1';
const BRIDGE_HOST_RE = /^https?:\/\/(127\.0\.0\.1|localhost):9800(\/|$)/;
const MARK_BEGIN = '# >>> ai-bridge auto-sync（自动生成，请勿手工编辑）>>>';
const MARK_END = '# <<< ai-bridge auto-sync <<<';

function qidiConfigPath () {
  const home = process.env.QIDI_HOME || path.join(os.homedir(), '.qidi');
  return path.join(home, 'config.toml');
}

function isBridgeUrl (u) {
  return BRIDGE_HOST_RE.test(String(u || '').trim());
}

function tomlEscape (s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 生成单个 [model.*] 段（与 qidi 现有工作条目同构）；alias 是 qidi 侧选择名，model 是发给桥的模型 id */
function renderEntry (m, alias) {
  const name = m.display_name || m.name || m.id;
  const ctx = Number.isFinite(m.context_window) ? m.context_window : 128000;
  return [
    `[model."${tomlEscape(alias)}"]`,
    `model = "${tomlEscape(m.id)}"`,
    `base_url = "${BRIDGE_BASE_URL}"`,
    `name = "${tomlEscape(name)} (via ai-bridge)"`,
    'api_backend = "chat_completions"',
    'auth_scheme = "bearer"',
    'env_key = "AI_BRIDGE_TOKEN"',
    `context_window = ${ctx}`,
    ''
  ].join('\n');
}

/**
 * 重写 qidi config.toml 中的桥接模型段。
 * 别名规则：默认用模型 id；与保留段（直连 API / LAN 等手工条目）撞名时
 * 改用 bridge-<id>；仍撞名则跳过该模型。
 * @param models 当前桥接模型清单（已按开关过滤）
 * @returns {{changed: boolean, removed: string[], written: string[]} | null}
 */
function syncQidiConfig (models) {
  const cfgPath = qidiConfigPath();
  if (!fs.existsSync(cfgPath)) return null;

  const text = fs.readFileSync(cfgPath, 'utf-8');

  // 1) 先剔除上次的标记块（标记行是注释，会被段切分吞进上一个段，所以按行过滤在最前面做）
  const rawLines = text.split(/\r?\n/);
  const lines = [];
  let inMarker = false;
  for (const line of rawLines) {
    if (line.includes(MARK_BEGIN)) { inMarker = true; continue; }
    if (line.includes(MARK_END)) { inMarker = false; continue; }
    if (!inMarker) lines.push(line);
  }

  // 2) 分段：header 行（[...]）为段边界
  const sections = []; // { header: string|null, lines: string[] }
  let current = { header: null, lines: [] };
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      sections.push(current);
      current = { header: line.trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  // 3) 过滤：丢弃 base_url 指向本桥的 [model.*] 段（由下方按最新清单重新生成）
  const removed = [];
  const kept = [];
  const keptAliases = new Set();
  for (const sec of sections) {
    const modelMatch = sec.header && sec.header.match(/^\[model\.(?:"([^"]+)"|([^\]]+))\]$/);
    if (modelMatch) {
      const alias = (modelMatch[1] || modelMatch[2] || '').trim();
      const baseUrlLine = sec.lines.find(l => /^\s*base_url\s*=/.test(l));
      const urlMatch = baseUrlLine && baseUrlLine.match(/=\s*"([^"]*)"/);
      if (urlMatch && isBridgeUrl(urlMatch[1])) {
        removed.push(alias);
        continue;
      }
      keptAliases.add(alias);
    }
    kept.push(sec);
  }

  // 4) 生成新条目（撞名加 bridge- 前缀，仍撞名跳过）
  const written = [];
  const entries = [];
  for (const m of models) {
    let alias = m.id;
    if (keptAliases.has(alias)) alias = `bridge-${m.id}`;
    if (keptAliases.has(alias) || written.includes(alias)) continue;
    written.push(alias);
    entries.push(renderEntry(m, alias));
  }

  // 5) [models] default 兜底：若指向被移除的桥接别名，尝试大小写不敏感重映射到新别名
  const warnings = [];
  for (const sec of kept) {
    if (sec.header !== '[models]') continue;
    for (let i = 0; i < sec.lines.length; i++) {
      const dm = sec.lines[i].match(/^(\s*default\s*=\s*)"([^"]+)"/);
      if (!dm) continue;
      const def = dm[2];
      if (!removed.includes(def) || written.includes(def)) continue;
      const remap = written.find(a => a.toLowerCase() === def.toLowerCase());
      if (remap) {
        sec.lines[i] = sec.lines[i].replace(dm[0], `${dm[1]}"${remap}"`);
        warnings.push(`默认模型 ${def} 已重映射为 ${remap}`);
      } else {
        warnings.push(`默认模型 ${def} 指向的桥接条目已不存在，请在 qidi 中重新选择默认模型（可选: ${written.join(', ')}）`);
      }
    }
  }

  // 6) 组装新内容：保留段 + 末尾标记块
  const block = [
    MARK_BEGIN,
    `# 由 ai-bridge 自动同步（${new Date().toISOString()}），共 ${entries.length} 个模型`,
    ...entries,
    MARK_END,
    ''
  ].join('\n');

  const out = kept.map(sec => sec.lines.join('\n')).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n\n' + block;

  // 7) 内容无变化则不写（避免触发监听循环 / 干扰 qidi）；比较时忽略时间戳注释行
  const stripTs = s => s.replace(/# 由 ai-bridge 自动同步（[^）]*）/g, '# 由 ai-bridge 自动同步');
  if (stripTs(out) === stripTs(text)) return { changed: false, removed, written, warnings };

  // 8) 备份 + 原子写入
  try { fs.writeFileSync(cfgPath + '.bak-ai-bridge-sync', text, 'utf-8'); } catch (_) {}
  const tmp = cfgPath + '.tmp-ai-bridge';
  fs.writeFileSync(tmp, out, 'utf-8');
  fs.renameSync(tmp, cfgPath);
  return { changed: true, removed, written, warnings };
}

/**
 * 启动自动同步：立即同步一次 + 监听相关文件变化。
 * @param {{ loadModels: () => any[], modelEnabled: (m: any) => boolean, log?: (level: string, msg: string) => void }} deps
 */
function startAutoSync (deps) {
  const { loadModels, modelEnabled } = deps;
  const logFn = deps.log || ((level, msg) => console.log(`[qidi-sync] ${msg}`));

  const run = () => {
    try {
      const models = loadModels().filter(modelEnabled);
      const result = syncQidiConfig(models);
      if (!result) return; // qidi 配置不存在，跳过
      for (const w of result.warnings || []) logFn('warn', `[qidi-sync] ⚠️ ${w}`);
      if (result.changed) {
        logFn('info', `[qidi-sync] qidi 配置已同步: ${result.written.length} 个桥接模型` +
          (result.removed.length ? `，移除旧条目: ${result.removed.join(', ')}` : ''));
      }
    } catch (e) {
      logFn('error', `[qidi-sync] 同步失败: ${e.message}`);
    }
  };

  run();

  const watchTargets = [
    path.join(__dirname, 'models.json'),
    path.join(__dirname, 'switches.json')
  ];
  try {
    const { kimiConfigPath } = require('./kimi-models');
    watchTargets.push(kimiConfigPath());
  } catch (_) {}

  let timer = null;
  for (const file of watchTargets) {
    try {
      if (!fs.existsSync(file)) continue;
      fs.watch(file, () => {
        clearTimeout(timer);
        timer = setTimeout(run, 1000); // 防抖
      });
    } catch (_) {}
  }
}

module.exports = { startAutoSync, syncQidiConfig, qidiConfigPath };
