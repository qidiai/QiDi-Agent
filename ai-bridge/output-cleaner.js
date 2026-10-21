'use strict';

/**
 * output-cleaner — 输出根过期任务目录清理(白名单匹配)
 *
 * 背景(2026-10-22 审计):旧内联实现用 /_\d{13,}$/ 通配,会误删输出根里
 * 任意以 13 位数字结尾的用户目录(如 backup_20260101120000);
 * 而 <tool>_review_dispatch_* 任务目录反而永不回收。
 * 现改为白名单:仅回收桥接自己生成的目录名,只操作 roots 的直接子项。
 *
 * 匹配规则(isStaleTaskDir):
 *   a) cli-task-*(反代旧格式)
 *   b) <prefix>_<...>_<13位以上时间戳>,prefix 必须在 prefixes 白名单内
 *   c) 含 _review_dispatch_ 的评审任务目录
 */

const fs = require('fs');
const path = require('path');

const TS_TAIL_RE = /^\d{13,}$/;

function isStaleTaskDir (name, prefixes = []) {
  if (typeof name !== 'string' || !name) return false;
  if (name.startsWith('cli-task-')) return true;
  if (name.includes('_review_dispatch_')) return true;
  const idx = name.lastIndexOf('_');
  if (idx > 0 && TS_TAIL_RE.test(name.slice(idx + 1))) {
    return (prefixes || []).some(p => typeof p === 'string' && p && name.startsWith(p + '_'));
  }
  return false;
}

function cleanupStaleTaskDirs ({ roots = [], prefixes = [], maxAgeMs = 24 * 3600 * 1000, now = Date.now() } = {}) {
  const deleted = [];
  for (const outRoot of roots) {
    let names;
    try { names = fs.readdirSync(outRoot); } catch (_) { continue; }
    for (const name of names) {
      if (!isStaleTaskDir(name, prefixes)) continue;
      const dir = path.join(outRoot, name);
      try {
        if (now - fs.statSync(dir).mtimeMs > maxAgeMs) {
          fs.rmSync(dir, { recursive: true, force: true });
          deleted.push(dir);
        }
      } catch (_) { /* 单条目失败不影响其它 */ }
    }
  }
  return { deleted };
}

module.exports = { isStaleTaskDir, cleanupStaleTaskDirs };
