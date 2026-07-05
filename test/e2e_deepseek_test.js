#!/usr/bin/env node
require('dotenv').config();

const OpenAIProvider = require('../src/providers/OpenAIProvider');
const TaskOrchestrator = require('../src/core/TaskOrchestrator');
const AdapterFactory = require('../src/adapters');
const path = require('path');
const fs = require('fs');

async function main () {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

  if (!apiKey || apiKey === 'your-api-key') {
    console.log('❌ 请配置 DEEPSEEK_API_KEY 环境变量');
    process.exit(0);
  }

  const provider = new OpenAIProvider({
    apiKey,
    baseUrl,
    model
  });

  console.log(`\n🚀 端到端测试 - DeepSeek (${model})`);
  console.log('='.repeat(50));
  console.log('');

  const allAdapters = AdapterFactory.createAll();
  const testAdapters = allAdapters.filter(a => ['openclaw', 'atom-code'].includes(a.name));
  console.log(`\n🛠️  已创建 ${allAdapters.length} 个工具适配器`);
  console.log(`   测试适配器: ${testAdapters.map(a => a.name).join(', ')}`);

  const results = { passed: 0, failed: 0 };
  const startTime = Date.now();

  function assert (name, condition, detail = '') {
    if (condition) {
      results.passed++;
      console.log(`  ✅ ${name}`);
    } else {
      results.failed++;
      console.log(`  ❌ ${name}${detail ? `: ${detail}` : ''}`);
    }
    return condition;
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('测试1: 简单Python函数 - privacy模式');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const orch = new TaskOrchestrator(provider, {
      workspaceDir: './test_tmp/e2e_deepseek_privacy',
      executionMode: 'privacy',
      enableCache: false,
      maxRetries: 1,
      toolAdapters: testAdapters
    });
    await orch.initialize();

    const taskResult = await orch.runTask('用Python写一个函数，计算两个数的最大公约数');

    assert('任务完成', taskResult.completedTasks >= 1);
    assert('有代码产出', taskResult.tasks.some(t => t.result?.codeBlocks?.length > 0));

    if (taskResult.tasks.some(t => t.result?.codeBlocks?.length > 0)) {
      const codeBlock = taskResult.tasks.find(t => t.result?.codeBlocks?.length > 0)?.result?.codeBlocks[0];
      console.log(`  📄 生成代码: ${codeBlock?.language || 'unknown'}`);
      console.log(`  📝 代码片段: ${codeBlock?.code?.substring(0, 100)}...`);
    }

    assert('有质量评分', taskResult.tasks.some(t => t.result?.quality?.qualityScore > 0));

    if (taskResult.tasks.some(t => t.result?.quality?.qualityScore > 0)) {
      const qualityTask = taskResult.tasks.find(t => t.result?.quality?.qualityScore > 0);
      console.log(`  📊 质量评分: ${qualityTask.result.quality.qualityScore}分`);
    }
  } catch (e) {
    assert('privacy模式不抛异常', false, e.message);
    console.error(e);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('测试2: 中等复杂度任务 - quality模式');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const orch = new TaskOrchestrator(provider, {
      workspaceDir: './test_tmp/e2e_deepseek_quality',
      executionMode: 'quality',
      enableCache: false,
      maxRetries: 1,
      toolAdapters: testAdapters
    });
    await orch.initialize();

    const taskResult = await orch.runTask('用Python写一个简单的HTTP服务器，支持GET请求返回JSON数据');

    assert('任务完成', taskResult.completedTasks >= 1);
    assert('有代码产出', taskResult.tasks.some(t => t.result?.codeBlocks?.length > 0));

    if (taskResult.tasks.some(t => t.result?.codeBlocks?.length > 0)) {
      const codeBlock = taskResult.tasks.find(t => t.result?.codeBlocks?.length > 0)?.result?.codeBlocks[0];
      console.log(`  📄 生成代码: ${codeBlock?.language || 'unknown'}`);
      console.log(`  📝 代码片段: ${codeBlock?.code?.substring(0, 150)}...`);
    }

    assert('有质量评分', taskResult.tasks.some(t => t.result?.quality?.qualityScore > 0));

    if (taskResult.tasks.some(t => t.result?.quality?.qualityScore > 0)) {
      const qualityTask = taskResult.tasks.find(t => t.result?.quality?.qualityScore > 0);
      console.log(`  📊 质量评分: ${qualityTask.result.quality.qualityScore}分`);
      if (qualityTask.result.quality.status) {
        console.log(`  📋 状态: ${qualityTask.result.quality.status}`);
      }
    }

    const reportId = taskResult.reportId;
    assert('报告生成', !!reportId);
    if (reportId) {
      console.log(`  📄 报告ID: ${reportId}`);
    }
  } catch (e) {
    assert('quality模式不抛异常', false, e.message);
    console.error(e);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('测试3: 任务分类器验证');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const TaskClassifier = require('../src/utils/TaskClassifier');
    const classifier = new TaskClassifier();

    const programmingTask = classifier.classify('用JavaScript写一个排序算法');
    const chatTask = classifier.classify('你好，今天天气怎么样');
    const codeBlockTask = classifier.classify('```python\nprint("hello")\n```');

    assert('编程任务识别', programmingTask.type === 'programming');
    assert('聊天任务识别', chatTask.type === 'chat' || chatTask.type === 'greeting');
    assert('代码块任务识别', codeBlockTask.type === 'programming');

    console.log(`  🧠 编程任务置信度: ${programmingTask.confidence}`);
    console.log(`  🧠 聊天任务置信度: ${chatTask.confidence}`);
    console.log(`  🧠 代码块任务置信度: ${codeBlockTask.confidence}`);
  } catch (e) {
    assert('任务分类器不抛异常', false, e.message);
    console.error(e);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('测试4: 工具执行器验证');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const ToolExecutor = require('../src/core/ToolExecutor');
    const executor = new ToolExecutor();

    const availableTools = executor.getAvailableTools();
    console.log(`  🛠️  可用工具: ${availableTools.length}个`);
    if (availableTools.length > 0) {
      console.log(`  🛠️  工具列表: ${availableTools.join(', ')}`);
    }

    assert('工具执行器初始化成功', true);
  } catch (e) {
    assert('工具执行器不抛异常', false, e.message);
    console.error(e);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('测试5: MergeEngine合并验证');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const MergeEngine = require('../src/agents/MergeEngine');
    const engine = new MergeEngine(provider, { name: 'e2e-merge' });

    const agentResults = {
      agent_a: {
        success: true,
        result: {
          codeBlocks: [{ language: 'python', code: 'def add(a, b):\n    return a + b', filePath: 'main.py' }]
        }
      },
      agent_b: {
        success: true,
        result: {
          codeBlocks: [{ language: 'python', code: 'def add(a, b):\n    """Add two numbers"""\n    return a + b', filePath: 'main.py' }]
        }
      }
    };

    const mergeResult = await engine.merge(agentResults);

    assert('合并成功', !!mergeResult.mergedCode);
    assert('合并代码不为空', mergeResult.mergedCode.length > 0);
    console.log(`  🔄 合并代码长度: ${mergeResult.mergedCode.length}字符`);
    console.log(`  📊 冲突数: ${mergeResult.conflicts?.length || 0}`);
  } catch (e) {
    assert('MergeEngine不抛异常', false, e.message);
    console.error(e);
  }

  const totalTime = Date.now() - startTime;

  console.log('\n' + '='.repeat(50));
  console.log(`📊 端到端测试结果: ${results.passed}/${results.passed + results.failed} 通过`);
  console.log(`⏱️  总耗时: ${(totalTime / 1000).toFixed(2)}秒`);
  console.log('='.repeat(50));

  if (results.failed > 0) {
    console.log(`\n❌ 失败的测试: ${results.failed}个`);
    process.exit(1);
  } else {
    console.log('\n✅ 所有端到端测试通过!');
    process.exit(0);
  }
}

main().catch(e => {
  console.error('端到端测试失败:', e);
  process.exit(1);
});
