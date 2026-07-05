const BaseAgent = require('./BaseAgent');
const { safeJsonParse } = require('../utils/SafeParser');

const TESTER_PROMPT = `你是一位专业的测试工程师，擅长设计测试用例和验证代码质量。

你的职责：
1. 根据需求设计测试用例
2. 编写可执行的测试代码
3. 验证代码是否满足所有功能要求
4. 测试边界情况和异常处理
5. 提供测试报告和改进建议

输出格式（严格 JSON）：
{
  "testCases": [
    {
      "id": "TC1",
      "name": "测试用例名称",
      "type": "unit|integration|edge_case|error_handling",
      "description": "测试描述",
      "expectedResult": "预期结果",
      "priority": "high|medium|low",
      "testCode": "可执行的测试代码片段"
    }
  ],
  "testSuite": {
    "framework": "pytest|jest|mocha|go_test|junit",
    "setupCode": "测试前置代码（如import/fixture）",
    "teardownCode": "测试后置清理代码",
    "fullTestFile": "完整的可执行测试文件内容"
  },
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
      enableStructuredOutput: false,
      ...options
    });
    this.testRunner = options.testRunner || null;
    this.enableAutoRun = options.enableAutoRun !== false;
    this._reviewHistory = [];
    this._maxHistory = options.maxHistory || 50;
  }

  setTestRunner (runner) {
    this.testRunner = runner;
  }

  /**
   * 设计测试用例 + 生成可执行测试代码
   */
  async designTests (task, context = {}) {
    let prompt = `请为以下任务设计测试用例并生成可执行的测试代码：\n\n任务：${task.title}\n描述：${task.description}\n`;

    if (context.code) {
      // 如果代码过长，截断
      const code = context.code.length > 8000
        ? context.code.substring(0, 8000) + '\n// ... (代码过长已截断)'
        : context.code;
      prompt += `\n代码实现：\n\`\`\`${context.language || ''}\n${code}\n\`\`\`\n`;
    }

    if (context.acceptanceCriteria) {
      prompt += `\n验收标准：\n${Array.isArray(context.acceptanceCriteria) ? context.acceptanceCriteria.join('\n') : context.acceptanceCriteria}\n`;
    }

    if (context.language) {
      prompt += `\n编程语言：${context.language}\n`;
    }

    if (context.framework) {
      prompt += `测试框架：${context.framework}\n`;
    }

    prompt += '\n请生成完整的、可直接执行的测试文件代码（testSuite.fullTestFile字段）。';

    const result = await this.sendOnce(prompt);
    const parsed = this._extractJson(result.content);

    if (!parsed || !parsed.testCases) {
      return {
        testCases: [],
        testSuite: null,
        overallAssessment: '无法解析测试结果',
        recommendation: '建议人工测试',
        readyForProduction: false,
        rawContent: result.content
      };
    }

    // 记录审查历史
    this._reviewHistory.push({
      timestamp: Date.now(),
      taskTitle: task.title,
      testCaseCount: parsed.testCases.length,
      framework: parsed.testSuite?.framework
    });
    if (this._reviewHistory.length > this._maxHistory) {
      this._reviewHistory.shift();
    }

    return parsed;
  }

  /**
   * 设计 + 执行测试（完整闭环）
   */
  async designAndRunTests (task, context = {}) {
    // 1. 设计测试
    const design = await this.designTests(task, context);

    // 2. 如果有 TestRunner 且启用了自动执行
    if (this.testRunner && this.enableAutoRun && design.testSuite?.fullTestFile) {
      const executionResult = await this.testRunner.runTests({
        testCode: design.testSuite.fullTestFile,
        language: context.language || 'javascript',
        framework: design.testSuite.framework,
        sourceCode: context.code || null,
        workspaceDir: context.workspaceDir || null
      });

      return {
        ...design,
        executionResult
      };
    }

    // 3. 如果有测试用例但没有 TestRunner，尝试批量执行
    if (this.testRunner && this.enableAutoRun && design.testCases?.length > 0) {
      const executionResult = await this.testRunner.runTestCases(design.testCases, {
        language: context.language || 'javascript',
        sourceCode: context.code || null,
        workspaceDir: context.workspaceDir || null
      });

      return {
        ...design,
        executionResult
      };
    }

    return {
      ...design,
      executionResult: null,
      executionNote: 'TestRunner 未配置，测试用例已生成但未执行'
    };
  }

  /**
   * 根据历史审查记录优化测试策略
   */
  getTestStrategyRecommendation () {
    if (this._reviewHistory.length === 0) {
      return { strategy: 'default', reason: '无历史数据' };
    }

    const frameworks = {};
    let totalCases = 0;
    for (const record of this._reviewHistory) {
      const fw = record.framework || 'unknown';
      frameworks[fw] = (frameworks[fw] || 0) + 1;
      totalCases += record.testCaseCount || 0;
    }

    const avgCases = totalCases / this._reviewHistory.length;
    const mostUsedFramework = Object.entries(frameworks).sort((a, b) => b[1] - a[1])[0];

    return {
      strategy: 'history_based',
      preferredFramework: mostUsedFramework?.[0],
      avgTestCases: Math.round(avgCases),
      totalRuns: this._reviewHistory.length
    };
  }

  /**
   * 生成测试报告
   */
  generateTestReport (design, executionResult) {
    let report = '═══════════════════════════════════════════\n';
    report += '              测试报告\n';
    report += '═══════════════════════════════════════════\n\n';

    report += `【测试框架】${design.testSuite?.framework || 'N/A'}\n`;
    report += `【测试用例数】${design.testCases?.length || 0}\n\n`;

    if (executionResult) {
      report += '【执行结果】\n';
      report += `  总数: ${executionResult.total}\n`;
      report += `  通过: ${executionResult.passed}\n`;
      report += `  失败: ${executionResult.failed}\n`;
      report += `  错误: ${executionResult.errors}\n`;
      report += `  跳过: ${executionResult.skipped}\n`;
      report += `  耗时: ${executionResult.duration}ms\n`;
      report += `  结果: ${executionResult.passed ? '✅ 通过' : '❌ 失败'}\n\n`;

      if (executionResult.failures && executionResult.failures.length > 0) {
        report += '【失败详情】\n';
        for (const failure of executionResult.failures) {
          report += `  ❌ ${failure.name}\n`;
          report += `     ${failure.message.substring(0, 200)}\n`;
        }
      }
    } else {
      report += '【执行结果】未执行\n\n';
    }

    report += `\n【整体评估】${design.overallAssessment || 'N/A'}\n`;
    report += `【建议】${design.recommendation || 'N/A'}\n`;
    report += `【生产就绪】${design.readyForProduction ? '✅ 是' : '❌ 否'}\n`;

    return report;
  }
}

module.exports = TesterAgent;
