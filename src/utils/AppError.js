'use strict';

/**
 * AppError —— 应用级自定义异常基类
 *
 * 统一错误处理体系的基础，所有自定义异常继承此类。
 * 提供 timestamp、context、cause、toJSON 等通用能力。
 *
 * @example
 *   throw new AppError('操作失败', { context: { userId: 123 } });
 */
class AppError extends Error {
  /**
   * @param {string} message - 人类可读的错误描述
   * @param {Object} [options]
   * @param {Object} [options.context]   - 附加上下文（请求 ID、用户信息等）
   * @param {Error}  [options.cause]     - 原始异常（链式保留）
   * @param {string} [options.timestamp] - ISO 时间戳，默认 new Date().toISOString()
   */
  constructor (message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.timestamp = options.timestamp || new Date().toISOString();
    this.context = options.context || {};

    // 保留原始异常链
    if (options.cause instanceof Error) {
      this.cause = options.cause;
    }

    // 规范 stack trace（部分引擎不支持）
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * 序列化为纯对象（日志 / 网络传输友好）
   * @returns {Object}
   */
  toJSON () {
    return {
      name: this.name,
      message: this.message,
      stack: this.stack,
      timestamp: this.timestamp,
      context: this.context,
      cause: this.cause instanceof Error
        ? { name: this.cause.name, message: this.cause.message, stack: this.cause.stack }
        : this.cause
    };
  }

  /**
   * 友好的控制台输出
   * @returns {string}
   */
  toString () {
    const parts = [`[${this.name}] ${this.message}`];
    if (this.cause) parts.push(`(cause: ${this.cause.message})`);
    return parts.join(' ');
  }
}

// ─── 网络异常 ─────────────────────────────────────────────────

/**
 * NetworkError —— 网络层异常（DNS 解析失败、连接拒绝、TLS 握手失败等）
 *
 * @example
 *   throw new NetworkError(`连接失败: ${err.message}`, {
 *     url: 'https://api.example.com/v1/chat',
 *     method: 'POST',
 *     cause: originalError
 *   });
 */
class NetworkError extends AppError {
  /**
   * @param {string} message
   * @param {Object} [options]
   * @param {string} [options.url]     - 请求 URL
   * @param {string} [options.method]  - HTTP 方法
   * @param {Error}  [options.cause]   - 原始异常
   */
  constructor (message, options = {}) {
    super(message, options);
    this.url = options.url || '';
    this.method = (options.method || 'GET').toUpperCase();
  }

  toJSON () {
    return {
      ...super.toJSON(),
      url: this.url,
      method: this.method
    };
  }
}

/**
 * TimeoutError —— 请求超时异常
 *
 * 当请求在指定时间内未获得完整响应时抛出。
 *
 * @example
 *   throw new TimeoutError(
 *     `请求超时: POST https://api.example.com/v1/chat (timeout=30000ms)`,
 *     { url, method: 'POST', timeout: 30000 }
 *   );
 */
class TimeoutError extends AppError {
  /**
   * @param {string} message
   * @param {Object} [options]
   * @param {string} [options.url]     - 请求 URL
   * @param {string} [options.method]  - HTTP 方法
   * @param {number} [options.timeout] - 超时阈值（毫秒）
   * @param {Error}  [options.cause]   - 原始异常
   */
  constructor (message, options = {}) {
    super(message, options);
    this.url = options.url || '';
    this.method = (options.method || 'GET').toUpperCase();
    this.timeout = options.timeout || 0;
  }

