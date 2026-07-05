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
  constructor (options = {}) {
    this.threshold = options.threshold || 0.2;
    this.baselineQuality = options.baselineQuality || null;
    this.history = options.history || [];
    this._historyPath = path.join(__dirname, '..', '..', 'data', 'emergence_history.json');

    // 基线数据库
    this._baselineDBPath = path.join(__dirname, '..', '..', 'data', 'baseline_db.json');
    this._baselineDB = {
      byTool: {}, // toolName -> { avgQuality, count, lastUpdate, samples: [] }
      byTaskType: {}, // taskType -> { avgQuality, count, samples: [] }
      byToolTaskType: {}, // "tool:taskType" -> { avgQuality, count, samples: [] }
      globalBaseline: null // 全局基线均值
    };

    this._loadHistory();
    this._loadBaselineDB();
  }

  /**
   * 评估涌现效应
   * @param {Object} params - { multiToolQuality, singleToolQuality, synchrony, mode, tools, taskType, taskDescription }
   * @param {Object} options - { allowEstimated: 是否允许估算基线（默认 true） }
   */
  async evaluate ({ multiToolQuality, singleToolQuality, synchrony, mode, tools, taskType, taskDescription }, options = {}) {
    try {
      const allowEstimated = options.allowEstimated !== false;

      // 尝试获取基线
      let baseline = singleToolQuality;
      let baselineSource = 'explicit';

      if (baseline === undefined || baseline === null) {
        // 从基线数据库获取
        const dbResult = this._getBaselineFromDB(tools, taskType);
        baseline = dbResult.quality;
        baselineSource = dbResult.source;
      }

      // 数据库也没基线 → 尝试估算
      if ((baseline === null || baseline === undefined) && allowEstimated) {
        const estimated = this._estimateBaseline(tools, taskType);
        if (estimated !== null) {
          baseline = estimated;
          baselineSource = 'estimated';
          logger.info(`[EmergenceEvaluator] 使用估算基线: ${baseline.toFixed(3)}（基于历史数据估算）`);
        }
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
          controlGroup: null,
          baselineSource: 'none'
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
        verdict = baselineSource === 'estimated' ? 'EMERGENT_ESTIMATED' : 'EMERGENT';
      } else if (emergenceGain > 0) {
        verdict = baselineSource === 'estimated' ? 'MARGINAL_ESTIMATED' : 'MARGINAL';
      } else {
        verdict = baselineSource === 'estimated' ? 'NEGATIVE_ESTIMATED' : 'NEGATIVE';
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
   * 估算基线（当无显式基线且数据库无记录时）
   * 策略：全局历史均值的 90%（保守估计，避免假涌现）
   */
  _estimateBaseline (tools, taskType) {
    // 收集所有历史质量数据
    const validRecords = this.history.filter(r =>
      r.verdict !== 'NO_CONTROL_GROUP' &&
      r.verdict !== 'ERROR' &&
      typeof r.multiToolQuality === 'number'
    );

    if (validRecords.length === 0) return null;

    // 同任务类型的历史均值
    if (taskType) {
      const sameType = validRecords.filter(r => r.taskType === taskType);
      if (sameType.length >= 3) {
        const avg = sameType.reduce((s, r) => s + r.multiToolQuality, 0) / sameType.length;
        return avg * 0.9; // 保守估计
      }
    }

    // 全局历史均值的 90%
    const avg = validRecords.reduce((s, r) => s + r.multiToolQuality, 0) / validRecords.length;
    return avg * 0.9;
  }

  /**
   * 强制获取基线（主动跑一次单工具执行作为基线）
   * @param {Function} singleToolRunner - async (tool) => quality 的函数
   * @param {string} toolName - 单工具名
   * @param {string} taskType - 任务类型
   */
  async ensureBaseline (singleToolRunner, toolName, taskType) {
    // 检查数据库中是否已有该 tool+taskType 的基线
    if (toolName && taskType) {
      const key = `${toolName}:${taskType}`;
      const existing = this._baselineDB.byToolTaskType[key];
      if (existing && existing.count >= 3) {
        logger.info(`[EmergenceEvaluator] 基线已存在: ${toolName}+${taskType} (${existing.count} 条记录)`);
        return { success: true, quality: existing.avgQuality, source: 'cached' };
      }
    }

    // 主动跑一次单工具执行
    if (typeof singleToolRunner === 'function') {
      try {
        logger.info(`[EmergenceEvaluator] 主动获取基线: ${toolName} + ${taskType}`);
        const quality = await singleToolRunner(toolName);
        if (typeof quality === 'number' && quality > 0) {
          this.recordBaseline(quality, toolName, taskType);
          return { success: true, quality, source: 'fresh' };
        }
        return { success: false, error: 'invalid quality', source: 'none' };
      } catch (e) {
        logger.warn(`[EmergenceEvaluator] 主动基线获取失败: ${e.message}`);
        return { success: false, error: e.message, source: 'none' };
      }
    }

    return { success: false, error: 'no runner provided', source: 'none' };
  }

  /**
   * 预热基线数据库（系统启动时调用，异步）
   * @param {Array} tools - [{ name, taskType }]
   * @param {Function} singleToolRunner - async (tool) => quality
   */
  async preWarmBaseline (tools, singleToolRunner) {
    if (!Array.isArray(tools) || tools.length === 0) return;

    // 只为缺基线的组合预热
    const needWarm = tools.filter(({ name, taskType }) => {
      const key = `${name}:${taskType}`;
      const existing = this._baselineDB.byToolTaskType[key];
      return !existing || existing.count < 3;
    });

    if (needWarm.length === 0) {
      logger.info('[EmergenceEvaluator] 基线数据库已完整，无需预热');
      return;
    }

    logger.info(`[EmergenceEvaluator] 开始预热 ${needWarm.length} 个基线组合`);
    for (const { name, taskType } of needWarm) {
      try {
        await this.ensureBaseline(singleToolRunner, name, taskType);
      } catch (e) {
        // 静默失败，继续下一个
      }
    }
    logger.info('[EmergenceEvaluator] 基线预热完成');
  }

  /**
   * 记录单工具基线
   * @param {number} quality - 单工具质量评分
   * @param {string} toolName - 工具名
   * @param {string} taskType - 任务类型
   */
  recordBaseline (quality, toolName = null, taskType = null) {
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
  _getBaselineFromDB (tools, taskType) {
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
  _recordToBaselineDB (tools, taskType, quality, mode) {
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

  getStats () {
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

  getRecentEmerged (n = 5) {
    return this.history.filter(r => r.emerged).slice(-n);
  }

  /**
   * 获取基线数据库详情
   */
  getBaselineDBReport () {
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

  reset () {
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

  _loadHistory () {
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

  async _saveHistory () {
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

  _loadBaselineDB () {
    try {
      if (fs.existsSync(this._baselineDBPath)) {
        const data = fs.readFileSync(this._baselineDBPath, 'utf8');
        this._baselineDB = JSON.parse(data);
      }
    } catch (e) {
      logger.warn(`[EmergenceEvaluator] 加载基线数据库失败: ${e.message}`);
    }
  }

  _saveBaselineDB () {
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
