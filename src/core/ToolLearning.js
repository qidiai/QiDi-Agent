const fs = require('fs');
const path = require('path');
const createLogger = require('../utils/Logger');

const logger = createLogger('ToolLearning');

/**
 * 工具学习模块 - 记录每个工具的执行效果，持续优化任务分配
 *
 * 核心功能：
 * 1. 记录每次任务执行的结果（成功/失败、质量评分、耗时）
 * 2. 分析每个工具擅长处理的任务类型
 * 3. 提供基于历史的学习建议，优化 TaskRouter 的 capability 匹配
 */
class ToolLearning {
  constructor (options = {}) {
    this.learningDir = options.learningDir || './config/tool_learning';
    this.dataFile = path.join(this.learningDir, 'history.json');
    this.minSamples = options.minSamples || 3;
    this.maxHistory = options.maxHistory || 500;

    this.history = [];
    this.toolProfiles = {};
    this.taskTypeProfiles = {};

    this._load();
  }

  _load () {
    try {
      if (fs.existsSync(this.dataFile)) {
        const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
        this.history = data.history || [];
        this.toolProfiles = data.toolProfiles || {};
        this.taskTypeProfiles = data.taskTypeProfiles || {};
        logger.info(`已加载 ${this.history.length} 条工具学习记录`);
      }
    } catch (e) {
      logger.warn(`加载工具学习数据失败: ${e.message}，将重新开始`);
      this.history = [];
      this.toolProfiles = {};
      this.taskTypeProfiles = {};
    }
  }

