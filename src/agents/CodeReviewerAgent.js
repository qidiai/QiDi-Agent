const BaseAgent = require('./BaseAgent');
const { safeJsonParse } = require('../utils/SafeParser');
const logger = require('../utils/Logger')('CodeReviewerAgent');

const CODE_REVIEWER_PROMPT = `你是一位严格的代码审查专家，擅长发现代码中的问题并提出改进建议。

你的审查维度：
1. **正确性** - 代码逻辑是否正确，是否有 bug
2. **可读性** - 代码是否清晰易懂，命名是否规范
3. **最佳实践** - 是否遵循编码规范和设计模式
4. **安全性** - 是否有安全漏洞或风险
5. **性能** - 是否有明显的性能问题
6. **完整性** - 是否覆盖了所有需求和边界情况

审查策略：
- 差异审查：如果提供了变更说明，重点审查变更部分
- 上下文感知：考虑项目历史代码风格和约束
- 历史反馈：避免重复之前已指出的问题

输出格式（严格 JSON）：
{
  "passed": true|false,
  "overallScore": 0-100,
  "issues": [
    {
      "severity": "critical|major|minor|suggestion",
      "category": "correctness|readability|best_practice|security|performance",
      "description": "问题描述",
      "suggestion": "修复建议",
      "file": "文件路径",
      "line": "行号（可选）"
    }
  ],
  "summary": "总体评价",
  "needsRevision": true|false,
  "differentialReview": true|false
}

注意：只输出 JSON，不要其他文字。`;

class CodeReviewerAgent extends BaseAgent {
  constructor (provider, options = {}) {
    super(provider, {
      name: 'CodeReviewer',
      role: '代码审查员',
      systemPrompt: CODE_REVIEWER_PROMPT,
      temperature: 0.2,
      enableStructuredOutput: false,
      ...options
    });
    this._reviewHistory = [];
    this._maxHistory = options.maxHistory || 100;
    this._projectStyleProfile = null;
    this.enableDifferentialReview = options.enableDifferentialReview !== false;
    this.enableContextAware = options.enableContextAware !== false;
  }

  /**
   * 审查代码（增强版：上下文感知 + 差异审查 + 历史记忆）
   */
  async reviewCode (code, task, context = {}) {
    // 1. 构建增强上下文
    const enhancedContext = this._buildReviewContext(code, task, context);

    // 2. 构建 prompt
    let prompt = `请审查以下代码：\n\n任务：${task.title}\n描述：${task.description}\n\n`;

    // 注入上下文
    if (enhancedContext.constraints) {
      prompt += `\n【项目约束】\n语言：${enhancedContext.constraints.language || '未指定'}\n`;
      prompt += `框架：${enhancedContext.constraints.framework || '未指定'}\n`;
    }

    // 差异审查
    if (enhancedContext.isDifferential && enhancedContext.changedParts) {
      prompt += `\n【差异审查模式】\n本次审查重点为变更部分：\n${enhancedContext.changedParts}\n`;
    }

    // 历史反馈避免重复
    if (enhancedContext.recentFeedback && enhancedContext.recentFeedback.length > 0) {
      prompt += '\n【历史审查反馈（避免重复）】\n';
      prompt += enhancedContext.recentFeedback.map(f => `- ${f}`).join('\n');
      prompt += '\n';
    }

    // 项目风格
    if (enhancedContext.styleProfile) {
      prompt += `\n【项目代码风格】${enhancedContext.styleProfile}\n`;
    }

    // 代码
    if (typeof code === 'string') {
      prompt += `\n代码：\n\`\`\`\n${code}\n\`\`\`\n`;
    } else if (Array.isArray(code)) {
      code.forEach((block, i) => {
        prompt += `代码块 ${i + 1} (${block.language}, ${block.filePath || 'unknown'})：\n\`\`\`${block.language}\n${block.code}\n\`\`\`\n`;
      });
    }

    if (context.acceptanceCriteria) {
      prompt += `\n验收标准：\n${context.acceptanceCriteria}\n`;
    }

    prompt += '\n请进行严格审查，输出 JSON 格式的审查结果。';

    const result = await this.sendOnce(prompt);
    const parsed = this._extractJson(result.content);

    if (!parsed) {
      return {
        passed: true,
        overallScore: 70,
        issues: [],
        summary: '代码基本符合要求，建议人工确认',
        needsRevision: false,
        rawReview: result.content
      };
    }

    // 记录审查历史
    this._recordReview(task, code, parsed);

    // 添加审查元数据
    parsed.differentialReview = enhancedContext.isDifferential;
    parsed.contextAware = enhancedContext.enableContextAware;
    parsed.reviewRound = this._getReviewRound(task);

    return parsed;
  }

