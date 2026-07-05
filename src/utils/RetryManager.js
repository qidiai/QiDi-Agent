/**
 * @module RetryManager
 *
 * 智能重试与错误分类管理器。
 *
 * 核心能力：
 * 1. 错误分类：瞬时错误(重试) / 逻辑错误(不重试) / 配额错误(等待) / 认证错误(终止)
 * 2. 指数退避 + 抖动
 * 3. 重试时自动调整参数（降低temperature等）
 * 4. 与熔断器联动
 */

const logger = require('../utils/Logger')('RetryManager');

// ── 错误类型 ──

const ErrorType = {
  TRANSIENT: 'transient', // 瞬时错误：网络超时、服务暂不可用 → 重试
  RATE_LIMIT: 'rate_limit', // 速率限制 → 等待后重试
  LOGICAL: 'logical', // 逻辑错误：代码bug、参数错误 → 不重试
  AUTH: 'auth', // 认证错误：API Key无效 → 不重试
  QUOTA: 'quota', // 配额耗尽 → 不重试（或等待长时间）
  PARSE: 'parse', // 解析错误：JSON解析失败 → 重试（降低temperature）
  TIMEOUT: 'timeout', // 超时 → 重试（增加超时时间）
  UNKNOWN: 'unknown' // 未知 → 保守重试
};

// ── 错误分类规则 ──

const ERROR_PATTERNS = [
  { type: ErrorType.TIMEOUT, patterns: [/timeout/i, /timed?\s*out/i, /ETIMEDOUT/i, /deadline\s*exceeded/i], action: 'retry' },
  { type: ErrorType.TRANSIENT, patterns: [/ECONNRESET/i, /ECONNREFUSED/i, /EAI_AGAIN/i, /socket\s*hang\s*up/i, /network/i, /EPIPE/i, /EHOSTUNREACH/i, /ENETUNREACH/i], action: 'retry' },
  { type: ErrorType.RATE_LIMIT, patterns: [/rate\s*limit/i, /429/i, /too\s*many\s*requests/i, /throttl/i], action: 'wait_retry' },
  { type: ErrorType.QUOTA, patterns: [/quota/i, /insufficient.*quota/i, /billing/i, /payment/i, /credit/i, /402/i], action: 'no_retry' },
  { type: ErrorType.AUTH, patterns: [/unauthorized/i, /401/i, /invalid.*api.*key/i, /authentication/i, /forbidden/i, /403/i], action: 'no_retry' },
  { type: ErrorType.LOGICAL, patterns: [/syntax\s*error/i, /invalid\s*argument/i, /400/i, /bad\s*request/i, /validation/i], action: 'no_retry' },
  { type: ErrorType.PARSE, patterns: [/json.*parse/i, /unexpected\s*token/i, /parseerror/i, /JSON\.parse/i], action: 'retry_adjust' }
];

class RetryManager {
  constructor (options = {}) {
    this.maxRetries = options.maxRetries || 3;
    this.initialDelay = options.initialDelay || 1000;
    this.maxDelay = options.maxDelay || 30000;
    this.backoffFactor = options.backoffFactor || 2;
    this.jitter = options.jitter !== false;
    this.jitterRatio = options.jitterRatio || 0.25;

    // 错误统计
    this.stats = {
      totalAttempts: 0,
      totalRetries: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      byErrorType: {}
    };
  }

  /**
   * 分类错误
   */
  classify (error) {
    const message = error?.message || String(error);
    const code = error?.code || '';
    const status = error?.status || error?.statusCode || 0;
    const text = `${message} ${code} ${status}`;

    for (const rule of ERROR_PATTERNS) {
      for (const pattern of rule.patterns) {
        if (pattern.test(text)) {
          return { type: rule.type, action: rule.action, message };
        }
      }
    }

    // HTTP 状态码判断
    if (status >= 500) return { type: ErrorType.TRANSIENT, action: 'retry', message };
    if (status === 429) return { type: ErrorType.RATE_LIMIT, action: 'wait_retry', message };

    return { type: ErrorType.UNKNOWN, action: 'retry', message };
  }

