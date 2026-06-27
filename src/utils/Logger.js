/**
 * 轻量统一日志模块
 * 替代 console.log/warn/error，支持级别控制与静默
 * 
 * 用法：
 *   const logger = require('./logger')('module-name');
 *   logger.info('hello');
 *   logger.warn('caution');
 *   logger.error('failed', err);
 *   logger.debug('verbose detail');  // 仅 LOG_LEVEL=debug 时输出
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

class Logger {
  constructor({ name = 'qidi', level = null } = {}) {
    this.name = name;
    this.tag = name;
    this.level = level ?? LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;
  }

  debug(...args) {
    if (this.level <= LEVELS.debug) {
      console.log(`[debug][${this.tag}]`, ...args);
    }
  }

  info(...args) {
    if (this.level <= LEVELS.info) {
      console.log(`[info][${this.tag}]`, ...args);
    }
  }

  warn(...args) {
    if (this.level <= LEVELS.warn) {
      console.warn(`[warn][${this.tag}]`, ...args);
    }
  }

  error(...args) {
    if (this.level <= LEVELS.error) {
      console.error(`[error][${this.tag}]`, ...args);
    }
  }

  /** 读取日志文件统计 */
  getStats() {
    const logDir = path.join(process.cwd(), 'logs');
    const logFile = path.join(logDir, 'qidi-agent.log');
    if (!fs.existsSync(logFile)) {
      return { file: '无', size: 0, lines: 0, lastModified: '未知' };
    }
    const stat = fs.statSync(logFile);
    const lines = fs.readFileSync(logFile, 'utf-8').split('\n').length;
    return {
      file: 'qidi-agent.log',
      size: stat.size,
      lines,
      lastModified: stat.mtime.toISOString()
    };
  }

  /** 清理 N 天前的日志 */
  clean(days) {
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) return 0;
    const cutoff = Date.now() - days * 86400000;
    let removed = 0;
    for (const f of fs.readdirSync(logDir)) {
      const fp = path.join(logDir, f);
      const st = fs.statSync(fp);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        removed++;
      }
    }
    return removed;
  }
}

/** 工厂函数：createLogger('module-name') */
function createLogger(moduleName = 'qidi') {
  return new Logger({ name: moduleName });
}

// 导出工厂函数
module.exports = createLogger;
// 也导出 class 供 new Logger() 使用
module.exports.Logger = Logger;
// 兼容旧 import { logger } 写法
module.exports.logger = createLogger('qidi');
// 也导出级别常量，便于测试
module.exports.LEVELS = LEVELS;
