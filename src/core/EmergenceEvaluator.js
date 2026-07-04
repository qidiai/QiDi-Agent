const logger = require('../utils/Logger')('EmergenceEvaluator');
const fs = require('fs');
const path = require('path');

/**
 * 涌现评估器
 *
 * 增强版：内置结构化基线数据库，自动获取和缓存单工具基线。
 *
 * 基线获取策略（按优先级）：
 * 1. 显式传入的 singleToolQuality
 * 2. 基线数据库中相同任务类型的历史基线
 * 3. 同工具历史执行的平均质量
 * 4. 全局历史基线均值
 * 5. 无基线（返回 NO_CONTROL_GROUP）
 */

class EmergenceEvaluator {
  constructor(options = {}) {
    this.threshold = options.threshold || 0.2;
    this.baselineQuality = options.baselineQuality || null;
    this.history = options.history || [];
    this._historyPath = path.join(__dirname, '..', '..', 'data', 'emergence_history.json');

    // 基线数据库
    this._baselineDBPath = path.join(__dirname, '..', '..', 'data', 'baseline_db.json');
    this._baselineDB = {
      byTool: {},        // toolName -> { avgQuality, count, lastUpdate, samples: [] }
      byTaskType: {},    // taskType -> { avgQuality, count, samples: [] }
      byToolTaskType: {},// "tool:taskType" -> { avgQuality, count, samples: [] }
      globalBaseline: null  // 全局基线均值
    };

    this._loadHistory();
    this._loadBaselineDB();
  }

  /**
   * 评估涌现效应
   * @param {Object} params - { multiToolQuality, singleToolQuality, synchrony, mode, tools, taskType, taskDescription }
   */
  async evaluate({ multiToolQuality, singleToolQuality, synchrony, mode, tools, taskType, taskDescription }) {
    try {
      // 尝试获取基线
      let baseline = singleToolQuality;
      let baselineSource = 'explicit';

      if (baseline === undefined || baseline === null) {
        // 从基线数据库获取
        const dbResult = this._getBaselineFromDB(tools, taskType);
        baseline = dbResult.quality;
        baselineSource = dbResult.source;
      }

      if (baseline === null || baseline === undefined) {
        // 记录到历史
        const noBaselineRecord = {
          timestamp: Date.now(),
          emergenceGain: 0,
          emerged: false,
          verdict: 'NO_CONTROL_GROUP',
          baseline: null,
          multiToolQuality,
          synchrony,
          mode,
          tools: tools || [],
          taskType: taskType || 'unknown',
          controlGroup: null
        };
        this.history.push(noBaselineRecord);
        await this._saveHistory();

        return {
          emergenceGain: 0,
          emerged: false,
          verdict: 'NO_CONTROL_GROUP',
          baseline: null,
          controlGroup: null,
          baselineSource: 'none'
        };
      }

      const emergenceGain = multiToolQuality - baseline;
      const emerged = emergenceGain > this.threshold;

      let verdict;
      if (emerged) {
        verdict = 'EMERGENT';
      } else if (emergenceGain > 0) {
        verdict = 'MARGINAL';
      } else {
        verdict = 'NEGATIVE';
      }

      const controlGroup = {
        quality: baseline,
        source: baselineSource
      };

      const record = {
        timestamp: Date.now(),
        emergenceGain,
        emerged,
        verdict,
        baseline,
        multiToolQuality,
        synchrony,
        mode,
        tools: tools || [],
        taskType: taskType || 'unknown',
        taskDescription: taskDescription?.substring(0, 200),
        controlGroup
      };
      this.history.push(record);
      await this._saveHistory();

      // 记录多工具质量到基线数据库（作为未来基线参考）
      this._recordToBaselineDB(tools, taskType, multiToolQuality, mode);

      return { emergenceGain, emerged, verdict, baseline, controlGroup, baselineSource };
    } catch (e) {
      logger.warn(`[EmergenceEvaluator] 评估失败: ${e.message}`);
      return { emergenceGain: 0, emerged: false, verdict: 'ERROR', baseline: null, controlGroup: null, baselineSource: 'error' };
    }
  }