  /**
   * 计算延迟时间
   */
  calculateDelay (attempt, errorType) {
    let delay = this.initialDelay * Math.pow(this.backoffFactor, attempt);

    // 特殊处理
    if (errorType === ErrorType.RATE_LIMIT) {
      delay = Math.max(delay, 5000); // 速率限制至少等5秒
    } else if (errorType === ErrorType.TIMEOUT) {
      delay = Math.max(delay, 2000);
    }

    // 上限
    delay = Math.min(delay, this.maxDelay);

    // 抖动
    if (this.jitter) {
      const jitterAmount = delay * this.jitterRatio;
      delay += (Math.random() * 2 - 1) * jitterAmount;
    }

    return Math.max(0, Math.floor(delay));
  }

  /**
   * 获取重试参数调整建议
   */
  getParameterAdjustments (errorType, attempt) {
    const adjustments = {};

    if (errorType === ErrorType.PARSE) {
      // 解析错误：降低 temperature
      adjustments.temperature = Math.max(0.1, 0.7 - attempt * 0.2);
    } else if (errorType === ErrorType.TIMEOUT) {
      // 超时：增加超时时间
      adjustments.timeout = (attempt + 1) * 60000;
    } else if (errorType === ErrorType.TRANSIENT) {
      // 瞬时错误：略微降低 temperature
      adjustments.temperature = Math.max(0.2, 0.7 - attempt * 0.1);
    }

    return adjustments;
  }

  /**
   * 执行带重试的异步操作
   */
  async execute (fn, options = {}) {
    const maxRetries = options.maxRetries || this.maxRetries;
    const onRetry = options.onRetry || (() => {});
    const baseParams = options.params || {};

    let lastError = null;
    let lastErrorType = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      this.stats.totalAttempts++;

      try {
        // 合并参数调整
        const adjustedParams = lastErrorType
          ? { ...baseParams, ...this.getParameterAdjustments(lastErrorType, attempt) }
          : baseParams;

        const result = await fn(adjustedParams, attempt);
        this.stats.totalSuccesses++;
        return result;
      } catch (error) {
        lastError = error;
        const classification = this.classify(error);
        lastErrorType = classification.type;

        this.stats.byErrorType[classification.type] = (this.stats.byErrorType[classification.type] || 0) + 1;

        // 不重试的情况
        if (classification.action === 'no_retry' || attempt >= maxRetries) {
          this.stats.totalFailures++;
          throw error;
        }

        // 重试
        const delay = this.calculateDelay(attempt, classification.type);
        this.stats.totalRetries++;

        logger.info(`[RetryManager] 第${attempt + 1}次重试 (${classification.type}): 延迟${delay}ms`);

        onRetry({
          attempt: attempt + 1,
          maxRetries,
          delay,
          errorType: classification.type,
          error: error.message,
          adjustments: this.getParameterAdjustments(classification.type, attempt + 1)
        });

        await this._sleep(delay);
      }
    }

    this.stats.totalFailures++;
    throw lastError;
  }

  /**
   * 获取统计信息
   */
  getStats () {
    const successRate = this.stats.totalAttempts > 0
      ? (this.stats.totalSuccesses / this.stats.totalAttempts * 100).toFixed(1) + '%'
      : '0%';

    return {
      ...this.stats,
      successRate,
      retryRate: this.stats.totalAttempts > 0
        ? (this.stats.totalRetries / this.stats.totalAttempts * 100).toFixed(1) + '%'
        : '0%'
    };
  }

  /**
   * 重置统计
   */
  resetStats () {
    this.stats = {
      totalAttempts: 0,
      totalRetries: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      byErrorType: {}
    };
  }

  _sleep (ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { RetryManager, ErrorType };
