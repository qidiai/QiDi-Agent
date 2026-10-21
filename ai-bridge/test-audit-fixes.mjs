#!/usr/bin/env node
'use strict';

/**
 * AI Bridge 审计修复验收测试(指挥官亲笔,编码手禁改)
 *
 * 覆盖 2026-10-22 审计后的四个修复项:
 *   A) CliAdapter 超长 prompt 落盘:并发同工作区不得互踩/互删,文件名含 taskId,用完自删
 *   B) tools.json 超时值:agent 型 CLI 不因 tool.timeout 首次生效而被 120s 击杀
 *   C) output-cleaner:删除匹配白名单化(已知工具前缀),不再通配任意 *_<13位数字> 目录
 *   D) server.js 接线:清理逻辑必须经由 output-cleaner 模块(旧内联实现移除)
 *
 * 运行:node test-audit-fixes.mjs   退出码:0 全通过 / 1 有失败
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
const failures = [];
function check (name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}` + (detail ? ` — ${String(detail).slice(0, 300)}` : '')); }
}
function section (t) { console.log(`\n── ${t} ──`); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aifix-'));
const tmpWs = path.join(tmpRoot, 'ws');
const tmpOut = path.join(tmpRoot, 'out');
fs.mkdirSync(tmpWs, { recursive: true });
fs.mkdirSync(tmpOut, { recursive: true });

// ── A) long-task 并发竞态 ──
section('A) long-task 并发唯一性与自删(cli-adapter)');
try {
  const { CliAdapter } = require('./adapters/cli-adapter.js');
  // 假 CLI:从 argv 里的任务文本提取 long-task 文件指针,读该文件前 6 字符回显
  const READ_SCRIPT = [
    'const fs=require("fs");',
    'const t=process.argv[1]||"";',
    "const m=t.match(/ai-bridge-long-task[^\\s\"']*/);",
    'if(m){try{console.log("READ:"+fs.readFileSync(m[0],"utf-8").slice(0,6));}catch(e){console.log("ERR:"+e.code);}}',
    'else console.log("NOPTR");'
  ].join('\n');
  const mkAdapter = () => new CliAdapter({
    name: 'aifix',
    command: 'node',
    args: ['-e', READ_SCRIPT, '{{task}}'],
    inputMode: 'arg',
    outputMode: 'stdout-text',
    timeout: 60000
  });
  const A = 'ALPHA' + 'a'.repeat(25000);
  const B = 'BETA' + 'b'.repeat(25000);
  const [ra, rb] = await Promise.all([
    mkAdapter().execute(A, { taskId: 'aifixA', outputDir: path.join(tmpOut, 'a'), workspaceDir: tmpWs }),
    mkAdapter().execute(B, { taskId: 'aifixB', outputDir: path.join(tmpOut, 'b'), workspaceDir: tmpWs })
  ]);
  check('任务A读到自己且未被B覆盖', (ra.content || '').includes('READ:ALPHA'), JSON.stringify(ra).slice(0, 200));
  check('任务B读到自己(共享文件名时此项必挂)', (rb.content || '').includes('READ:BETA'), JSON.stringify(rb).slice(0, 200));
  check('无 ERR(先完成者未误删对方落盘文件)', !(ra.content || '').includes('ERR') && !(rb.content || '').includes('ERR'), (ra.content || '') + ' | ' + (rb.content || ''));
  const residue = fs.readdirSync(tmpWs).filter(n => n.includes('ai-bridge-long-task'));
  check('执行后工作区无 long-task 残留', residue.length === 0, residue.join(','));
} catch (e) {
  check('long-task 并发用例执行未抛异常', false, e.message);
}

// ── B) tools.json 超时值 ──
section('B) tools.json 超时(tool.timeout 生效后不得误杀慢 agent)');
{
  const tools = JSON.parse(fs.readFileSync('./tools.json', 'utf-8'));
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  for (const n of ['openclaw', 'qoder', 'workbuddy']) {
    check(`${n} timeout>=600000`, (byName[n]?.timeout || 0) >= 600000, 'timeout=' + byName[n]?.timeout);
  }
  check('atom-code timeout=300000', byName['atom-code']?.timeout === 300000, 'timeout=' + byName['atom-code']?.timeout);
  for (const n of ['opencode', 'opencode-k3', 'opencode-flash']) {
    check(`${n} timeout=600000`, byName[n]?.timeout === 600000, 'timeout=' + byName[n]?.timeout);
  }
  check('mimo-code 已下线', !byName['mimo-code']);
}

// ── C) output-cleaner 语义 ──
section('C) output-cleaner 匹配白名单 + 24h 窗口');
let cleaner = null;
try { cleaner = require('./output-cleaner.js'); } catch (e) { cleaner = null; }
const PREFIXES = ['openclaw', 'atom-code', 'claude-code', 'qoder', 'workbuddy', 'codely', 'codely-k3', 'opencode', 'opencode-k3', 'opencode-flash', 'aifix'];
if (!cleaner) {
  check('output-cleaner.js 模块存在', false, 'require 失败');
} else {
  const isStale = cleaner.isStaleTaskDir;
  check('桥接生成的 <tool>_<13位ts> 判为可清理', isStale('qoder_qoder_1762000000000', PREFIXES) === true);
  check('旧反代 cli-task-* 判为可清理', isStale('cli-task-x', PREFIXES) === true);
  check('review 任务目录判为可清理', isStale('opencode_review_dispatch_1762000000000_abc123', PREFIXES) === true);
  check('用户备份目录 backup_20260101120000 不匹配', isStale('backup_20260101120000', PREFIXES) === false);
  check('未知前缀 notes_1762000000000 不匹配', isStale('notes_1762000000000', PREFIXES) === false);
  check('纯文本目录名不匹配', isStale('output', PREFIXES) === false);

  const root = path.join(tmpRoot, 'clean');
  fs.mkdirSync(root);
  const mk = (name, ageMs) => {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(d, when, when);
  };
  mk('qoder_qoder_1762000000000', 25 * 3600 * 1000); // 匹配+超龄 → 删
  mk('qoder_qoder_1762000000999', 3600 * 1000);      // 匹配+未超龄 → 留
  mk('backup_20260101120000', 30 * 24 * 3600 * 1000); // 不匹配+超龄 → 留
  const out = cleaner.cleanupStaleTaskDirs({ roots: [root], prefixes: PREFIXES, maxAgeMs: 24 * 3600 * 1000 });
  const left = fs.readdirSync(root);
  check('超龄匹配目录被删', !left.includes('qoder_qoder_1762000000000'), JSON.stringify(out));
  check('未超龄匹配目录保留', left.includes('qoder_qoder_1762000000999'), left.join(','));
  check('非白名单目录绝不删除', left.includes('backup_20260101120000'), left.join(','));
}

// ── D) server.js 接线 ──
section('D) server.js 经由 output-cleaner(旧内联通配实现移除)');
{
  const src = fs.readFileSync('./server.js', 'utf-8');
  check("server.js require('./output-cleaner.js')", /require\(['"]\.\/output-cleaner\.js['"]\)/.test(src));
  check('server.js 不再自带 isStaleTaskDir 内联实现', !/function isStaleTaskDir/.test(src));
  check('server.js 清理调用传入工具名前缀', /prefixes/.test(src));
}

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

console.log('\n========================================');
console.log(`总计: ${passed}/${passed + failed} 通过`);
if (failed) { console.log('失败用例: ' + failures.join(', ')); process.exit(1); }
