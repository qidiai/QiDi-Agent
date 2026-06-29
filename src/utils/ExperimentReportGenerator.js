const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ExperimentReportGenerator {
  constructor (options = {}) {
    this.reportDir = options.reportDir || './reports';
    this.maxReports = options.maxReports || 50;
    this._ensureDir(this.reportDir);
    this._indexFile = path.join(this.reportDir, 'index.json');
    this._loadIndex();
  }

  _ensureDir (dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _loadIndex () {
    if (fs.existsSync(this._indexFile)) {
      try {
        this._index = JSON.parse(fs.readFileSync(this._indexFile, 'utf-8'));
      } catch (e) {
        this._index = { reports: [], tags: {} };
      }
    } else {
      this._index = { reports: [], tags: {} };
    }
  }

  _saveIndex () {
    fs.writeFileSync(this._indexFile, JSON.stringify(this._index, null, 2), 'utf-8');
  }

  generateReport (taskSummary, options = {}) {
    const timestamp = Date.now();
    const dateStr = new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const reportId = `exp_${timestamp}`;
    const tags = this._extractTags(taskSummary);

    let report = '';

    report += '╔══════════════════════════════════════════════════════════════╗\n';
    report += '║                    实验报告                                  ║\n';
    report += '╚══════════════════════════════════════════════════════════════╝\n\n';

    report += '【基本信息】\n';
    report += '──────────────────────────────────────────────────────────────\n';
    report += `报告ID: ${reportId}\n`;
    report += `生成时间: ${dateStr}\n`;
    report += `任务描述: ${taskSummary.originalTask.substring(0, 100)}${taskSummary.originalTask.length > 100 ? '...' : ''}\n`;
    report += `状态: ${taskSummary.successRate === 100 ? '✅ 成功' : taskSummary.successRate > 50 ? '⚠️ 部分成功' : '❌ 失败'}\n`;
    report += `成功率: ${taskSummary.successRate}%\n`;
    report += `总任务数: ${taskSummary.totalTasks}\n`;
    report += `完成任务数: ${taskSummary.completedTasks}\n`;
    report += `失败任务数: ${taskSummary.failedTasks}\n`;
    report += `输出目录: ${taskSummary.outputDir}\n`;
    if (taskSummary.duration) {
      report += `执行时长: ${(taskSummary.duration / 1000).toFixed(2)}秒\n`;
    }
    report += `标签: ${tags.join(', ')}\n\n`;

    if (taskSummary.constraints) {
      report += '【全局约束】\n';
      report += '──────────────────────────────────────────────────────────────\n';
      for (const [key, value] of Object.entries(taskSummary.constraints)) {
        report += `${key}: ${value}\n`;
      }
      report += '\n';
    }

    report += '【任务详情】\n';
    report += '──────────────────────────────────────────────────────────────\n';
    for (const task of taskSummary.tasks) {
      const statusIcon = task.status === 'completed' ? '✅' : task.status === 'failed' ? '❌' : '⏳';
      const quality = task.qualityScore ? `(${task.qualityScore}分)` : '';
      report += `${statusIcon} ${task.id}: ${task.title} ${quality}\n`;
      if (task.description) {
        report += `     ${task.description.substring(0, 80)}\n`;
      }
      if (task.constraintViolations && task.constraintViolations.length > 0) {
        report += `     ⚠️  约束违规: ${task.constraintViolations.length}项\n`;
      }
    }
    report += '\n';

    if (options.fileList) {
      report += '【生成文件】\n';
      report += '──────────────────────────────────────────────────────────────\n';
      for (const file of options.fileList) {
        report += `  ${file}\n`;
      }
      report += '\n';
    }

    if (taskSummary.qualitySummary) {
      report += '【质量汇总】\n';
      report += '──────────────────────────────────────────────────────────────\n';
      report += `平均质量分: ${taskSummary.qualitySummary.avgScore || 0}分\n`;
      report += `最高质量分: ${taskSummary.qualitySummary.maxScore || 0}分\n`;
      report += `最低质量分: ${taskSummary.qualitySummary.minScore || 0}分\n`;
      if (taskSummary.qualitySummary.constraintViolations > 0) {
        report += `约束违规总数: ${taskSummary.qualitySummary.constraintViolations}项\n`;
      }
      if (taskSummary.qualitySummary.securityIssues > 0) {
        report += `安全问题总数: ${taskSummary.qualitySummary.securityIssues}项\n`;
      }
      report += '\n';
    }

    if (taskSummary.tokenStats) {
      const ts = taskSummary.tokenStats;
      report += '【Token 使用统计】\n';
      report += '──────────────────────────────────────────────────────────────\n';
      report += `总消耗: ${ts.total?.toLocaleString() || 0} tokens\n`;
      report += `  - 输入: ${ts.prompt?.toLocaleString() || 0} tokens\n`;
      report += `  - 输出: ${ts.completion?.toLocaleString() || 0} tokens\n`;
      report += `平均每次: ${ts.avgTokensPerCall || 0} tokens\n`;
      report += `总调用次数: ${ts.totalCalls || 0}次\n`;
      report += `缓存命中率: ${ts.cacheRate || 0}%\n`;
      report += '\n';
    }

    if (taskSummary.cacheStats) {
      const cs = taskSummary.cacheStats;
      report += '【缓存统计】\n';
      report += '──────────────────────────────────────────────────────────────\n';
      report += `缓存大小: ${cs.size}/${cs.maxSize}\n`;
      report += `命中次数: ${cs.hits}\n`;
      report += `未命中次数: ${cs.misses}\n`;
      report += `命中率: ${cs.hitRate || 0}%\n`;
      report += `节省 tokens: ${cs.savedTokens?.toLocaleString() || 0}\n`;
      report += '\n';
    }

    if (taskSummary.modelStats) {
      const ms = taskSummary.modelStats;
      report += '【模型选择统计】\n';
      report += '──────────────────────────────────────────────────────────────\n';
      report += `大模型调用: ${ms.largeCalls} 次\n`;
      report += `小模型调用: ${ms.smallCalls} 次\n`;
      report += `小模型比例: ${ms.smallModelRate || 0}%\n`;
      report += `节省 tokens: ${ms.savedTokens?.toLocaleString() || 0}\n`;
      report += '\n';
    }

    report += '【总结与建议】\n';
    report += '──────────────────────────────────────────────────────────────\n';
    if (taskSummary.successRate === 100) {
      report += '✓ 所有任务已成功完成\n';
      report += '✓ 代码符合全局约束要求\n';
      report += '✓ 建议进行人工验证后投入使用\n';
    } else if (taskSummary.successRate >= 50) {
      report += '⚠️ 部分任务失败，建议检查失败原因\n';
      report += '⚠️ 失败任务可能需要重新执行或人工介入\n';
      report += '💡 建议：优先处理高优先级失败任务\n';
    } else {
      report += '❌ 大部分任务失败\n';
      report += '❌ 建议重新审视任务需求和约束条件\n';
      report += '💡 建议：拆分任务，降低复杂度后重试\n';
    }

    report += '\n【上下文摘要】\n';
    report += '──────────────────────────────────────────────────────────────\n';
    report += `任务关键词: ${this._extractKeywords(taskSummary.originalTask)}\n`;
    report += `技术栈: ${taskSummary.constraints?.techStack || '未知'}\n`;
    report += `编程语言: ${taskSummary.constraints?.language || '未知'}\n`;
    report += `平台: ${taskSummary.constraints?.platform || '未知'}\n`;
    report += `主要产出: ${this._summarizeOutput(taskSummary)}\n`;
    report += `标签: ${tags.join(', ')}\n`;

    report += '\n【经验教训】\n';
    report += '──────────────────────────────────────────────────────────────\n';
    report += `${this._extractLessons(taskSummary)}\n`;

    report += '\n╔══════════════════════════════════════════════════════════════╗\n';
    report += '║                        报告结束                              ║\n';
    report += '╚══════════════════════════════════════════════════════════════╝\n';

    const reportObj = {
      id: reportId,
      timestamp,
      content: report,
      metadata: {
        originalTask: taskSummary.originalTask,
        successRate: taskSummary.successRate,
        totalTasks: taskSummary.totalTasks,
        completedTasks: taskSummary.completedTasks,
        failedTasks: taskSummary.failedTasks,
        constraints: taskSummary.constraints,
        keywords: this._extractKeywords(taskSummary.originalTask),
        tags,
        duration: taskSummary.duration || 0,
        qualityScore: taskSummary.qualitySummary?.avgScore || 0,
        tokenUsage: taskSummary.tokenStats?.total || 0
      }
    };

    this._updateIndex(reportObj);

    return reportObj;
  }

  _extractTags (taskSummary) {
    const tags = [];

    if (taskSummary.constraints?.language) {
      tags.push(taskSummary.constraints.language);
    }

    if (taskSummary.successRate === 100) {
      tags.push('成功');
    } else if (taskSummary.successRate >= 50) {
      tags.push('部分成功');
    } else {
      tags.push('失败');
    }

    const taskKeywords = this._extractKeywords(taskSummary.originalTask);
    if (taskKeywords) {
      tags.push(...taskKeywords.split(', ').slice(0, 3));
    }

    return [...new Set(tags)];
  }

  _extractKeywords (text) {
    const keywords = [];
    const patterns = [
      /(C语言|C\+\+|Python|JavaScript|Java|Go|Rust|TypeScript)/gi,
      /(控制台|Web|GUI|CLI|桌面|移动端)/gi,
      /(游戏|贪吃蛇|排序|算法|系统|应用|工具|库|框架)/gi,
      /(前端|后端|全栈|数据库|网络|多线程)/gi
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (!keywords.includes(match[0])) {
          keywords.push(match[0]);
        }
      }
    }

    return keywords.join(', ') || '无';
  }

  _summarizeOutput (taskSummary) {
    const completedTasks = taskSummary.tasks.filter(t => t.status === 'completed');
    const titles = completedTasks.map(t => t.title);

    if (titles.length <= 3) {
      return titles.join(', ');
    } else {
      return `${titles.slice(0, 3).join(', ')} 等${titles.length}项`;
    }
  }

  _extractLessons (taskSummary) {
    const lessons = [];

    if (taskSummary.successRate < 100) {
      lessons.push('- 任务拆分可能不够细，建议进一步分解复杂任务');
    }

    if (taskSummary.tokenStats && taskSummary.tokenStats.total > 10000) {
      lessons.push('- Token 消耗较高，考虑启用更激进的上下文压缩');
    }

    if (taskSummary.cacheStats && taskSummary.cacheStats.hitRate < 30) {
      lessons.push('- 缓存命中率较低，建议优化缓存策略');
    }

    if (taskSummary.constraints) {
      lessons.push(`- 约束条件：${Object.entries(taskSummary.constraints).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }

    if (lessons.length === 0) {
      lessons.push('- 任务执行顺利，无特别经验教训');
    }

    return lessons.join('\n');
  }

  _updateIndex (report) {
    const indexEntry = {
      id: report.id,
      timestamp: report.metadata.timestamp || report.timestamp,
      task: report.metadata.originalTask?.substring(0, 100) || '',
      successRate: report.metadata.successRate || 0,
      tags: report.metadata.tags || [],
      qualityScore: report.metadata.qualityScore || 0,
      duration: report.metadata.duration || 0,
      tokenUsage: report.metadata.tokenUsage || 0
    };

    this._index.reports.unshift(indexEntry);

    for (const tag of report.metadata.tags || []) {
      if (!this._index.tags[tag]) {
        this._index.tags[tag] = 0;
      }
      this._index.tags[tag]++;
    }

    if (this._index.reports.length > this.maxReports) {
      const oldReports = this._index.reports.slice(this.maxReports);
      for (const old of oldReports) {
        this.deleteReport(old.id);
      }
      this._index.reports = this._index.reports.slice(0, this.maxReports);
    }

    this._saveIndex();
  }

  saveReport (report) {
    const fileName = `${report.id}.md`;
    const filePath = path.join(this.reportDir, fileName);

    fs.writeFileSync(filePath, report.content, 'utf-8');

    const metaFile = `${report.id}_meta.json`;
    const metaPath = path.join(this.reportDir, metaFile);
    fs.writeFileSync(metaPath, JSON.stringify(report.metadata, null, 2), 'utf-8');

    return filePath;
  }

  loadReport (reportId) {
    const fileName = `${reportId}.md`;
    const filePath = path.join(this.reportDir, fileName);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    const metaFile = `${reportId}_meta.json`;
    const metaPath = path.join(this.reportDir, metaFile);
    let metadata = {};

    if (fs.existsSync(metaPath)) {
      metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    }

    return {
      id: reportId,
      content,
      metadata
    };
  }

  listReports (options = {}) {
    try {
      let reports = this._index.reports || [];

      if (options.tag) {
        reports = reports.filter(r => r.tags?.includes(options.tag));
      }

      if (options.minSuccessRate !== undefined) {
        reports = reports.filter(r => r.successRate >= options.minSuccessRate);
      }

      if (options.limit) {
        reports = reports.slice(0, options.limit);
      }

      return reports;
    } catch (e) {
      return [];
    }
  }

  searchReports (query) {
    const reports = this.listReports();
    const queryLower = query.toLowerCase();

    return reports.filter(r => {
      const taskMatch = r.task?.toLowerCase().includes(queryLower);
      const tagMatch = r.tags?.some(k => k.toLowerCase().includes(queryLower));
      return taskMatch || tagMatch;
    });
  }

  getTags () {
    return Object.entries(this._index.tags || {})
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  }

  getRecentReports (count = 5) {
    return this.listReports({ limit: count });
  }

  getContextSummary (reportIds = []) {
    let summary = '';

    for (const id of reportIds) {
      const report = this.loadReport(id);
      if (report) {
        summary += `\n【报告 ${id}】\n`;
        summary += `任务: ${report.metadata.originalTask?.substring(0, 80) || '未知'}\n`;
        summary += `结果: ${report.metadata.successRate}% 成功 (${report.metadata.totalTasks}个任务)\n`;
        summary += `技术栈: ${report.metadata.constraints?.techStack || '未知'}\n`;
        summary += `语言: ${report.metadata.constraints?.language || '未知'}\n`;
        summary += `关键词: ${report.metadata.keywords || '无'}\n`;
        summary += `标签: ${(report.metadata.tags || []).join(', ')}\n`;
      }
    }

    return summary || '无历史报告';
  }

  getContextForNewTask (taskDescription, options = {}) {
    const count = options.count || 3;
    const reports = this.listReports({ limit: count * 2 });

    const keywords = this._extractKeywords(taskDescription).toLowerCase().split(', ');

    const scored = reports.map(r => {
      let score = 0;
      const taskLower = r.task?.toLowerCase() || '';
      const tagsLower = (r.tags || []).join(' ').toLowerCase();

      for (const kw of keywords) {
        if (taskLower.includes(kw)) score += 2;
        if (tagsLower.includes(kw)) score += 1;
      }

      return { ...r, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const topReports = scored.slice(0, count);

    return this.getContextSummary(topReports.map(r => r.id));
  }

  compareReports (reportIds) {
    const reports = reportIds.map(id => this.loadReport(id)).filter(Boolean);

    if (reports.length < 2) {
      return { error: '至少需要2个报告进行对比' };
    }

    const comparison = {
      reports: reports.map(r => ({
        id: r.id,
        task: r.metadata.originalTask?.substring(0, 50),
        successRate: r.metadata.successRate,
        qualityScore: r.metadata.qualityScore || 0,
        duration: r.metadata.duration || 0,
        tokenUsage: r.metadata.tokenUsage || 0
      })),
      summary: {
        avgSuccessRate: Math.round(reports.reduce((s, r) => s + (r.metadata.successRate || 0), 0) / reports.length),
        avgQuality: Math.round(reports.reduce((s, r) => s + (r.metadata.qualityScore || 0), 0) / reports.length),
        totalTokens: reports.reduce((s, r) => s + (r.metadata.tokenUsage || 0), 0)
      }
    };

    return comparison;
  }

  deleteReport (reportId) {
    const fileName = `${reportId}.md`;
    const filePath = path.join(this.reportDir, fileName);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    const metaFile = `${reportId}_meta.json`;
    const metaPath = path.join(this.reportDir, metaFile);

    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
    }

    this._index.reports = this._index.reports.filter(r => r.id !== reportId);
    this._saveIndex();

    return true;
  }

  clearAllReports () {
    const files = fs.readdirSync(this.reportDir);
    for (const file of files) {
      if (file.startsWith('exp_')) {
        fs.unlinkSync(path.join(this.reportDir, file));
      }
    }
    this._index = { reports: [], tags: {} };
    this._saveIndex();
    return true;
  }

  exportReport (reportId, format = 'json') {
    const report = this.loadReport(reportId);
    if (!report) return null;

    if (format === 'json') {
      return JSON.stringify(report, null, 2);
    }

    return report.content;
  }

  getStats () {
    const reports = this._index.reports || [];

    if (reports.length === 0) {
      return {
        totalReports: 0,
        avgSuccessRate: 0,
        totalTokens: 0,
        tags: {}
      };
    }

    return {
      totalReports: reports.length,
      avgSuccessRate: Math.round(reports.reduce((s, r) => s + (r.successRate || 0), 0) / reports.length),
      avgQuality: Math.round(reports.reduce((s, r) => s + (r.qualityScore || 0), 0) / reports.length),
      totalTokens: reports.reduce((s, r) => s + (r.tokenUsage || 0), 0),
      totalDuration: reports.reduce((s, r) => s + (r.duration || 0), 0),
      successfulCount: reports.filter(r => r.successRate === 100).length,
      tags: this._index.tags || {}
    };
  }

  generateAndSave (taskSummary, options = {}) {
    const report = this.generateReport(taskSummary, options);
    const filePath = this.saveReport(report);

    return {
      report,
      filePath
    };
  }
}

module.exports = ExperimentReportGenerator;
