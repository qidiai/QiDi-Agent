const logger = require('../utils/Logger')('EmergenceAudit');
const fs = require('fs');
const path = require('path');

class EmergenceAudit {
  constructor () {
    this.auditLog = [];
    this._logPath = path.join(__dirname, '..', '..', 'data', 'emergence_audit.json');
    this._load();
  }

  record ({ taskId, mode, synchrony, emergenceGain, verdict, controlGroup, tools, timestamp }) {
    try {
      const flag = controlGroup === null || controlGroup === undefined
        ? 'MISSING_BASELINE'
        : 'OK';

      const record = {
        taskId: taskId || `task_${Date.now()}`,
        mode,
        synchrony,
        emergenceGain,
        verdict,
        controlGroup,
        tools: tools || [],
        timestamp: timestamp || Date.now(),
        flag
      };

      this.auditLog.push(record);
      this._save();

      logger.info(`[EmergenceAudit] 记录: taskId=${record.taskId}, verdict=${verdict}, flag=${flag}`);
      return record;
    } catch (e) {
      logger.warn(`[EmergenceAudit] 记录失败: ${e.message}`);
      return null;
    }
  }

  generateReport () {
    try {
      const stats = {
        total: this.auditLog.length,
        emergent: 0,
        marginal: 0,
        negative: 0,
        noControlGroup: 0
      };

      for (const record of this.auditLog) {
        switch (record.verdict) {
        case 'EMERGENT':
          stats.emergent++;
          break;
        case 'MARGINAL':
          stats.marginal++;
          break;
        case 'NEGATIVE':
          stats.negative++;
          break;
        case 'NO_CONTROL_GROUP':
          stats.noControlGroup++;
          break;
        }
      }

      let credibility = '低';
      if (stats.emergent > 0 && stats.noControlGroup === 0) {
        credibility = '高';
      } else if (stats.total > 0 && stats.noControlGroup < stats.total / 2) {
        credibility = '中';
      }

      const recent = this.auditLog.slice(-10).reverse();
      let table = '';
      for (const record of recent) {
        const timeStr = new Date(record.timestamp).toLocaleString('zh-CN');
        table += `| ${record.taskId.slice(-8)} | ${record.mode || '-'} | ${record.verdict} | ${record.emergenceGain?.toFixed(2) || '-'} | ${record.flag} | ${timeStr} |\n`;
      }

      const contradictions = this._detectContradictions();
      let contradictionSection = '';
      if (contradictions.length > 0) {
        contradictionSection = '\n\n### ⚠ 矛盾点检测\n\n';
        contradictionSection += contradictions.slice(0, 5).map(c => `- ${c}`).join('\n');
      }

      const report = '## 涌现审计报告\n\n' +
        '### 统计概览\n\n' +
        '| 指标 | 数量 |\n' +
        '|------|------|\n' +
        `| 总评估次数 | ${stats.total} |\n` +
        `| EMERGENT | ${stats.emergent} |\n` +
        `| MARGINAL | ${stats.marginal} |\n` +
        `| NEGATIVE | ${stats.negative} |\n` +
        `| NO_CONTROL_GROUP | ${stats.noControlGroup} |\n` +
        `| 可信度等级 | ${credibility} |\n\n` +
        '### 最近10条记录\n\n' +
        '| 任务ID | 模式 | 结论 | 增益 | 状态 | 时间 |\n' +
        '|--------|------|------|------|------|------|\n' +
        table +
        contradictionSection;

      return report;
    } catch (e) {
      logger.warn(`[EmergenceAudit] 生成报告失败: ${e.message}`);
      return `## 涌现审计报告\n\n⚠ 报告生成失败: ${e.message}`;
    }
  }

  getRedFlags () {
    return this.auditLog.filter(record => record.flag !== 'OK');
  }

  reset () {
    this.auditLog = [];
    this._save();
  }

  _detectContradictions () {
    const taskResults = {};
    const contradictions = [];

    for (const record of this.auditLog) {
      if (!taskResults[record.taskId]) {
        taskResults[record.taskId] = [];
      }
      taskResults[record.taskId].push(record);
    }

    for (const [taskId, records] of Object.entries(taskResults)) {
      if (records.length < 2) continue;

      const gains = records.filter(r => r.emergenceGain !== undefined && r.verdict !== 'NO_CONTROL_GROUP');
      if (gains.length < 2) continue;

      const hasPositive = gains.some(g => g.emergenceGain > 0);
      const hasNegative = gains.some(g => g.emergenceGain < 0);

      if (hasPositive && hasNegative) {
        contradictions.push(`任务 ${taskId}: 增益符号不一致 (${gains.map(g => g.emergenceGain.toFixed(2)).join(', ')})`);
      }
    }

    return contradictions;
  }

  _load () {
    try {
      if (fs.existsSync(this._logPath)) {
        const data = fs.readFileSync(this._logPath, 'utf8');
        this.auditLog = JSON.parse(data);
      }
    } catch (e) {
      logger.warn(`[EmergenceAudit] 加载日志失败: ${e.message}`);
      this.auditLog = [];
    }
  }

  _save () {
    try {
      const dir = path.dirname(this._logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this._logPath, JSON.stringify(this.auditLog, null, 2));
    } catch (e) {
      logger.warn(`[EmergenceAudit] 保存日志失败: ${e.message}`);
    }
  }
}

module.exports = EmergenceAudit;