  _save () {
    try {
      if (!fs.existsSync(this.learningDir)) {
        fs.mkdirSync(this.learningDir, { recursive: true });
      }
      const data = {
        history: this.history.slice(-this.maxHistory),
        toolProfiles: this.toolProfiles,
        taskTypeProfiles: this.taskTypeProfiles,
        updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      logger.error(`保存工具学习数据失败: ${e.message}`);
    }
  }

  /**
   * 记录一次工具执行结果
   * @param {string} toolName - 工具名称
   * @param {object} taskInfo - 任务信息 { type, language, complexity, frameworks, role }
   * @param {object} result - 执行结果 { success, qualityScore, duration, error }
   */
  recordExecution (toolName, taskInfo, result) {
    const entry = {
      id: `exec_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      timestamp: new Date().toISOString(),
      toolName,
      taskType: taskInfo.type || 'general',
      language: taskInfo.language || 'unknown',
      complexity: taskInfo.complexity || 'medium',
      frameworks: taskInfo.frameworks || [],
      role: taskInfo.role || 'code_writer',
      success: result.success,
      qualityScore: result.qualityScore || 0,
      duration: result.duration || 0,
      error: result.error || null
    };

    this.history.push(entry);
    this._updateToolProfile(toolName, entry);
    this._updateTaskTypeProfile(entry);
    this._save();

    logger.info(`记录执行: ${toolName} | ${taskInfo.type} | ${result.success ? '成功' : '失败'} | 质量:${result.qualityScore || 'N/A'}`);
    return entry;
  }

  _updateToolProfile (toolName, entry) {
    if (!this.toolProfiles[toolName]) {
      this.toolProfiles[toolName] = {
        name: toolName,
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        totalQualityScore: 0,
        avgQualityScore: 0,
        totalDuration: 0,
        avgDuration: 0,
        languageStats: {},
        taskTypeStats: {},
        complexityStats: {},
        roleStats: {},
        strengthAreas: [],
        weaknessAreas: [],
        lastUpdated: null
      };
    }

    const profile = this.toolProfiles[toolName];
    profile.totalExecutions++;
    profile.lastUpdated = entry.timestamp;

    if (entry.success) {
      profile.successfulExecutions++;
      profile.totalQualityScore += entry.qualityScore;
      profile.avgQualityScore = profile.totalQualityScore / profile.successfulExecutions;
    } else {
      profile.failedExecutions++;
    }

    if (entry.duration > 0) {
      profile.totalDuration += entry.duration;
      profile.avgDuration = profile.totalDuration / profile.totalExecutions;
    }

    this._updateLanguageStats(profile, entry);
    this._updateTaskTypeStats(profile, entry);
    this._updateComplexityStats(profile, entry);
    this._updateRoleStats(profile, entry);
    this._analyzeStrengthWeakness(profile);
  }

  _updateLanguageStats (profile, entry) {
    const lang = entry.language;
    if (!profile.languageStats[lang]) {
      profile.languageStats[lang] = { attempts: 0, successes: 0, avgQuality: 0, totalQuality: 0 };
    }
    const stats = profile.languageStats[lang];
    stats.attempts++;
    if (entry.success) {
      stats.successes++;
      stats.totalQuality += entry.qualityScore;
      stats.avgQuality = stats.totalQuality / stats.successes;
    }
  }

  _updateTaskTypeStats (profile, entry) {
    const type = entry.taskType;
    if (!profile.taskTypeStats[type]) {
      profile.taskTypeStats[type] = { attempts: 0, successes: 0, avgQuality: 0, totalQuality: 0 };
    }
    const stats = profile.taskTypeStats[type];
    stats.attempts++;
    if (entry.success) {
      stats.successes++;
      stats.totalQuality += entry.qualityScore;
      stats.avgQuality = stats.totalQuality / stats.successes;
    }
  }

  _updateComplexityStats (profile, entry) {
    const complexity = entry.complexity;
    if (!profile.complexityStats[complexity]) {
      profile.complexityStats[complexity] = { attempts: 0, successes: 0, avgQuality: 0, totalQuality: 0 };
    }
    const stats = profile.complexityStats[complexity];
    stats.attempts++;
    if (entry.success) {
      stats.successes++;
      stats.totalQuality += entry.qualityScore;
      stats.avgQuality = stats.totalQuality / stats.successes;
    }
  }

  _updateRoleStats (profile, entry) {
    const role = entry.role;
    if (!profile.roleStats[role]) {
      profile.roleStats[role] = { attempts: 0, successes: 0, avgQuality: 0, totalQuality: 0 };
    }
    const stats = profile.roleStats[role];
    stats.attempts++;
    if (entry.success) {
      stats.successes++;
      stats.totalQuality += entry.qualityScore;
      stats.avgQuality = stats.totalQuality / stats.successes;
    }
  }

  _analyzeStrengthWeakness (profile) {
    const languageScores = [];
    for (const [lang, stats] of Object.entries(profile.languageStats)) {
      if (stats.attempts >= this.minSamples) {
        const successRate = stats.successes / stats.attempts;
        languageScores.push({ language: lang, score: successRate * 0.6 + (stats.avgQuality / 100) * 0.4 });
      }
    }

    const taskTypeScores = [];
    for (const [type, stats] of Object.entries(profile.taskTypeStats)) {
      if (stats.attempts >= this.minSamples) {
        const successRate = stats.successes / stats.attempts;
        taskTypeScores.push({ taskType: type, score: successRate * 0.6 + (stats.avgQuality / 100) * 0.4 });
      }
    }

    languageScores.sort((a, b) => b.score - a.score);
    taskTypeScores.sort((a, b) => b.score - a.score);

    profile.strengthAreas = languageScores.slice(0, 3).map(s => s.language);
    profile.weaknessAreas = languageScores.slice(-2).map(s => s.language);

    profile.bestTaskTypes = taskTypeScores.slice(0, 3).map(s => s.taskType);
    profile.worstTaskTypes = taskTypeScores.slice(-2).map(s => s.taskType);
  }

  _updateTaskTypeProfile (entry) {
    const key = `${entry.taskType}_${entry.language}`;
    if (!this.taskTypeProfiles[key]) {
      this.taskTypeProfiles[key] = {
        taskType: entry.taskType,
        language: entry.language,
        totalAttempts: 0,
        toolPerformance: {}
      };
    }

    const profile = this.taskTypeProfiles[key];
    profile.totalAttempts++;

    if (!profile.toolPerformance[entry.toolName]) {
      profile.toolPerformance[entry.toolName] = { attempts: 0, successes: 0, totalQuality: 0, avgQuality: 0 };
    }

    const toolPerf = profile.toolPerformance[entry.toolName];
    toolPerf.attempts++;
    if (entry.success) {
      toolPerf.successes++;
      toolPerf.totalQuality += entry.qualityScore;
      toolPerf.avgQuality = toolPerf.totalQuality / toolPerf.successes;
    }
  }

  /**
   * 获取工具能力推荐分数
   * @param {string} toolName - 工具名称
   * @param {object} taskInfo - 任务信息
   * @returns {number} 推荐分数 (-10 到 +10)
   */
  getToolRecommendation (toolName, taskInfo) {
    const profile = this.toolProfiles[toolName];
    if (!profile || profile.totalExecutions < this.minSamples) {
      return 0;
    }

    let bonus = 0;

    if (taskInfo.language && profile.languageStats[taskInfo.language]) {
      const langStats = profile.languageStats[taskInfo.language];
      if (langStats.attempts >= this.minSamples) {
        const successRate = langStats.successes / langStats.attempts;
        const qualityBonus = (langStats.avgQuality - 70) / 10;
        bonus += successRate * 5 + qualityBonus;
      }
    }

    if (taskInfo.taskType && profile.taskTypeStats[taskInfo.taskType]) {
      const typeStats = profile.taskTypeStats[taskInfo.taskType];
      if (typeStats.attempts >= this.minSamples) {
        const successRate = typeStats.successes / typeStats.attempts;
        bonus += successRate * 3;
      }
    }

    if (taskInfo.complexity && profile.complexityStats[taskInfo.complexity]) {
      const compStats = profile.complexityStats[taskInfo.complexity];
      if (compStats.attempts >= this.minSamples) {
        const successRate = compStats.successes / compStats.attempts;
        bonus += successRate * 2;
      }
    }

    return Math.max(-10, Math.min(10, bonus));
  }

  /**
   * 获取最佳工具推荐
   * @param {object} taskInfo - 任务信息
   * @param {string[]} availableTools - 可用工具列表
   * @returns {{ tool: string, score: number, reasons: string[] }}
   */
  recommendBestTool (taskInfo, availableTools) {
    const recommendations = [];

    for (const toolName of availableTools) {
      const bonus = this.getToolRecommendation(toolName, taskInfo);
      const profile = this.toolProfiles[toolName];
      const reasons = [];

      if (profile) {
        if (taskInfo.language && profile.strengthAreas.includes(taskInfo.language)) {
          reasons.push(`擅长 ${taskInfo.language}`);
        }
        if (taskInfo.taskType && profile.bestTaskTypes?.includes(taskInfo.taskType)) {
          reasons.push(`擅长 ${taskInfo.taskType} 任务`);
        }
        if (profile.avgQualityScore > 80) {
          reasons.push(`平均质量 ${profile.avgQualityScore.toFixed(0)}`);
        }
        if (profile.successfulExecutions / profile.totalExecutions > 0.9) {
          reasons.push(`成功率 ${((profile.successfulExecutions / profile.totalExecutions) * 100).toFixed(0)}%`);
        }
      }

      recommendations.push({ tool: toolName, score: bonus, reasons });
    }

    recommendations.sort((a, b) => b.score - a.score);
    return recommendations[0] || null;
  }

  /**
   * 获取工具画像
   */
  getToolProfile (toolName) {
    return this.toolProfiles[toolName] || null;
  }

  /**
   * 获取所有工具画像摘要
   */
  getAllToolProfiles () {
    return Object.values(this.toolProfiles).map(p => ({
      name: p.name,
      totalExecutions: p.totalExecutions,
      successRate: p.totalExecutions > 0
        ? ((p.successfulExecutions / p.totalExecutions) * 100).toFixed(1) + '%'
        : 'N/A',
      avgQuality: p.avgQualityScore > 0 ? p.avgQualityScore.toFixed(1) : 'N/A',
      strengthAreas: p.strengthAreas,
      bestTaskTypes: p.bestTaskTypes
    }));
  }

  /**
   * 获取学习统计
   */
  getLearningStats () {
    return {
      totalRecords: this.history.length,
      toolCount: Object.keys(this.toolProfiles).length,
      taskTypeCount: Object.keys(this.taskTypeProfiles).length,
      avgExecutionTime: this.history.length > 0
        ? (this.history.reduce((sum, e) => sum + (e.duration || 0), 0) / this.history.length).toFixed(0) + 'ms'
        : 'N/A'
    };
  }

  /**
   * 重置学习数据
   */
  reset () {
    this.history = [];
    this.toolProfiles = {};
    this.taskTypeProfiles = {};
    this._save();
    logger.info('工具学习数据已重置');
    return { success: true };
  }

  /**
   * 导出学习数据
   */
  export () {
    return {
      history: this.history,
      toolProfiles: this.toolProfiles,
      taskTypeProfiles: this.taskTypeProfiles,
      exportedAt: new Date().toISOString()
    };
  }

  /**
   * 从导出数据导入
   */
  import (data) {
    if (data.history) this.history = data.history.slice(-this.maxHistory);
    if (data.toolProfiles) this.toolProfiles = data.toolProfiles;
    if (data.taskTypeProfiles) this.taskTypeProfiles = data.taskTypeProfiles;
    this._save();
    logger.info(`已导入 ${this.history.length} 条学习记录`);
    return { success: true };
  }
}

module.exports = ToolLearning;
