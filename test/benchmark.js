#!/usr/bin/env node
/**
 * Benchmark:单模型 vs Qidi 多模型编排
 * 运行: node test/benchmark.js
 * 需 Ollama 运行 qwen2.5:7b
 */
const OllamaProvider = require('../src/providers/OllamaProvider');
const TaskOrchestrator = require('../src/core/TaskOrchestrator');

const TASKS = [
  { id: 'fib', desc: '用Python写一个返回斐波那契数列第n项的函数', test: (code) => /def.*fib/.test(code) },
  { id: 'quicksort', desc: '用Python实现快速排序', test: (code) => /def.*sort|def.*partition/.test(code) },
  { id: 'todo', desc: '用Python写一个命令行 Todo 应用,支持增删查', test: (code) => /add|delete|list/i.test(code) },
  { id: 'webserver', desc: '用Python写一个返回Hello World的Web服务器', test: (code) => /http|server|flask/i.test(code) },
  { id: 'calculator', desc: '用Python写一个支持加减乘除的计算器类', test: (code) => /class.*Calculator|def.*add|def.*divide/.test(code) }
];

async function runSingle(task) {
  const provider = new OllamaProvider({ baseURL: 'http://localhost:11434', model: 'qwen2.5:7b' });
  const orch = new TaskOrchestrator(provider, {
    workspaceDir: `./test_tmp/bench_single_${task.id}`,
    executionMode: 'privacy',
    enableCache: false,
    maxRetries: 0
  });
  await orch.initialize();
  const result = await orch.runTask(task.desc);
  const hasCode = result.tasks.some(t => t.result?.codeBlocks?.length > 0);
  const qualityScores = result.tasks.map(t => t.result?.quality?.qualityScore).filter(s => s != null);
  const avgScore = qualityScores.length ? Math.round(qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length) : 0;
  return { hasCode, avgScore, success: result.successRate >= 60 };
}

async function runMulti(task, providers) {
  const orch = new TaskOrchestrator(providers[0], {
    workspaceDir: `./test_tmp/bench_multi_${task.id}`,
    executionMode: 'multi',
    providers,
    enableCache: false,
    maxRetries: 0
  });
  await orch.initialize();
  const result = await orch.runTask(task.desc);
  const hasCode = result.tasks.some(t => t.result?.codeBlocks?.length > 0);
  const qualityScores = result.tasks.map(t => t.result?.quality?.qualityScore).filter(s => s != null);
  const avgScore = qualityScores.length ? Math.round(qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length) : 0;
  return { hasCode, avgScore, success: result.successRate >= 60 };
}

async function main() {
  const provider = new OllamaProvider({ baseURL: 'http://localhost:11434', model: 'qwen2.5:7b' });
  if (!await provider.checkConnection()) {
    console.log('⏭️  Ollama 不可用,跳过 benchmark');
    process.exit(0);
  }

  let providers = [provider];
  try {
    const AgentHub = require('../src/core/AgentHub');
    const hub = new AgentHub({ configDir: './config' });
    await hub.initialize();
    const enabled = hub.getEnabledAgents().map(a => a.provider).filter(Boolean);
    if (enabled.length >= 2) providers = enabled;
  } catch (e) {}

  console.log(`\n📊 Benchmark: ${TASKS.length} 个任务, ${providers.length} 个 Provider\n`);
  const results = [];
  for (const task of TASKS) {
    console.log(`━━━ ${task.id}: ${task.desc.substring(0, 30)}... ━━━`);
    const single = await runSingle(task);
    console.log(`  单模型: ${single.success ? '✅' : '❌'} ${single.avgScore}分`);
    let multi = { success: false, avgScore: 0, skipped: true };
    if (providers.length >= 2) {
      multi = await runMulti(task, providers);
      console.log(`  Qidi multi: ${multi.success ? '✅' : '❌'} ${multi.avgScore}分`);
    } else {
      console.log(`  Qidi multi: ⏭️ 跳过(仅1个Provider)`);
    }
    results.push({ task: task.id, single, multi });
  }

  const singlePass = results.filter(r => r.single.success).length;
  const multiPass = results.filter(r => !r.multi.skipped && r.multi.success).length;
  const multiTotal = results.filter(r => !r.multi.skipped).length;
  console.log(`\n━━━ 汇总 ━━━`);
  console.log(`单模型通过率: ${singlePass}/${TASKS.length} (${Math.round(singlePass / TASKS.length * 100)}%)`);
  if (multiTotal > 0) {
    console.log(`Qidi multi通过率: ${multiPass}/${multiTotal} (${Math.round(multiPass / multiTotal * 100)}%)`);
  }
  console.log(`\n📝 结果已保存,请填入 docs/BENCHMARK.md`);
}
main().catch(e => { console.error(e); process.exit(1); });