  toJSON () {
    return {
      ...super.toJSON(),
      url: this.url,
      method: this.method,
      timeout: this.timeout
    };
  }
}

/**
 * HttpError —— HTTP 错误状态码异常（4xx / 5xx）
 *
 * 当服务器返回 >= 400 的状态码时抛出，包含完整的响应信息。
 *
 * @example
 *   throw new HttpError('请求被拒绝', {
 *     url: 'https://api.example.com/v1/chat',
 *     method: 'POST',
 *     status: 403,
 *     statusText: 'Forbidden',
 *     responseData: { error: 'insufficient_quota' },
 *     responseHeaders: { 'x-request-id': 'abc123' }
 *   });
 */
class HttpError extends AppError {
  /**
   * @param {string} message
   * @param {Object} [options]
   * @param {string} [options.url]             - 请求 URL
   * @param {string} [options.method]          - HTTP 方法
   * @param {number} [options.status]          - HTTP 状态码
   * @param {string} [options.statusText]      - 状态文本
   * @param {*}      [options.responseData]    - 响应体数据
   * @param {Object} [options.responseHeaders] - 响应头
   * @param {Error}  [options.cause]           - 原始异常
   */
  constructor (message, options = {}) {
    super(message, options);
    this.url = options.url || '';
    this.method = (options.method || 'GET').toUpperCase();
    this.status = options.status || 0;
    this.statusText = options.statusText || '';
    this.responseData = options.responseData !== undefined ? options.responseData : null;
    this.responseHeaders = options.responseHeaders || {};
  }

  /**
   * 是否为客户端错误 (4xx)
   * @returns {boolean}
   */
  get isClientError () {
    return this.status >= 400 && this.status < 500;
  }

  /**
   * 是否为服务端错误 (5xx)
   * @returns {boolean}
   */
  get isServerError () {
    return this.status >= 500 && this.status < 600;
  }

  /**
   * 是否为速率限制错误 (429)
   * @returns {boolean}
   */
  get isRateLimited () {
    return this.status === 429;
  }

  toJSON () {
    return {
      ...super.toJSON(),
      url: this.url,
      method: this.method,
      status: this.status,
      statusText: this.statusText,
      responseData: this.responseData,
      isClientError: this.isClientError,
      isServerError: this.isServerError,
      isRateLimited: this.isRateLimited
    };
  }
}

/**
 * JsonParseError —— JSON 解析异常
 *
 * 当响应体无法被解析为预期的 JSON 格式时抛出，保留原始文本用于诊断。
 *
 * @example
 *   throw new JsonParseError('响应体 JSON 解析失败', {
 *     url: 'https://api.example.com/v1/chat',
 *     rawText: body.substring(0, 500),
 *     cause: parseError
 *   });
 */
class JsonParseError extends AppError {
  /**
   * @param {string} message
   * @param {Object} [options]
   * @param {string} [options.url]     - 请求 URL
   * @param {string} [options.rawText] - 原始响应文本（建议截断以免日志爆炸）
   * @param {Error}  [options.cause]   - 原始解析异常
   */
  constructor (message, options = {}) {
    super(message, options);
    this.url = options.url || '';
    this.rawText = options.rawText || '';
  }

  toJSON () {
    return {
      ...super.toJSON(),
      url: this.url,
      rawText: this.rawText.length > 200
        ? this.rawText.substring(0, 200) + '...'
        : this.rawText
    };
  }
}

// ─── 工具异常 ─────────────────────────────────────────────────

class ToolError extends AppError {
  constructor (message, options = {}) {
    super(message, options);
    this.toolName = options.toolName || '';
    this.toolStatus = options.toolStatus || 'unknown';
    this.retries = options.retries || 0;
    this.maxRetries = options.maxRetries || 0;
  }

  toJSON () {
    return {
      ...super.toJSON(),
      toolName: this.toolName,
      toolStatus: this.toolStatus,
      retries: this.retries,
      maxRetries: this.maxRetries
    };
  }
}

class ToolTimeoutError extends ToolError {
  constructor (message, options = {}) {
    super(message, options);
    this.timeout = options.timeout || 0;
  }

  toJSON () {
    return {
      ...super.toJSON(),
      timeout: this.timeout
    };
  }
}

class ToolUnavailableError extends ToolError {
  constructor (message, options = {}) {
    super(message, options);
    this.suggestedFallback = options.suggestedFallback || null;
  }