  /**
   * 记录单工具基线
   * @param {number} quality - 单工具质量评分
   * @param {string} toolName - 工具名
   * @param {string} taskType - 任务类型
   */
  recordBaseline(quality, toolName = null, taskType = null) {
    this.baselineQuality = quality;

    if (toolName) {
      this._recordToBaselineDB([toolName], taskType, quality, 'single-tool');
    }

    logger.info(`[EmergenceEvaluator] 对照组基线已记录: ${quality} (tool=${toolName}, taskType=${taskType})`);
  }

  /**
   * 从基线数据库获取基线
   * 策略：优先使用 "tool+taskType" 组合，其次 taskType，再次 tool，最后全局
   */
  _getBaselineFromDB(tools, taskType) {
    if (!tools || tools.length === 0) {
      // 仅按任务类型查找
      if (taskType && this._baselineDB.byTaskType[taskType]) {
        return { quality: this._baselineDB.byTaskType[taskType].avgQuality, source: `db:taskType:${taskType}` };
      }
    } else {
      // 尝试 "tool+taskType" 组合
      if (taskType) {
        for (const tool of tools) {
          const key = `${tool}:${taskType}`;
          if (this._baselineDB.byToolTaskType[key]) {
            return { quality: this._baselineDB.byToolTaskType[key].avgQuality, source: `db:tool+taskType:${key}` };
          }
        }
      }

      // 尝试按工具查找
      for (const tool of tools) {
        if (this._baselineDB.byTool[tool]) {
          return { quality: this._baselineDB.byTool[tool].avgQuality, source: `db:tool:${tool}` };
        }
      }
    }

    // 尝试按任务类型查找
    if (taskType && this._baselineDB.byTaskType[taskType]) {
      return { quality: this._baselineDB.byTaskType[taskType].avgQuality, source: `db:taskType:${taskType}` };
    }

    // 全局基线
    if (this._baselineDB.globalBaseline !== null) {
      return { quality: this._baselineDB.globalBaseline, source: 'db:global' };
    }

    // 显式设置的基线
    if (this.baselineQuality !== null) {
      return { quality: this.baselineQuality, source: 'explicit' };
    }

    return { quality: null, source: 'none' };
  }

  /**
   * 记录到基线数据库
   */
  _recordToBaselineDB(tools, taskType, quality, mode) {
    const sample = { quality, mode, timestamp: Date.now() };
    const MAX_SAMPLES = 50;

    // 记录到全局基线
    const allSamples = this.history
      .filter(r => r.verdict !== 'NO_CONTROL_GROUP' && r.baseline !== null)
      .map(r => r.multiToolQuality);
    if (allSamples.length > 0) {
      this._baselineDB.globalBaseline = allSamples.reduce((a, b) => a + b, 0) / allSamples.length;
    }

    // 记录到工具基线
    if (tools && tools.length > 0 && mode === 'single-tool') {
      for (const tool of tools) {
        if (!this._baselineDB.byTool[tool]) {
          this._baselineDB.byTool[tool] = { avgQuality: 0, count: 0, lastUpdate: 0, samples: [] };
        }
        const entry = this._baselineDB.byTool[tool];
        entry.samples.push(sample);
        if (entry.samples.length > MAX_SAMPLES) entry.samples.shift();
        entry.count = entry.samples.length;
        entry.avgQuality = entry.samples.reduce((a, s) => a + s.quality, 0) / entry.count;
        entry.lastUpdate = Date.now();
      }
    }

    // 记录到任务类型基线
    if (taskType) {
      if (!this._baselineDB.byTaskType[taskType]) {
        this._baselineDB.byTaskType[taskType] = { avgQuality: 0, count: 0, samples: [] };
      }
      const entry = this._baselineDB.byTaskType[taskType];
      entry.samples.push(sample);
      if (entry.samples.length > MAX_SAMPLES) entry.samples.shift();
      entry.count = entry.samples.length;
      entry.avgQuality = entry.samples.reduce((a, s) => a + s.quality, 0) / entry.count;
    }

    // 记录到 "tool+taskType" 组合基线
    if (tools && tools.length > 0 && taskType && mode === 'single-tool') {
      for (const tool of tools) {
        const key = `${tool}:${taskType}`;
        if (!this._baselineDB.byToolTaskType[key]) {
          this._baselineDB.byToolTaskType[key] = { avgQuality: 0, count: 0, samples: [] };
        }
        const entry = this._baselineDB.byToolTaskType[key];
        entry.samples.push(sample);
        if (entry.samples.length > MAX_SAMPLES) entry.samples.shift();
        entry.count = entry.samples.length;
        entry.avgQuality = entry.samples.reduce((a, s) => a + s.quality, 0) / entry.count;
      }
    }

    this._saveBaselineDB();
  }

