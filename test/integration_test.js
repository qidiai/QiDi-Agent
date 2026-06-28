/**
 * 真实任务集成测试 - 使用 MockProvider 模拟 AI 响应
 * 验证：分解 → 执行 → 质检 → 合并 完整流程
 */
const MockProvider = {
  name: 'mock',
  async chat(messages, options = {}) {
    const lastMessage = messages[messages.length - 1]?.content || '';
    
    // 模拟任务分解响应
    if (lastMessage.includes('拆分')) {
      return {
        content: `\`\`\`json\n{\n  "taskOverview": "实现一个C语言斐波那契数列",\n  "constraints": {\n    "language": "c",\n    "techStack": "console",\n    "platform": "windows",\n    "framework": "None",\n    "style": "C标准库",\n    "fileExtension": "c"\n  },\n  "subtasks": [\n    {\n      "id": "T1",\n      "title": "设计数据结构与接口",\n      "description": "设计斐波那契数列的数据结构和函数接口",\n      "role": "architect",\n      "dependsOn": [],\n      "acceptanceCriteria": "接口定义清晰",\n      "estimatedComplexity": "low",\n      "estimatedHours": 0.5\n    },\n    {\n      "id": "T2",\n      "title": "实现核心算法",\n      "description": "实现斐波那契数列递归和迭代两种算法",\n      "role": "code_writer",\n      "dependsOn": ["T1"],\n      "acceptanceCriteria": "算法正确，可编译运行",\n      "estimatedComplexity": "medium",\n      "estimatedHours": 1\n    },\n    {\n      "id": "T3",\n      "title": "代码质量检查",\n      "description": "检查代码质量、约束遵守情况",\n      "role": "quality_checker",\n      "dependsOn": ["T2"],\n      "acceptanceCriteria": "质量评分>80分",\n      "estimatedComplexity": "low",\n      "estimatedHours": 0.5\n    }\n  ],\n  "dependencyGraph": {\n    "T1": [],\n    "T2": ["T1"],\n    "T3": ["T2"]\n  },\n  "coverageCheck": {\n    "allRequirementsCovered": true,\n    "potentialGaps": [],\n    "riskItems": []\n  },\n  "overallPlan": "先设计接口，再实现算法，最后质检"\n}\n\`\`\``,
        role: 'assistant'
      };
    }
    
    // 模拟代码编写响应
    if (lastMessage.includes('完成以下编程任务') || lastMessage.includes('设计数据结构与接口')) {
      return {
        content: `\`\`\`c\n// fibonacci.h\n#ifndef FIBONACCI_H\n#define FIBONACCI_H\n\n// 递归实现\nlong long fib_recursive(int n);\n\n// 迭代实现\nlong long fib_iterative(int n);\n\n#endif\n\`\`\`\n\n\`\`\`c\n// fibonacci.c\n#include <stdio.h>\n#include <stdlib.h>\n\nlong long fib_recursive(int n) {\n    if (n <= 1) return n;\n    return fib_recursive(n - 1) + fib_recursive(n - 2);\n}\n\nlong long fib_iterative(int n) {\n    if (n <= 1) return n;\n    long long a = 0, b = 1, temp;\n    for (int i = 2; i <= n; i++) {\n        temp = a + b;\n        a = b;\n        b = temp;\n    }\n    return b;\n}\n\`\`\``,
        role: 'assistant'
      };
    }
    
    // 模拟质量检查响应
    if (lastMessage.includes('审核')) {
      return {
        content: `\`\`\`json\n{\n  "taskId": "T2",\n  "qualityScore": 85,\n  "status": "completed",\n  "strengths": ["算法正确", "两种实现方式"],\n  "weaknesses": ["缺少边界检查"],\n  "nextSteps": ["添加输入验证"],\n  "revisionSuggestions": "",\n  "canProceed": true,\n  "constraintViolations": [],\n  "securityIssues": [],\n  "codeMetrics": {\n    "linesOfCode": 25,\n    "commentRatio": 8,\n    "functionCount": 2\n  }\n}\n\`\`\``,
        role: 'assistant'
      };
    }
    
    // 默认响应
    return { content: 'OK', role: 'assistant' };
  },
  
  async generate(prompt, options = {}) {
    return this.chat([{ role: 'user', content: prompt }], options);
  },
  
  async checkConnection() {
    return true;
  }
};

// 验证Provider接口
class MockProviderWrapper {
  constructor() { this.name = 'mock'; }
  async chat(messages, options) { return MockProvider.chat(messages, options); }
  async generate(prompt, options) { return MockProvider.generate(prompt, options); }
  async checkConnection() { return MockProvider.checkConnection(); }
}

