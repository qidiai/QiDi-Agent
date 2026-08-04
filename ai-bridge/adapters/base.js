'use strict';

/**
 * BaseAdapter — 所有传输适配器的基类
 *
 * 提供统一接口契约 + 共享工具函数：
 *   - parsePath:  JSONPath 引擎（a.b.c / a[0].b / a || b），不引入依赖
 *   - estimateTokens / extractCodeBlocks: 从 tool-registry.js 原样搬来
 *
 * 子类必须实现: detect() / execute(task, opts)
 */

/**
 * JSONPath 引擎
 *
 * 支持语法:
 *   a.b.c       → 点号取属性
 *   a[0].b      → 数组索引
 *   a || b      → 多路 fallback，第一个非 null/undefined 的返回
 *
 * 全部未命中返回 null，不抛异常
 *
 * @param {any} obj - 要解析的对象
 * @param {string} pathExpr - 路径表达式
 * @returns {any} 解析到的值，或 null
 */
function parsePath (obj, pathExpr) {
  if (!obj || !pathExpr) return null;

  // 按 || 分割为多个候选路径
  const candidates = pathExpr.split('||').map(s => s.trim());

  for (const path of candidates) {
    const value = resolveSinglePath(obj, path);
    if (value !== null && value !== undefined && value !== '') return value;
  }

  return null;
}

/**
 * 解析单条路径（不含 ||）
 * 支持: a.b.c / a[0].b / [0].a
 */
function resolveSinglePath (obj, path) {
  if (!obj) return null;
  // 将 a[0].b.c[1] 拆成 ['a', 0, 'b', 'c', 1]
  const segments = [];
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
  let match;
  while ((match = re.exec(path)) !== null) {
    if (match[1] !== undefined) segments.push(match[1]);
    else if (match[2] !== undefined) segments.push(parseInt(match[2], 10));
  }

  let current = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return null;
    if (typeof seg === 'number') {
      if (!Array.isArray(current) || seg >= current.length) return null;
      current = current[seg];
    } else {
      if (typeof current !== 'object' || !(seg in current)) return null;
      current = current[seg];
    }
  }

  return (current === null || current === undefined) ? null : current;
}

/** Estimate tokens — 中文友好:CJK 字符约 1.7 token/字, ASCII/其它约 1 token/4 字符 */
function estimateTokens (text) {
  if (!text) return 0;
  const cjkMatch = text.match(/[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g);
  const cjk = cjkMatch ? cjkMatch.length : 0;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.7 + rest / 4);
}

/** Extract code blocks from text */
function extractCodeBlocks (text) {
  if (!text) return [];
  const blocks = [];
  const regex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({ language: match[1] || 'text', code: match[2].trim() });
  }
  if (blocks.length === 0 && /^(def |function |class |import |const |let |var )/m.test(text)) {
    blocks.push({ language: 'text', code: text.trim() });
  }
  return blocks;
}

class BaseAdapter {
  constructor (config) {
    this.config = config;
    this.name = config.name;
    this.displayName = config.displayName;
    this.description = config.description || '';
  }

  async detect () { throw new Error('subclass must implement detect()'); }
  async execute (task, opts) { throw new Error('subclass must implement execute()'); }

  parsePath (obj, pathExpr) {
    return parsePath(obj, pathExpr);
  }

  buildResult (content, rawUsage) {
    const usage = rawUsage
      ? { input: rawUsage.input || 0, output: rawUsage.output || 0, total: (rawUsage.input || 0) + (rawUsage.output || 0), estimated: rawUsage.estimated || false }
      : { input: estimateTokens(content || ''), output: 0, total: 0, estimated: true };
    usage.total = usage.input + usage.output;
    return { content: content || '', codeBlocks: extractCodeBlocks(content), usage };
  }
}

module.exports = { BaseAdapter, parsePath, estimateTokens, extractCodeBlocks };
