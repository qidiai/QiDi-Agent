#!/usr/bin/env node
const OllamaProvider = require('../src/providers/OllamaProvider');
const TaskOrchestrator = require('../src/core/TaskOrchestrator');

async function main () {
  const provider = new OllamaProvider({ baseURL: 'http://localhost:11434', model: 'qwen2.5:7b' });
  let connected;
  try {
    connected = await provider.checkConnection();
  } catch (e) {
    connected = false;
  }
  if (!connected) {
    console.log('⏭️  Ollama 不可用,跳过真机 e2e 测试');
    process.exit(0);
  }
  console.log('✅ Ollama 连接成功,开始真机 e2e 测试\n');

  const results = { passed: 0, failed: 0 };

  function assert (name, condition, detail = '') {
    if (condition) {
      results.passed++; console.log(`  ✅ ${name}`);
    } else {
      results.failed++; console.log(`  ❌ ${name} ${detail}`);
    }
  }

  console.log('━━━ 测试1: privacy 模式 简单任务 ━━━');
  try {
    const orch = new TaskOrchestrator(provider, {
      workspaceDir: './test_tmp/e2e_privacy',
      executionMode: 'privacy',
      enableCache: false,
      maxRetries: 1
    });
    await orch.initialize();
    const result = await orch.runTask('用Python写一个函数,返回两个数的和');

    assert('任务完成', result.completedTasks >= 1);
    assert('有代码产出', result.tasks.some(t => t.result?.codeBlocks?.length > 0));
    assert('质检执行', result.tasks.some(t => t.result?.quality?.toolResults));
    assert('报告生成', !!result.reportId);
  } catch (e) {
    assert('privacy 模式不抛异常', false, e.message);
  }

  console.log('\n━━━ 测试2: multi 模式 多Provider ━━━');
  try {
    const AgentHub = require('../src/core/AgentHub');
    const hub = new AgentHub({ configDir: './config' });
    await hub.initialize();
    const enabled = hub.getEnabledAgents();
    const providers = enabled.map(a => a.provider).filter(Boolean);

    if (providers.length < 2) {
      console.log('  ⏭️  启用的 Provider 不足 2 个,跳过 multi 测试');
    } else {
      const orch = new TaskOrchestrator(providers[0], {
        workspaceDir: './test_tmp/e2e_multi',
        executionMode: 'multi',
        providers,
        enableCache: false,
        maxRetries: 1
      });
      await orch.initialize();
      const result = await orch.runTask('用Python写一个hello world');

      assert('multi 任务完成', result.completedTasks >= 1);
      assert('multi 模式生效', orch.multiProviderMode === true);
    }
  } catch (e) {
    assert('multi 模式不抛异常', false, e.message);
  }

  console.log(`\n━━━ 真机 e2e 结果: ${results.passed} 通过, ${results.failed} 失败 ━━━`);
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e); process.exit(1);
});
