#!/usr/bin/env node
require('dotenv').config();

const OpenAIProvider = require('../src/providers/OpenAIProvider');
const CodeWriterAgent = require('../src/agents/CodeWriterAgent');
const QualityCheckerAgent = require('../src/agents/QualityCheckerAgent');
const AdapterFactory = require('../src/adapters');

const TEST_TASK = '用Python写一个函数，实现快速排序算法，支持整数列表排序，包含注释和测试用例';

async function testAIProvider () {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('测试: 纯AI Provider模式');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const provider = new OpenAIProvider({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
  });

  const codeWriter = new CodeWriterAgent(provider);
  const qualityChecker = new QualityCheckerAgent(provider);

  const startTime = Date.now();

  const writeResult = await codeWriter.writeCode({
    title: '快速排序算法实现',
    description: TEST_TASK,
    constraints: { language: 'python' }
  });

  const qualityResult = await qualityChecker.checkQuality(
    { id: 'test_task', title: '快速排序算法实现' },
    writeResult.content,
    { constraints: { language: 'python' } }
  );

  const duration = Date.now() - startTime;

  console.log('✅ 任务完成');
  console.log(`⏱️  耗时: ${(duration / 1000).toFixed(2)}秒`);
  console.log(`📄 代码块: ${writeResult.codeBlocks?.length || 0}个`);
  console.log(`📈 质量评分: ${qualityResult.qualityScore || 0}分`);
  console.log(`📋 状态: ${qualityResult.status}`);

  return {
    name: '纯AI Provider模式',
    duration,
    codeBlocks: writeResult.codeBlocks?.length || 0,
    qualityScore: qualityResult.qualityScore || 0,
    success: true
  };
}

async function testTool (toolName) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`测试: 单工具模式 - ${toolName}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const allAdapters = AdapterFactory.createAll();
  const adapter = allAdapters.find(a => a.name === toolName);

  if (!adapter) {
    console.log(`❌ 未找到适配器: ${toolName}`);
    return { name: `单工具模式 - ${toolName}`, success: false, error: '适配器未找到' };
  }

  const provider = new OpenAIProvider({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
  });

  const qualityChecker = new QualityCheckerAgent(provider);

  const startTime = Date.now();

  try {
    await adapter.detect();
    console.log(`🔍 检测到: ${adapter.installPath}`);

    const connectResult = await adapter.connect();
    if (!connectResult.success) {
      console.log(`❌ 连接失败: ${connectResult.message}`);
      return { name: `单工具模式 - ${toolName}`, success: false, error: '连接失败' };
    }
    console.log('✅ 连接成功');

    const executeResult = await adapter.execute(TEST_TASK, {
      taskId: `test_${toolName}`,
      timeout: 120000
    });

    if (!executeResult.success) {
      console.log(`❌ 执行失败: ${executeResult.error || executeResult.stderr}`);
      return { name: `单工具模式 - ${toolName}`, success: false, error: '执行失败' };
    }

    let qualityScore = 0;
    if (executeResult.content || executeResult.codeBlocks?.length > 0) {
      const contentToCheck = executeResult.content || JSON.stringify(executeResult.codeBlocks);
      const qualityResult = await qualityChecker.checkQuality(
        { id: `test_${toolName}`, title: '快速排序算法实现' },
        contentToCheck,
        { constraints: { language: 'python' } }
      );
      qualityScore = qualityResult.qualityScore || 0;
    }

    const duration = Date.now() - startTime;

    console.log('✅ 任务完成');
    console.log(`⏱️  耗时: ${(duration / 1000).toFixed(2)}秒`);
    console.log(`📄 代码块: ${executeResult.codeBlocks?.length || 0}个`);
    console.log(`📈 质量评分: ${qualityScore}分`);

    return {
      name: `单工具模式 - ${toolName}`,
      duration,
      codeBlocks: executeResult.codeBlocks?.length || 0,
      qualityScore,
      success: true
    };
  } catch (e) {
    console.log(`❌ 错误: ${e.message}`);
    return { name: `单工具模式 - ${toolName}`, success: false, error: e.message };
  }
}

async function main () {
  console.log('\n🚀 简化质量对比测试');
  console.log('='.repeat(60));
  console.log(`测试任务: ${TEST_TASK}`);

  const results = [];

  results.push(await testAIProvider());
  results.push(await testTool('atom-code'));
  results.push(await testTool('openclaw'));

  console.log('\n' + '='.repeat(60));
  console.log('📊 对比测试报告');
  console.log('='.repeat(60));

  console.log('\n' + '| 测试模式 | 耗时(秒) | 代码块 | 质量评分 | 状态 |');
  console.log('|----------|----------|--------|----------|------|');

  for (const r of results) {
    console.log(`| ${r.name} | ${(r.duration / 1000).toFixed(2)} | ${r.codeBlocks} | ${r.qualityScore} | ${r.success ? '✅' : '❌'} |`);
  }

  const successResults = results.filter(r => r.success);
  if (successResults.length > 0) {
    const bestResult = successResults.reduce((best, curr) => curr.qualityScore > best.qualityScore ? curr : best);
    console.log(`\n📈 最佳结果: ${bestResult.name}，评分: ${bestResult.qualityScore}分`);
  }

  console.log('\n' + '='.repeat(60));
}

main().catch(e => {
  console.error('测试失败:', e);
  process.exit(1);
});
