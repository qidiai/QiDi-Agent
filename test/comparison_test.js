#!/usr/bin/env node
require('dotenv').config();

const OpenAIProvider = require('../src/providers/OpenAIProvider');
const TaskOrchestrator = require('../src/core/TaskOrchestrator');
const AdapterFactory = require('../src/adapters');

const COMPLEX_TASK = `用Python写一个函数，实现快速排序算法，要求：
1. 支持整数列表排序
2. 时间复杂度O(n log n)
3. 使用原地排序节省空间
4. 包含注释说明算法原理
5. 包含测试用例验证正确性`;

async function runTest (name, adapterFilter = null, executionMode = 'privacy') {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`测试: ${name}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

  const provider = new OpenAIProvider({ apiKey, baseUrl, model });

  const allAdapters = AdapterFactory.createAll();
  const toolAdapters = adapterFilter ? allAdapters.filter(adapterFilter) : [];

  console.log(`工具适配器: ${toolAdapters.length > 0 ? toolAdapters.map(a => a.name).join(', ') : '无（纯AI模式）'}`);

  const startTime = Date.now();
  const orch = new TaskOrchestrator(provider, {
    workspaceDir: `./test_tmp/comparison_${Date.now()}`,
    executionMode,
    enableCache: false,
    maxRetries: 1,
    toolAdapters
  });

  await orch.initialize();

  try {
    const taskResult = await orch.runTask(COMPLEX_TASK);

    const duration = Date.now() - startTime;
    const completedTasks = taskResult.tasks.filter(t => t.status === 'completed');
    const failedTasks = taskResult.tasks.filter(t => t.status === 'failed');

    let totalQualityScore = 0;
    let codeCount = 0;
    let generatedCode = '';
    const usedTools = [];

    for (const task of completedTasks) {
      if (task.result?.codeBlocks?.length > 0) {
        codeCount += task.result.codeBlocks.length;
        generatedCode += task.result.codeBlocks.map(cb => cb.code).join('\n\n');
      }
      if (task.result?.quality?.qualityScore) {
        totalQualityScore += task.result.quality.qualityScore;
      }
      if (task.result?.toolName) {
        usedTools.push(task.result.toolName);
      }
    }

    const avgQualityScore = completedTasks.length > 0 ? Math.round(totalQualityScore / completedTasks.length) : 0;
    const codeLines = generatedCode.split('\n').length;

    console.log('✅ 任务完成');
    console.log(`⏱️  耗时: ${(duration / 1000).toFixed(2)}秒`);
    console.log(`📊 完成任务: ${completedTasks.length}个`);
    console.log(`❌ 失败任务: ${failedTasks.length}个`);
    console.log(`🛠️  使用工具: ${usedTools.length > 0 ? [...new Set(usedTools)].join(', ') : 'AI Provider'}`);
    console.log(`📄 代码产出: ${codeCount}个代码块，${codeLines}行代码`);
    console.log(`📈 平均质量评分: ${avgQualityScore}分`);

    return {
      name,
      duration,
      completedTasks: completedTasks.length,
      failedTasks: failedTasks.length,
      usedTools: [...new Set(usedTools)],
      codeBlocks: codeCount,
      codeLines,
      avgQualityScore,
      success: true
    };
  } catch (e) {
    console.log(`❌ 任务失败: ${e.message}`);
    return {
      name,
      duration: Date.now() - startTime,
      completedTasks: 0,
      failedTasks: 0,
      usedTools: [],
      codeBlocks: 0,
      codeLines: 0,
      avgQualityScore: 0,
      success: false,
      error: e.message
    };
  }
}

async function main () {
  console.log('\n🚀 质量对比测试 - DeepSeek');
  console.log('='.repeat(60));
  console.log(`测试任务: ${COMPLEX_TASK.substring(0, 80)}...`);

  const results = [];

  console.log('\n【测试1】纯AI Provider模式');
  console.log('描述: 不使用任何工具，直接调用DeepSeek生成代码');
  results.push(await runTest('纯AI Provider模式', null, 'privacy'));

  console.log('\n【测试2】单工具模式 - AtomCode');
  console.log('描述: 只使用AtomCode生成代码');
  results.push(await runTest('单工具模式 - AtomCode', a => a.name === 'atom-code', 'privacy'));

  console.log('\n【测试3】单工具模式 - OpenClaw');
  console.log('描述: 只使用OpenClaw生成代码');
  results.push(await runTest('单工具模式 - OpenClaw', a => a.name === 'openclaw', 'privacy'));

  console.log('\n【测试4】双工具模式 - OpenClaw + AtomCode');
  console.log('描述: 同时使用OpenClaw和AtomCode，系统自动路由和合并');
  results.push(await runTest('双工具模式 - OpenClaw + AtomCode', a => ['openclaw', 'atom-code'].includes(a.name), 'quality'));

  console.log('\n' + '='.repeat(60));
  console.log('📊 对比测试报告');
  console.log('='.repeat(60));

  console.log('\n' + '| 测试模式 | 耗时(秒) | 完成任务 | 代码块 | 代码行数 | 质量评分 | 使用工具 |');
  console.log('|----------|----------|----------|--------|----------|----------|----------|');

  for (const r of results) {
    console.log(`| ${r.name} | ${(r.duration / 1000).toFixed(2)} | ${r.completedTasks} | ${r.codeBlocks} | ${r.codeLines} | ${r.avgQualityScore} | ${r.usedTools.join(', ') || 'AI'} |`);
  }

  console.log('\n📈 分析结论:');
  const toolResults = results.filter(r => r.usedTools.length > 0);
  const aiResult = results.find(r => r.usedTools.length === 0);

  if (aiResult && toolResults.length > 0) {
    const bestToolResult = toolResults.reduce((best, curr) => curr.avgQualityScore > best.avgQualityScore ? curr : best);
    const avgToolScore = Math.round(toolResults.reduce((sum, r) => sum + r.avgQualityScore, 0) / toolResults.length);

    console.log(`  - 纯AI模式质量评分: ${aiResult.avgQualityScore}分`);
    console.log(`  - 工具模式平均质量评分: ${avgToolScore}分`);
    console.log(`  - 最佳工具模式: ${bestToolResult.name}，评分: ${bestToolResult.avgQualityScore}分`);

    const improvement = avgToolScore - aiResult.avgQualityScore;
    if (improvement > 0) {
      console.log(`  ✅ 工具模式比纯AI模式质量提升: ${improvement}分 (${((improvement / aiResult.avgQualityScore) * 100).toFixed(1)}%)`);
    } else if (improvement < 0) {
      console.log(`  ❌ 工具模式比纯AI模式质量下降: ${Math.abs(improvement)}分`);
    } else {
      console.log('  ⚠️ 工具模式与纯AI模式质量持平');
    }
  }

  console.log('\n' + '='.repeat(60));
}

main().catch(e => {
  console.error('对比测试失败:', e);
  process.exit(1);
});