  toJSON () {
    return {
      ...super.toJSON(),
      suggestedFallback: this.suggestedFallback
    };
  }
}

// ─── 业务逻辑异常 ───────────────────────────────────────────────

class ValidationError extends AppError {
  constructor (message, options = {}) {
    super(message, options);
    this.field = options.field || '';
    this.value = options.value !== undefined ? options.value : null;
    this.rule = options.rule || '';
  }

  toJSON () {
    return {
      ...super.toJSON(),
      field: this.field,
      value: this.value,
      rule: this.rule
    };
  }
}

class ConfigurationError extends AppError {
  constructor (message, options = {}) {
    super(message, options);
    this.configKey = options.configKey || '';
    this.expected = options.expected || '';
    this.actual = options.actual !== undefined ? options.actual : null;
  }

  toJSON () {
    return {
      ...super.toJSON(),
      configKey: this.configKey,
      expected: this.expected,
      actual: this.actual
    };
  }
}

class TaskError extends AppError {
  constructor (message, options = {}) {
    super(message, options);
    this.taskId = options.taskId || '';
    this.taskType = options.taskType || '';
    this.stage = options.stage || '';
  }

  toJSON () {
    return {
      ...super.toJSON(),
      taskId: this.taskId,
      taskType: this.taskType,
      stage: this.stage
    };
  }
}

// ─── 熔断机制异常 ───────────────────────────────────────────────

class CircuitBreakerError extends AppError {
  constructor (message, options = {}) {
    super(message, options);
    this.circuitName = options.circuitName || '';
    this.circuitState = options.circuitState || 'open';
    this.failureCount = options.failureCount || 0;
    this.resetTimeout = options.resetTimeout || 0;
  }

  toJSON () {
    return {
      ...super.toJSON(),
      circuitName: this.circuitName,
      circuitState: this.circuitState,
      failureCount: this.failureCount,
      resetTimeout: this.resetTimeout
    };
  }
}

// ─── 错误处理工具函数 ───────────────────────────────────────────

class ErrorHandler {
  static wrap (fn, options = {}) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(error.message, { cause: error, context: options.context });
      }
    };
  }

  static async retry (fn, options = {}) {
    const { maxRetries = 3, delay = 1000, backoff = 1.5, onRetry } = options;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (onRetry) {
          await onRetry(attempt, error);
        }
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delay * Math.pow(backoff, attempt - 1)));
        }
      }
    }

    throw lastError;
  }

  static classify (error) {
    if (error instanceof NetworkError) return 'network';
    if (error instanceof TimeoutError) return 'timeout';
    if (error instanceof HttpError) return 'http';
    if (error instanceof ToolError) return 'tool';
    if (error instanceof ValidationError) return 'validation';
    if (error instanceof ConfigurationError) return 'configuration';
    if (error instanceof CircuitBreakerError) return 'circuit';
    return 'unknown';
  }

  static shouldRetry (error) {
    const category = ErrorHandler.classify(error);
    return ['network', 'timeout', 'http', 'tool'].includes(category);
  }

  static formatError (error) {
    if (error instanceof AppError) {
      return error.toJSON();
    }
    return {
      name: error.name || 'Error',
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    };
  }
}

// ─── 导出 ─────────────────────────────────────────────────────

module.exports = {
  AppError,
  NetworkError,
  TimeoutError,
  HttpError,
  JsonParseError,
  ToolError,
  ToolTimeoutError,
  ToolUnavailableError,
  ValidationError,
  ConfigurationError,
  TaskError,
  CircuitBreakerError,
  ErrorHandler
};

module.exports.AppError = AppError;
module.exports.NetworkError = NetworkError;
module.exports.TimeoutError = TimeoutError;
module.exports.HttpError = HttpError;
module.exports.JsonParseError = JsonParseError;
module.exports.ToolError = ToolError;
module.exports.ToolTimeoutError = ToolTimeoutError;
module.exports.ToolUnavailableError = ToolUnavailableError;
module.exports.ValidationError = ValidationError;
module.exports.ConfigurationError = ConfigurationError;
module.exports.TaskError = TaskError;
module.exports.CircuitBreakerError = CircuitBreakerError;
module.exports.ErrorHandler = ErrorHandler;