  getStats() {
    const stats = {
      totalEvaluations: this.history.length,
      emergentCount: 0,
      marginalCount: 0,
      negativeCount: 0,
      noControlGroupCount: 0,
      avgGain: 0,
      baselineDBStats: {
        tools: Object.keys(this._baselineDB.byTool).length,
        taskTypes: Object.keys(this._baselineDB.byTaskType).length,
        toolTaskTypeCombos: Object.keys(this._baselineDB.byToolTaskType).length,
        globalBaseline: this._baselineDB.globalBaseline
      }
    };

    let gainSum = 0;
    let validCount = 0;

    for (const record of this.history) {
      switch (record.verdict) {
        case 'EMERGENT': stats.emergentCount++; break;
        case 'MARGINAL': stats.marginalCount++; break;
        case 'NEGATIVE': stats.negativeCount++; break;
        case 'NO_CONTROL_GROUP': stats.noControlGroupCount++; break;
      }

      if (record.emergenceGain !== undefined && record.verdict !== 'NO_CONTROL_GROUP') {
        gainSum += record.emergenceGain;
        validCount++;
      }
    }

    stats.avgGain = validCount > 0 ? gainSum / validCount : 0;
    return stats;
  }

  getRecentEmerged(n = 5) {
    return this.history.filter(r => r.emerged).slice(-n);
  }

  /**
   * 获取基线数据库详情
   */
  getBaselineDBReport() {
    const report = {
      globalBaseline: this._baselineDB.globalBaseline,
      toolBaselines: {},
      taskTypeBaselines: {},
      totalEntries: 0
    };

    for (const [tool, data] of Object.entries(this._baselineDB.byTool)) {
      report.toolBaselines[tool] = {
        avgQuality: Math.round(data.avgQuality * 100) / 100,
        count: data.count,
        lastUpdate: new Date(data.lastUpdate).toISOString()
      };
      report.totalEntries += data.count;
    }

    for (const [taskType, data] of Object.entries(this._baselineDB.byTaskType)) {
      report.taskTypeBaselines[taskType] = {
        avgQuality: Math.round(data.avgQuality * 100) / 100,
        count: data.count
      };
    }

    return report;
  }

  reset() {
    this.history = [];
    this.baselineQuality = null;
    this._baselineDB = {
      byTool: {},
      byTaskType: {},
      byToolTaskType: {},
      globalBaseline: null
    };
    this._saveHistory();
    this._saveBaselineDB();
  }

  _loadHistory() {
    try {
      if (fs.existsSync(this._historyPath)) {
        const data = fs.readFileSync(this._historyPath, 'utf8');
        this.history = JSON.parse(data);
      }
    } catch (e) {
      logger.warn(`[EmergenceEvaluator] 加载历史失败: ${e.message}`);
      this.history = [];
    }
  }

  async _saveHistory() {
    try {
      const dir = path.dirname(this._historyPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // 限制历史大小
      if (this.history.length > 500) {
        this.history = this.history.slice(-500);
      }
      fs.writeFileSync(this._historyPath, JSON.stringify(this.history, null, 2));
    } catch (e) {
      logger.warn(`[EmergenceEvaluator] 保存历史失败: ${e.message}`);
    }
  }

  _loadBaselineDB() {
    try {
      if (fs.existsSync(this._baselineDBPath)) {
        const data = fs.readFileSync(this._baselineDBPath, 'utf8');
        this._baselineDB = JSON.parse(data);
      }
    } catch (e) {
      logger.warn(`[EmergenceEvaluator] 加载基线数据库失败: ${e.message}`);
    }
  }

  _saveBaselineDB() {
    try {
      const dir = path.dirname(this._baselineDBPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this._baselineDBPath, JSON.stringify(this._baselineDB, null, 2));
    } catch (e) {
      logger.warn(`[EmergenceEvaluator] 保存基线数据库失败: ${e.message}`);
    }
  }
}

module.exports = EmergenceEvaluator;
