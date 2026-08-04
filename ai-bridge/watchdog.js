#!/usr/bin/env node
'use strict';

/**
 * AI Bridge 守护进程(零依赖)
 *
 * 职责:spawn server.js 并在其意外退出后 10 秒自动重启。
 * 熔断:连续崩溃 5 次后停止重启(单次存活超过 10 分钟则重置崩溃计数)。
 * 日志:每次退出把时间戳/退出码/信号追加写入 ~/.ai-bridge/watchdog.log。
 * 环境变量原样继承(由启动脚本负责注入,守护不改变 env)。
 *
 * 运行:node watchdog.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const RESTART_DELAY_MS = 10 * 1000;        // 退出后 10 秒重启
const MAX_CONSECUTIVE_CRASHES = 5;         // 连续崩溃熔断阈值
const STABLE_UPTIME_MS = 10 * 60 * 1000;   // 单次存活超过 10 分钟视为稳定,重置崩溃计数

const LOG_DIR = path.join(os.homedir(), '.ai-bridge');
const LOG_FILE = path.join(LOG_DIR, 'watchdog.log');

let child = null;
let crashCount = 0;
let shuttingDown = false;

function wlog (msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(`[watchdog] ${msg}\n`);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* 日志写失败不影响守护主链路 */ }
}

function startServer () {
  const startedAt = Date.now();
  child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: process.env, // 原样继承,不注入任何变量
    stdio: 'inherit'
  });
  wlog(`已启动 server.js (pid=${child.pid})`);

  child.on('exit', (code, signal) => {
    child = null;
    const uptime = Date.now() - startedAt;
    wlog(`server.js 退出: code=${code} signal=${signal || ''} 存活=${Math.round(uptime / 1000)}秒`);
    if (shuttingDown) return; // 守护自身收到停止信号,不再重启
    if (uptime >= STABLE_UPTIME_MS) crashCount = 0; // 存活足够久,视为正常运行后的偶发退出
    crashCount++;
    if (crashCount > MAX_CONSECUTIVE_CRASHES) {
      wlog(`连续崩溃已达 ${MAX_CONSECUTIVE_CRASHES} 次,熔断停止重启,请人工排查后重新启动守护`);
      process.exit(1);
    }
    wlog(`${RESTART_DELAY_MS / 1000} 秒后自动重启 (第 ${crashCount}/${MAX_CONSECUTIVE_CRASHES} 次)`);
    setTimeout(startServer, RESTART_DELAY_MS);
  });
}

function shutdown (sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  wlog(`守护收到 ${sig},转发 SIGTERM 给子进程后退出(不再重启)`);
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* 已退出则忽略 */ }
  }
  // 给 server.js 的 graceful shutdown 留出窗口,再退出自身
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGBREAK', () => shutdown('SIGBREAK')); // Windows

startServer();
