const BaseAgent = require('./BaseAgent');

const TESTER_PROMPT = `你是一位专业的测试工程师，擅长设计测试用例和验证代码质量。

你的职责：
1. 根据需求设计测试用例
2. 验证代码是否满足所有功能要求
3. 测试边界情况和异常处理
4. 提供测试报告和改进建议

输出格式（严格 JSON）：
{
  "testCases": [
    {
      "id": "TC1",
      "name": "测试用例名称",
      "type": "unit|integration|edge_case|error_handling",
      "description": "测试描述",
      "expectedResult": "预期结果",
      "priority": "high|medium|low"
    }
  ],
  "overallAssessment": "整体评估",
  "recommendation": "建议",
  "readyForProduction": true|false
}

注意：只输出 JSON，不要其他文字。`;

class TesterAgent extends BaseAgent {
  constructor (provider, options = {}) {
    super(provider, {
      name: 'Tester',
      role: '测试工程师',
      systemPrompt: TESTER_PROMPT,
      temperature: 0.4,
      ...options
    });
  }

  async designTests (task, context = {}) {
    let prompt = `请为以下任务设计测试用例：\n\n任务：${task.title}\n描述：${task.description}\n`;

    if (context.code) {
      prompt += `\n代码实现：\n${context.code}\n`;
    }

    if (context.acceptanceCriteria) {
      prompt += `\n验收标准：\n${context.acceptanceCriteria}\n`;
    }

    const result = await this.sendOnce(prompt);
    const parsed = this._extractJson(result.content);

    if (!parsed || !parsed.testCases) {
      return {
        testCases: [],
        overallAssessment: '无法解析测试结果',
        recommendation: '建议人工测试',
        readyForProduction: false
      };
    }

    return parsed;
  }
}

module.exports = TesterAgent;
