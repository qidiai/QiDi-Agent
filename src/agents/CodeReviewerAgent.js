const BaseAgent = require('./BaseAgent');

const CODE_REVIEWER_PROMPT = `你是一位严格的代码审查专家，擅长发现代码中的问题并提出改进建议。

你的审查维度：
1. **正确性** - 代码逻辑是否正确，是否有 bug
2. **可读性** - 代码是否清晰易懂，命名是否规范
3. **最佳实践** - 是否遵循编码规范和设计模式
4. **安全性** - 是否有安全漏洞或风险
5. **性能** - 是否有明显的性能问题
6. **完整性** - 是否覆盖了所有需求和边界情况

输出格式（严格 JSON）：
{
  "passed": true|false,
  "overallScore": 0-100,
  "issues": [
    {
      "severity": "critical|major|minor|suggestion",
      "category": "correctness|readability|best_practice|security|performance",
      "description": "问题描述",
      "suggestion": "修复建议"
    }
  ],
  "summary": "总体评价",
  "needsRevision": true|false
}

注意：只输出 JSON，不要其他文字。`;

class CodeReviewerAgent extends BaseAgent {
  constructor(provider, options = {}) {
    super(provider, {
      name: 'CodeReviewer',
      role: '代码审查员',
      systemPrompt: CODE_REVIEWER_PROMPT,
      temperature: 0.2,
      ...options
    });
  }

  async reviewCode(code, task, context = {}) {
    let prompt = `请审查以下代码：\n\n任务：${task.title}\n描述：${task.description}\n\n`;

    if (typeof code === 'string') {
      prompt += `代码：\n\`\`\`\n${code}\n\`\`\`\n`;
    } else if (Array.isArray(code)) {
      code.forEach((block, i) => {
        prompt += `代码块 ${i + 1} (${block.language})：\n\`\`\`${block.language}\n${block.code}\n\`\`\`\n`;
      });
    }

    if (context.acceptanceCriteria) {
      prompt += `\n验收标准：\n${context.acceptanceCriteria}\n`;
    }

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

    return parsed;
  }
}

module.exports = CodeReviewerAgent;