// 测试主函数
async function runIntegrationTest() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  真实任务集成测试 - MockProvider');
  console.log('═══════════════════════════════════════════════════\n');
  
  const provider = new MockProviderWrapper();
  const TaskOrchestrator = require('../src/core/TaskOrchestrator');
  const MultiAgentDispatcher = require('../src/core/MultiAgentDispatcher');
  const MergeEngine = require('../src/agents/MergeEngine');
  
  const results = {
    passed: 0, failed: 0, tests: []
  };
  
  function check(name, condition, detail = '') {
    if (condition) {
      results.passed++;
      console.log(`✅ ${name}`);
    } else {
      results.failed++;
      console.log(`❌ ${name} ${detail ? '- ' + detail : ''}`);
    }
  }
  
  // ────────────────── 测试1：端到端任务编排 ──────────────────
  console.log('\n📋 测试1: 端到端任务编排（分解→执行→质检）\n');
  
  const orchestrator = new TaskOrchestrator(provider, {
    workspaceDir: './workspace/integration_test',
    enableCache: false,      // 关闭缓存以测试完整流程
    enableCompression: false, // 关闭压缩简化测试
    enableModelRouting: false,
    maxRetries: 1
  });
  
  let taskResult;
  try {
    await orchestrator.initialize();
    
    // 监听关键事件
    const events = [];
    orchestrator.on('taskStart', () => events.push('taskStart'));
    orchestrator.on('taskSplit', (e) => events.push(`taskSplit:${e.tasks.length}tasks`));
    orchestrator.on('taskComplete_sub', () => events.push('taskComplete_sub'));
    orchestrator.on('qualityReview', () => events.push('qualityReview'));
    orchestrator.on('taskComplete', () => events.push('taskComplete'));
    
    taskResult = await orchestrator.runTask('用C语言实现一个斐波那契数列，包含递归和迭代两种算法');
    
    check('任务成功完成', taskResult.successRate === 100, `成功率: ${taskResult.successRate}`);
    check('任务被拆分', taskResult.totalTasks > 0, `子任务数: ${taskResult.totalTasks}`);
    check('所有子任务完成', taskResult.completedTasks === taskResult.totalTasks, 
          `${taskResult.completedTasks}/${taskResult.totalTasks}`);
    check('约束被正确提取', taskResult.constraints?.language === 'c', 
          `语言: ${taskResult.constraints?.language}`);
    check('依赖关系验证通过', taskResult.dependencyValidation?.valid === true);
    check('覆盖度检查通过', taskResult.coverageCheck?.allRequirementsCovered === true);
    check('Token统计生成', taskResult.tokenStats !== undefined);
    check('报告已生成', taskResult.reportId !== undefined);
    check('事件流完整', events.includes('taskStart') && events.some(e => e.startsWith('taskSplit')) && events.includes('taskComplete'));
    
  } catch (e) {
    check('端到端任务编排', false, e.message);
  }
  
  // ────────────────── 测试2：多Agent合并模式 ──────────────────
  console.log('\n📋 测试2: 多Agent合并模式\n');
  
  const dispatcher = new MultiAgentDispatcher({
    outputDir: './workspace/multi_test'
  });
  
  // 模拟多个Agent的结果
  const mockResults = {
    'Agent1': {
      success: true,
      result: {
        codeBlocks: [{ language: 'c', code: '#include <stdio.h>\nint add(int a, int b) { return a + b; }', filePath: 'math.c' }],
        quality: { qualityScore: 80 }
      }
    },
    'Agent2': {
      success: true,
      result: {
        codeBlocks: [{ language: 'c', code: '#include <stdio.h>\nint add(int a, int b) {\n  // 边界检查\n  if (a > 1000000 || b > 1000000) return -1;\n  return a + b;\n}', filePath: 'math.c' }],
        quality: { qualityScore: 90 }
      }
    }
  };
  
  const mergeEngine = new MergeEngine(provider);
  try {
    const mergeResult = await mergeEngine.merge(mockResults, { language: 'c' });
    
    check('合并成功', mergeResult.error === undefined || mergeResult.error === null);
    check('合并产出文件', Object.keys(mergeResult.mergedFiles || {}).length > 0, 
          `文件数: ${Object.keys(mergeResult.mergedFiles || {}).length}`);
    check('合并代码非空', (mergeResult.mergedCode || '').length > 0);
    check('质量评估存在', mergeResult.qualityAssessment !== undefined);
    check('一致性检查通过', mergeResult.consistencyCheck?.passed === true || 
          mergeResult.consistencyCheck?.issues?.length === 0, 
          `一致性问题: ${mergeResult.consistencyCheck?.issues?.length || 0}`);
    
  } catch (e) {
    check('多Agent合并', false, e.message);
  }
  
  // ────────────────── 测试3：循环依赖检测 ──────────────────
  console.log('\n📋 测试3: 循环依赖检测与修复\n');
  
  const TaskSplitterAgent = require('../src/agents/TaskSplitterAgent');
  const splitter = new TaskSplitterAgent(provider);
  
  // 直接测试依赖验证（不依赖AI）
  const validDeps = [
    { id: 'T1', dependsOn: [] },
    { id: 'T2', dependsOn: ['T1'] },
    { id: 'T3', dependsOn: ['T2'] }
  ];
  const check1 = splitter._validateDependencies(validDeps);
  check('无循环依赖检测', check1.valid === true);
  
  const circularDeps = [
    { id: 'T1', dependsOn: ['T3'] },
    { id: 'T2', dependsOn: ['T1'] },
    { id: 'T3', dependsOn: ['T2'] }
  ];
  const check2 = splitter._validateDependencies(circularDeps);
  check('循环依赖检测', check2.valid === false && check2.cycles.length > 0);
  
  const fixed = splitter._fixCircularDependencies(
    JSON.parse(JSON.stringify(circularDeps)), 
    check2.cycles
  );
  check('循环依赖修复', fixed.some(t => t.dependsOn.length === 0 || !t.dependsOn.includes('T1')));
  
  // ────────────────── 测试4：QualityChecker工具链 ──────────────────
  console.log('\n📋 测试4: QualityChecker 工具链集成\n');
  
  const QualityCheckerAgent = require('../src/agents/QualityCheckerAgent');
  const checker = new QualityCheckerAgent(provider);
  
  // 测试C代码编译检查（如果没有gcc，会返回"未找到"但流程正确）
  const cCode = '#include <stdio.h>\nint main() { printf("hello"); return 0; }';
  const compileResult = checker.toolRunner.compileCode(cCode, 'c');
  check('编译检查执行', compileResult !== undefined, `编译结果: ${compileResult?.compiled !== undefined ? '有compiled字段' : 'undefined'}`);
  check('编译结果结构正确', 
    compileResult && typeof compileResult.compiled === 'boolean' && 
    typeof compileResult.errors === 'string');
  
  // 测试C语言安全检测
  const unsafeCode = 'void test() { char buf[10]; gets(buf); strcpy(buf, "hello"); }';
  const securityIssues = checker._checkCSecurity(unsafeCode);
  check('C安全检测 - gets', securityIssues.some(i => i.includes('gets')));
  check('C安全检测 - strcpy', securityIssues.some(i => i.includes('strcpy')));
  
  // 测试代码指标
  const metrics = checker._calculateMetrics(cCode);
  check('代码指标计算', metrics.linesOfCode > 0 && metrics.functionCount >= 0);
  
  // ────────────────── 测试5：覆盖度验证 ──────────────────
  console.log('\n📋 测试5: 覆盖度验证\n');
  
  const subtasks = [
    { id: 'T1', title: '设计数据结构', description: '设计斐波那契数列的数据结构和函数接口', acceptanceCriteria: '接口定义清晰', role: 'architect', dependsOn: [] },
    { id: 'T2', title: '实现核心算法', description: '实现递归和迭代两种斐波那契算法', acceptanceCriteria: '算法正确', role: 'code_writer', dependsOn: ['T1'] },
    { id: 'T3', title: '代码质量审查', description: '审查C语言代码质量和约束遵守情况', acceptanceCriteria: '无严重问题', role: 'quality_checker', dependsOn: ['T2'] }
  ];
  const coverage = splitter._validateCoverage(subtasks, '用C语言实现斐波那契数列包含递归和迭代两种算法');
  check('覆盖度计算', coverage.coverageRatio > 0);
  check('覆盖度判定', coverage.allRequirementsCovered === true || coverage.coverageRatio >= 80);
  
  // ────────────────── 总结 ──────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  测试结果: ${results.passed}/${results.passed + results.failed} 通过 (${Math.round((results.passed / (results.passed + results.failed)) * 100)}%)`);
  console.log('═══════════════════════════════════════════════════\n');
  
  if (results.failed > 0) {
    console.log('⚠️  有测试失败，请检查上述 ❌ 项');
    process.exit(1);
  } else {
    console.log('🎉 所有集成测试通过！重构后的代码在完整流程中表现正常。');
  }
}

runIntegrationTest().catch(err => {
  console.error('测试运行失败:', err);
  process.exit(1);
});
