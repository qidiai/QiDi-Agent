'use strict';

/**
 * 轻量统一日志模块
 * 替代 console.log/warn/error，支持级别控制、文件日志与结构化输出
 *
 * 用法：
 *   const logger = require('./logger')('module-name');
 *   logger.info('hello');
 *   logger.warn('caution');
 *   logger.error('failed', err);
 *   logger.debug('verbose detail');  // 仅 LOG_LEVEL=debug 时输出
 *
 *   // 结构化日志
 *   logger.info({ event: 'task_start', taskId: '123', role: 'coder' });
 *   logger.error({ event: 'task_fail', taskId: '123', error: e.message, duration_ms: 5000 });
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

// ─── 全局日志配置 ─────────────────────────────────────────────
const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'qidi-agent.log');
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
let _logStream = null;

/** 确保日志目录和文件流存在 */
function _ensureLogFile() {
  if (_logStream) return _logStream;
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    // 日志轮转：如果当前日志超过 10MB，备份
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE_BYTES) {
        const backup = path.join(LOG_DIR, `qidi-agent.${Date.now()}.log`);
        fs.renameSync(LOG_FILE, backup);
      }
    }
    _logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  } catch (_) {
    // 静默失败，不影响正常运行
  }
  return _logStream;
}

/** 将结构化对象序列化为单行 JSON（用于文件日志） */
function _toStructured(entry) {
  return JSON.stringify(entry);
}

/** 格式化人类可读的行 */
function _formatLine(tag, level, ...args) {
  const ts = new Date().toISOString();
  const parts = args.map(a => {
    if (a && typeof a === 'object') {
      // 如果是 Error 对象，提取 message + stack
      if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? '\n' + a.stack.split('\n').slice(1, 4).join('\n') : ''}`;
      return JSON.stringify(a);
    }
    return String(a);
  });
  return `[${ts}] [${level.toUpperCase().padEnd(5)}] [${tag}] ${parts.join(' ')}`;
}

class Logger {
  /**
   * @param {Object} options
   * @param {string} options.name - 模块名称
   * @param {number|string} options.level - 日志级别 (0-4 或 'debug'|'info'|'warn'|'error'|'silent')
   * @param {boolean} options.fileLog - 是否写入文件
   * @param {boolean} options.colorize - 终端输出是否带颜色
   */
  constructor({ name = 'qidi', level = null, fileLog = true, colorize = true } = {}) {
    this.name = name;
    this.tag = name;
    this.level = level != null ? (typeof level === 'string' ? LEVELS[level] ?? LEVELS.info : level)
      : (LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info);
    this._fileLog = fileLog;
    this._colorize = colorize;
  }

  _shouldLog(levelName) {
    return this.level <= LEVELS[levelName];
  }

  _writeToStd(levelName, ...args) {
    if (!this._shouldLog(levelName)) return;
    const formatted = _formatLine(this.tag, levelName, ...args);
    if (this._colorize) {
      const chalk = _getChalk();
      const colorMap = { debug: chalk.gray, info: chalk.blue, warn: chalk.yellow, error: chalk.red };
      const colorFn = colorMap[levelName] || chalk.white;
      console.log(colorFn(formatted));
    } else {
      console.log(formatted);
    }
  }

  _writeToFile(levelName, ...args) {
    if (!this._fileLog || !this._shouldLog(levelName)) return;
    const stream = _ensureLogFile();
    if (!stream) return;
    const line = _formatLine(this.tag, levelName, ...args) + '\n';
    stream.write(line);
  }

  debug(...args) {
    this._writeToStd('debug', ...args);
    this._writeToFile('debug', ...args);
  }

  info(...args) {
    this._writeToStd('info', ...args);
    this._writeToFile('info', ...args);
  }

  warn(...args) {
    this._writeToStd('warn', ...args);
    this._writeToFile('warn', ...args);
  }

  error(...args) {
    this._writeToStd('error', ...args);
    this._writeToFile('error', ...args);
  }

  /** 结构化日志：写入 JSON 行到文件，同时输出到终端 */
  structured(levelName, obj) {
    if (!this._shouldLog(levelName)) return;
    const entry = { ...obj, tag: this.tag, ts: new Date().toISOString() };
    // 终端：格式化显示
    this._writeToStd(levelName, JSON.stringify(entry));
    // 文件：结构化 JSON 行
    this._writeToFile(levelName, _toStructured(entry));
  }

  /** 便捷方法：记录任务事件 */
  taskEvent(eventName, data) {
    this.structured('info', { event: eventName, ...data });
  }

  /** 便捷方法：记录错误事件 */
  taskError(eventName, error, data) {
    this.structured('error', { event: eventName, error: error.message || String(error), stack: error.stack, ...(data || {}) });
  }

  /** 获取日志文件统计 */
  getStats() {
    if (!fs.existsSync(LOG_FILE)) {
      return { file: '无', size: 0, sizeFormatted: '0 B', lines: 0, lastModified: '未知' };
    }
    const stat = fs.statSync(LOG_FILE);
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content ? content.split('\n').length : 0;
    return {
      file: 'qidi-agent.log',
      size: stat.size,
      sizeFormatted: this._fmtSize(stat.size),
      lines,
      lastModified: stat.mtime.toISOString()
    };
  }

  /** 清理 N 天前的日志 */
  clean(days) {
    if (!fs.existsSync(LOG_DIR)) return 0;
    const cutoff = Date.now() - days * 86400000;
    let removed = 0;
    for (const f of fs.readdirSync(LOG_DIR)) {
      const fp = path.join(LOG_DIR, f);
      const st = fs.statSync(fp);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        removed++;
      }
    }
    return removed;
  }

  _fmtSize(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
  }

  /** 关闭日志流 */
  close() {
    if (_logStream) {
      _logStream.end();
      _logStream = null;
    }
  }
}

// ─── 惰性 chalk 引用（避免 chalk 未安装时报错） ─────────────────
let _chalkCached = null;
function _getChalk() {
  if (_chalkCached) return _chalkCached;
  try { _chalkCached = require('chalk'); } catch { _chalkCached = null; }
  return _chalkCached;
}

// ─── 导出 ─────────────────────────────────────────────────────
const createLogger = (moduleName = 'qidi', options = {}) => new Logger({ name: moduleName, ...options });

module.exports = createLogger;
module.exports.Logger = Logger;
module.exports.createLogger = createLogger;
module.exports.LEVELS = LEVELS;
