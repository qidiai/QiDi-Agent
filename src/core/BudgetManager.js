/**
 * @module BudgetManager
 *
 * Token 预算与成本管理器。
 *
 * 核心能力：
 * 1. 全局 token 预算设定与追踪
 * 2. 按环节（拆分/生成/审查/质检/合并）分配子预算
 * 3. 实时消耗监控与超预算告警
 * 4. 自动降级（大模型→小模型）
 * 5. 成本报告生成
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/Logger')('BudgetManager');
const { safeJsonParse } = require('../utils/SafeParser');

class BudgetManager extends EventEmitter {
  constructor (options = {}) {
    super();
    this.totalBudget = options.totalBudget || 100000; // 默认 10万 token
    this.alarmThreshold = options.alarmThreshold || 0.8; // 80% 告警
    this.criticalThreshold = options.criticalThreshold || 0.95; // 95% 严重
    this.autoDegrade = options.autoDegrade !== false;

    // 环节预算分配比例
    this.phaseRatios = options.phaseRatios || {
      splitter: 0.05, // 任务拆分 5%
      codeWriter: 0.50, // 代码生成 50%
      reviewer: 0.10, // 代码审查 10%
      quality: 0.15, // 质检 15%
      merge: 0.15, // 合并 15%
      other: 0.05 // 其他 5%
    };

    // 模型成本（每千token价格，单位：美元）
    this.modelCosts = options.modelCosts || {
      'qwen2.5:7b': { input: 0, output: 0 }, // 本地免费
      'qwen2.5:3b': { input: 0, output: 0 },
      'deepseek-chat': { input: 0.14, output: 0.28 }, // 每百万token
      'gpt-4': { input: 30, output: 60 },
      'gpt-4o-mini': { input: 0.15, output: 0.6 },
      'claude-3-5-sonnet': { input: 3, output: 15 },
      'claude-3-haiku': { input: 0.25, output: 1.25 }
    };

    this.consumption = {
      total: 0,
      byPhase: {},
      byAgent: {},
      byModel: {},
      history: []
    };

    this.persistPath = options.persistPath || path.join(process.cwd(), 'data', 'budget_history.json');
    this._load();
  }

  /**
   * 获取某个环节的预算
   */
  getPhaseBudget (phase) {
    const ratio = this.phaseRatios[phase] || this.phaseRatios.other || 0.05;
    return Math.floor(this.totalBudget * ratio);
  }

  /**
   * 记录消耗
   */
  record (phase, agentName, model, inputTokens, outputTokens) {
    const totalTokens = (inputTokens || 0) + (outputTokens || 0);

    const entry = {
      timestamp: Date.now(),
      phase,
      agent: agentName,
      model,
      inputTokens: inputTokens || 0,
      outputTokens: outputTokens || 0,
      totalTokens,
      cost: this._calculateCost(model, inputTokens, outputTokens)
    };

    this.consumption.total += totalTokens;
    this.consumption.byPhase[phase] = (this.consumption.byPhase[phase] || 0) + totalTokens;
    this.consumption.byAgent[agentName] = (this.consumption.byAgent[agentName] || 0) + totalTokens;
    this.consumption.byModel[model] = (this.consumption.byModel[model] || 0) + totalTokens;
    this.consumption.history.push(entry);

    // 限制历史大小
    if (this.consumption.history.length > 1000) {
      this.consumption.history.shift();
    }

    // 检查阈值
    const usage = this.getUsageRate();
    if (usage >= this.criticalThreshold) {
      this.emit('critical', { usage, remaining: this.getRemaining() });
      logger.warn(`[BudgetManager] 预算严重不足: ${(usage * 100).toFixed(1)}%`);
    } else if (usage >= this.alarmThreshold) {
      this.emit('alarm', { usage, remaining: this.getRemaining() });
      logger.info(`[BudgetManager] 预算告警: ${(usage * 100).toFixed(1)}%`);
    }

    this._saveDebounced();
  }

  /**
   * 获取使用率
   */
  getUsageRate () {
    return this.totalBudget > 0 ? this.consumption.total / this.totalBudget : 0;
  }

  /**
   * 获取剩余预算
   */
  getRemaining () {
    return Math.max(0, this.totalBudget - this.consumption.total);
  }

  /**
   * 检查是否可以继续执行
   */
  canProceed (estimatedTokens = 0) {
    return this.getRemaining() >= estimatedTokens;
  }

  /**
   * 检查是否需要降级
   */
  shouldDegrade (estimatedTokens = 0) {
    if (!this.autoDegrade) return false;
    const remaining = this.getRemaining();
    const usage = this.getUsageRate();
    // 超过 80% 且剩余不足预估的2倍
    return usage >= this.alarmThreshold && remaining < estimatedTokens * 2;
  }

  /**
   * 计算成本
   */
  _calculateCost (model, inputTokens, outputTokens) {
    const cost = this.modelCosts[model];
    if (!cost) return 0;
    return (inputTokens / 1000000) * cost.input + (outputTokens / 1000000) * cost.output;
  }

  /**
   * 获取总成本
   */
  getTotalCost () {
    return this.consumption.history.reduce((sum, e) => sum + (e.cost || 0), 0);
  }

  /**
   * 生成预算报告
   */
  generateReport () {
    const usage = this.getUsageRate();
    const remaining = this.getRemaining();
    const totalCost = this.getTotalCost();

    const phaseBreakdown = {};
    for (const [phase, tokens] of Object.entries(this.consumption.byPhase)) {
      phaseBreakdown[phase] = {
        tokens,
        percentage: this.totalBudget > 0 ? (tokens / this.totalBudget * 100).toFixed(1) + '%' : '0%',
        budget: this.getPhaseBudget(phase),
        budgetUsage: this.getPhaseBudget(phase) > 0 ? (tokens / this.getPhaseBudget(phase) * 100).toFixed(1) + '%' : '0%'
      };
    }

    const modelBreakdown = {};
    for (const [model, tokens] of Object.entries(this.consumption.byModel)) {
      modelBreakdown[model] = {
        tokens,
        cost: this.consumption.history
          .filter(e => e.model === model)
          .reduce((sum, e) => sum + (e.cost || 0), 0)
      };
    }

    return {
      totalBudget: this.totalBudget,
      totalConsumed: this.consumption.total,
      remaining,
      usageRate: (usage * 100).toFixed(1) + '%',
      totalCost: `$${totalCost.toFixed(4)}`,
      status: usage >= this.criticalThreshold ? 'critical' : usage >= this.alarmThreshold ? 'warning' : 'normal',
      phaseBreakdown,
      modelBreakdown,
      agentBreakdown: { ...this.consumption.byAgent },
      entryCount: this.consumption.history.length
    };
  }

  /**
   * 重置预算（新会话）
   */
  reset (newBudget = null) {
    if (newBudget) this.totalBudget = newBudget;
    this.consumption = {
      total: 0,
      byPhase: {},
      byAgent: {},
      byModel: {},
      history: []
    };
    this._save();
    this.emit('reset', { totalBudget: this.totalBudget });
  }

  _saveTimer = null;

  _saveDebounced () {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 5000);
  }

  _save () {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify({
        totalBudget: this.totalBudget,
        consumption: this.consumption,
        savedAt: new Date().toISOString()
      }, null, 2), 'utf-8');
    } catch (e) {
      logger.warn(`[BudgetManager] 保存失败: ${e.message}`);
    }
  }

  _load () {
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = safeJsonParse(fs.readFileSync(this.persistPath, 'utf-8'), {});
        if (data.consumption) {
          this.consumption = data.consumption;
          if (data.totalBudget) this.totalBudget = data.totalBudget;
        }
      }
    } catch (e) {
      logger.warn(`[BudgetManager] 加载失败: ${e.message}`);
    }
  }
}

module.exports = BudgetManager;