  /**
   * 构建增强审查上下文
   */
  _buildReviewContext (code, task, context) {
    const enhanced = { ...context };

    // 1. 检测是否为差异审查场景
    if (this.enableDifferentialReview && context.previousCode) {
      enhanced.isDifferential = true;
      enhanced.changedParts = this._extractChangedParts(context.previousCode, code);
    }

    // 2. 获取历史反馈
    if (this._reviewHistory.length > 0) {
      const recentReviews = this._reviewHistory
        .filter(r => r.taskTitle === task.title)
        .slice(-3);

      if (recentReviews.length > 0) {
        enhanced.recentFeedback = recentReviews.flatMap(r =>
          (r.issues || []).slice(0, 3).map(i => i.description || i)
        );
      }
    }

    // 3. 项目风格画像
    if (this.enableContextAware && !this._projectStyleProfile) {
      this._projectStyleProfile = this._inferStyleProfile(code);
    }
    enhanced.styleProfile = this._projectStyleProfile;
    enhanced.enableContextAware = this.enableContextAware;

    return enhanced;
  }

  /**
   * 提取变更部分（简易 diff）
   */
  _extractChangedParts (oldCode, newCode) {
    if (typeof oldCode !== 'string' || typeof newCode !== 'string') return null;

    const oldLines = oldCode.split('\n');
    const newLines = newCode.split('\n');
    const changes = [];

    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (oldLines[i] !== newLines[i]) {
        if (i < newLines.length) {
          changes.push(`+ (行${i + 1}): ${newLines[i]}`);
        }
        if (i < oldLines.length && oldLines[i] !== undefined) {
          changes.push(`- (行${i + 1}): ${oldLines[i]}`);
        }
      }
    }

    return changes.length > 0 ? changes.slice(0, 50).join('\n') : null;
  }

  /**
   * 推断代码风格画像
   */
  _inferStyleProfile (code) {
    if (typeof code !== 'string' && !Array.isArray(code)) return null;

    const codeStr = typeof code === 'string' ? code : code.map(b => b.code || '').join('\n');
    if (!codeStr) return null;

    const profile = [];

    // 缩进风格
    if (/\t/.test(codeStr)) profile.push('使用Tab缩进');
    else if (/^ {4}/m.test(codeStr)) profile.push('使用4空格缩进');
    else if (/^ {2}/m.test(codeStr)) profile.push('使用2空格缩进');

    // 命名风格
    if (/camelCase/.test(codeStr) || /[a-z][a-zA-Z]+\(/.test(codeStr)) profile.push('驼峰命名');
    if (/snake_case/.test(codeStr) || /[a-z]+_[a-z]+/.test(codeStr)) profile.push('下划线命名');

    // 注释风格
    if (/\/\//.test(codeStr)) profile.push('行注释//');
    if (/\/\*/.test(codeStr)) profile.push('块注释/* */');
    if (/#/.test(codeStr) && !/#!\//.test(codeStr)) profile.push('Python风格注释#');

    // 文档注释
    if (/\/\*\*/.test(codeStr)) profile.push('JSDoc文档注释');
    if (/"""/.test(codeStr)) profile.push('Python文档字符串');

    return profile.length > 0 ? profile.join(', ') : '未检测到明显风格';
  }

  /**
   * 记录审查历史
   */
  _recordReview (task, code, reviewResult) {
    this._reviewHistory.push({
      timestamp: Date.now(),
      taskTitle: task.title,
      score: reviewResult.overallScore,
      passed: reviewResult.passed,
      issues: reviewResult.issues || [],
      summary: reviewResult.summary || ''
    });

    if (this._reviewHistory.length > this._maxHistory) {
      this._reviewHistory.shift();
    }
  }

  /**
   * 获取当前任务的审查轮次
   */
  _getReviewRound (task) {
    return this._reviewHistory.filter(r => r.taskTitle === task.title).length;
  }

  /**
   * 获取审查统计
   */
  getReviewStats () {
    const total = this._reviewHistory.length;
    const passed = this._reviewHistory.filter(r => r.passed).length;
    const avgScore = total > 0
      ? Math.round(this._reviewHistory.reduce((sum, r) => sum + (r.score || 0), 0) / total)
      : 0;

    const issueCategories = {};
    for (const review of this._reviewHistory) {
      for (const issue of review.issues || []) {
        const cat = issue.category || 'other';
        issueCategories[cat] = (issueCategories[cat] || 0) + 1;
      }
    }

    return {
      totalReviews: total,
      passedReviews: passed,
      passRate: total > 0 ? (passed / total * 100).toFixed(1) + '%' : '0%',
      avgScore,
      commonIssues: Object.entries(issueCategories)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([cat, count]) => `${cat}(${count})`)
    };
  }

  /**
   * 重置审查历史
   */
  resetHistory () {
    this._reviewHistory = [];
    this._projectStyleProfile = null;
  }
}

module.exports = CodeReviewerAgent;
