const logger = require('../utils/Logger')('AgentCapabilityTree');
const fs = require('fs');
const path = require('path');

const CAPABILITY_LEVELS = {
  L1: { name: '基础执行', dependsOn: [] },
  L2: { name: '代码生成', dependsOn: ['L1'] },
  L3: { name: '任务理解', dependsOn: ['L1', 'L2'] },
  L4: { name: '跨文件组织', dependsOn: ['L1'] },
  L5: { name: '自规划', dependsOn: ['L1', 'L2', 'L3', 'L4'] },
  L6: { name: '自我评估', dependsOn: ['L1', 'L2', 'L3', 'L4', 'L5'] },
  L7: { name: '多工具协作', dependsOn: ['L6'] },
  L8: { name: '知识传承', dependsOn: ['L7'] },
  L9: { name: '环境自适应', dependsOn: ['L8'] },
  L10: { name: '跨层级整合', dependsOn: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'] }
};

class AgentCapabilityTree {
  constructor () {
    this.profiles = {};
    this._dataPath = path.join(__dirname, '..', '..', 'data', 'capability_tree.json');
    this._load();
  }

  assessLevel (toolName, executionHistory) {
    try {
      const history = executionHistory || {};
      const evidence = [];
      let level = 'L1';
      let score = 0;

      const totalExecutions = history.totalExecutions || 0;
      const successfulExecutions = history.successfulExecutions || 0;
      const taskTypeStats = history.taskTypeStats || {};
      const languages = history.languages || [];
      const qualityScore = history.qualityScore;
      const strengthAreas = history.strengthAreas || [];
      const successRate = history.successRate || 0;
      const participatedMerge = history.participatedMerge || false;

      if (totalExecutions > 0) {
        level = 'L1';
        score = 0.1;
        evidence.push(`执行次数: ${totalExecutions}`);
      }

      if (successfulExecutions > 0) {
        level = 'L2';
        score = 0.2;
        evidence.push(`成功次数: ${successfulExecutions}`);
      }

      if (taskTypeStats.architect || taskTypeStats.code_reviewer) {
        level = 'L3';
        score = 0.3;
        evidence.push('具备架构/评审能力');
      }

      if (languages.length > 1) {
        level = 'L4';
        score = 0.4;
        evidence.push(`跨语言支持: ${languages.join(', ')}`);
      }

      if (history.taskSplittingSuccess) {
        level = 'L5';
        score = 0.5;
        evidence.push('任务拆分成功');
      }

      if (qualityScore !== undefined && qualityScore !== null) {
        level = 'L6';
        score = 0.6;
        evidence.push(`质量评分: ${qualityScore}`);
      }

      if (participatedMerge) {
        level = 'L7';
        score = 0.7;
        evidence.push('参与多工具协作');
      }

      if (strengthAreas.length > 0) {
        level = 'L8';
        score = 0.8;
        evidence.push(`优势领域: ${strengthAreas.join(', ')}`);
      }

      if (successRate > 0.7) {
        level = 'L9';
        score = 0.9;
        evidence.push(`跨任务成功率: ${(successRate * 100).toFixed(1)}%`);
      }

      const allEvidence = [
        totalExecutions > 0,
        successfulExecutions > 0,
        taskTypeStats.architect || taskTypeStats.code_reviewer,
        languages.length > 1,
        history.taskSplittingSuccess,
        qualityScore !== undefined,
        participatedMerge,
        strengthAreas.length > 0,
        successRate > 0.7
      ];
      if (allEvidence.filter(Boolean).length >= 7) {
        level = 'L10';
        score = 1.0;
        evidence.push('多层级达成');
      }

      this.profiles[toolName] = { level, score, evidence };
      this._save();

      return { level, score, evidence };
    } catch (e) {
      logger.warn(`[AgentCapabilityTree] 评估失败: ${e.message}`);
      return { level: 'L1', score: 0, evidence: [] };
    }
  }

  getLevel (toolName) {
    return this.profiles[toolName] || { level: 'L1', score: 0, evidence: [] };
  }

  getAllLevels () {
    return this.profiles;
  }

  canAttempt (toolName, requiredLevel) {
    try {
      const profile = this.profiles[toolName];
      if (!profile) return false;

      const currentLevelNum = parseInt(profile.level.slice(1));
      const requiredLevelNum = parseInt(requiredLevel.slice(1));
      if (currentLevelNum < requiredLevelNum) return false;

      const requiredDepends = CAPABILITY_LEVELS[requiredLevel]?.dependsOn || [];
      for (const dep of requiredDepends) {
        const depNum = parseInt(dep.slice(1));
        if (currentLevelNum < depNum) return false;
      }

      return true;
    } catch (e) {
      logger.warn(`[AgentCapabilityTree] 依赖检查失败: ${e.message}`);
      return false;
    }
  }

  recommendModeForLevel (level) {
    try {
      const levelNum = parseInt(level.slice(1));
      if (levelNum <= 3) return 'privacy';
      if (levelNum <= 6) return 'quality';
      return 'multi-provider';
    } catch (e) {
      logger.warn(`[AgentCapabilityTree] 模式推荐失败: ${e.message}`);
      return 'quality';
    }
  }

  reset () {
    this.profiles = {};
    this._save();
  }

  _load () {
    try {
      if (fs.existsSync(this._dataPath)) {
        const data = fs.readFileSync(this._dataPath, 'utf8');
        this.profiles = JSON.parse(data);
      }
    } catch (e) {
      logger.warn(`[AgentCapabilityTree] 加载失败: ${e.message}`);
      this.profiles = {};
    }
  }

  _save () {
    try {
      const dir = path.dirname(this._dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this._dataPath, JSON.stringify(this.profiles, null, 2));
    } catch (e) {
      logger.warn(`[AgentCapabilityTree] 保存失败: ${e.message}`);
    }
  }
}

module.exports = AgentCapabilityTree;
