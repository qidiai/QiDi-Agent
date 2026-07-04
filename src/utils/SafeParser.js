/**
 * 安全解析工具
 * 替代 eval/Function 和裸 JSON.parse，提供沙箱级安全解析。
 */

const { JsonParseError } = require('./AppError');

/**
 * 安全 JSON 解析，失败时返回 fallback 而非抛出异常。
 * @param {string} json - 待解析字符串
 * @param {*} fallback - 解析失败时的回退值
 * @returns {*} 解析结果或 fallback
 */
function safeJsonParse (json, fallback = null, options = {}) {
  if (typeof json !== 'string') return fallback;
  try {
    return JSON.parse(json);
  } catch (e) {
    // 如果提供了 source，生成带上下文的 JsonParseError
    if (options.source) {
      const ctxErr = new JsonParseError(
        `JSON 解析失败: ${e.message} — 来源: ${options.source}`,
        {
          rawText: json.length > 300 ? json.substring(0, 300) + '...' : json,
          cause: e,
          context: { source: options.source }
        }
      );
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(ctxErr.toString(), ctxErr.rawText ? `\n  原始数据: ${ctxErr.rawText}` : '');
      }
    }
    return fallback;
  }
}

/**
 * 安全 JSON 序列化（处理循环引用）。
 * @param {*} obj - 待序列化对象
 * @param {*} fallback - 序列化失败时的回退值
 * @returns {string} JSON 字符串或 fallback
 */
function safeJsonStringify (obj, fallback = '{}') {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return fallback;
  }
}

/**
 * 从可能包含前后缀文本的字符串中提取 JSON 对象。
 * 安全版本：不会执行 eval，只使用正则提取 + safeJsonParse。
 * @param {string} text - 可能包含 JSON 的文本
 * @param {*} fallback - 提取失败时的回退值
 * @returns {*} 提取的 JSON 对象或 fallback
 */
function safeExtractJson (text, fallback = null) {
  if (!text || typeof text !== 'string') return fallback;

  const direct = safeJsonParse(text.trim(), undefined);
  if (direct !== undefined) return direct;

  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch) {
    const parsed = safeJsonParse(jsonBlockMatch[1].trim(), undefined);
    if (parsed !== undefined) return parsed;
  }

  const objectMatch = text.match(/(\{[\s\S]*\})/);
  if (objectMatch) {
    const parsed = safeJsonParse(objectMatch[1].trim(), undefined);
    if (parsed !== undefined) return parsed;
  }

  const arrayMatch = text.match(/(\[[\s\S]*\])/);
  if (arrayMatch) {
    const parsed = safeJsonParse(arrayMatch[1].trim(), undefined);
    if (parsed !== undefined) return parsed;
  }

  return fallback;
}

/**
 * 安全执行数学表达式（替代 eval 用于简单计算）。
 * 使用词法分析和后缀表达式计算，消除代码注入风险。
 * @param {string} expression - 数学表达式
 * @param {number} fallback - 计算失败时的回退值
 * @returns {number} 计算结果或 fallback
 */
function safeMathEval (expression, fallback = 0) {
  if (typeof expression !== 'string') return fallback;
  const sanitized = expression.replace(/[^0-9+\-*/().\s]/g, '');
  if (!sanitized) return fallback;
  try {
    const tokens = tokenize(sanitized);
    const postfix = infixToPostfix(tokens);
    return evaluatePostfix(postfix);
  } catch (e) {
    return fallback;
  }
}

function tokenize (expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const char = expr[i];
    if (char === ' ') {
      i++;
      continue;
    }
    if (char === '(' || char === ')' || '+-*/'.includes(char)) {
      tokens.push(char);
      i++;
    } else if (/\d/.test(char)) {
      let num = '';
      while (i < expr.length && (/\d/.test(expr[i]) || expr[i] === '.')) {
        num += expr[i];
        i++;
      }
      tokens.push(parseFloat(num));
    } else {
      i++;
    }
  }
  return tokens;
}

function infixToPostfix (tokens) {
  const output = [];
  const stack = [];
  const precedence = { '+': 1, '-': 1, '*': 2, '/': 2 };
  for (const token of tokens) {
    if (typeof token === 'number') {
      output.push(token);
    } else if (token === '(') {
      stack.push(token);
    } else if (token === ')') {
      while (stack.length && stack[stack.length - 1] !== '(') {
        output.push(stack.pop());
      }
      stack.pop();
    } else {
      while (stack.length && stack[stack.length - 1] !== '(' &&
        precedence[stack[stack.length - 1]] >= precedence[token]) {
        output.push(stack.pop());
      }
      stack.push(token);
    }
  }
  while (stack.length) output.push(stack.pop());
  return output;
}

function evaluatePostfix (postfix) {
  const stack = [];
  for (const token of postfix) {
    if (typeof token === 'number') {
      stack.push(token);
    } else {
      const b = stack.pop();
      const a = stack.pop();
      switch (token) {
      case '+': stack.push(a + b); break;
      case '-': stack.push(a - b); break;
      case '*': stack.push(a * b); break;
      case '/': stack.push(b !== 0 ? a / b : 0); break;
      }
    }
  }
  return stack[0] || 0;
}

/**
 * 安全路径验证：确保路径在工作目录内。
 * @param {string} targetPath - 目标路径
 * @param {string} baseDir - 基准目录
 * @returns {boolean} 是否安全
 */
function isPathSafe (targetPath, baseDir) {
  if (!targetPath || !baseDir) return false;
  const path = require('path');
  const normalized = path.normalize(path.resolve(baseDir, targetPath));
  const baseNormalized = path.normalize(path.resolve(baseDir));
  return normalized.startsWith(baseNormalized);
}

/**
 * 安全命令参数构建：防止命令注入。
 * @param {string[]} args - 命令参数数组
 * @returns {string[]} 清理后的参数
 */
function safeCommandArgs (args) {
  if (!Array.isArray(args)) return [];
  return args.map(arg => {
    if (typeof arg !== 'string') return String(arg);
    return arg.replace(/[;|&$`'"{}[\]<>\n\r]/g, '');
  });
}

module.exports = {
  safeJsonParse,
  safeJsonStringify,
  safeExtractJson,
  safeMathEval,
  isPathSafe,
  safeCommandArgs
};
