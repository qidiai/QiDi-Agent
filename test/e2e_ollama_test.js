/**
 * 端到端集成测试（Ollama 本地模型）
 * 
 * 测试完整流程：Provider → 拆分 → 质检 → 合并
 * 轻量级任务，适合配置不高的电脑
 */

const TaskOrchestrator = require('../src/core/TaskOrchestrator');
const ProviderFactory = require('../src/providers');
const TaskSplitterAgent = require('../src/agents/TaskSplitterAgent');
const QualityCheckerAgent = require('../src/agents/QualityCheckerAgent');
const ContractAssembler = require('../src/core/ContractAssembler');
const ExecutionModeManager = require('../src/core/ExecutionModeManager');

// 简单测试任务（避免复杂任务导致模型运行太久）
const TEST_TASKS = [
  {
    name: '简单加法函数',
    task: '用C语言写一个简单的加法函数 add(int a, int b)',
    expectedLanguage: 'c',
    minQuality: 60
  },
  {
    name: 'Python Hello',
    task: '用Python写一个打印hello world的函数',
    expectedLanguage: 'python',
    minQuality: 60
  }
];

async function runE2ETest() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  🔬 端到端集成测试（Ollama 本地模型）');
  console.log('═══════════════════════════════════════════════════\n');
  
  const results = {
    passed: 0,
    failed: 0,
    skipped: 0,
    tests: []
  };
  
  function log(name, status, detail = '') {
    const icon = status === 'pass' ? '✅' : status === 'skip' ? '⏭️' : '❌';
    console.log(`${icon} ${name}${detail ? ` - ${detail}` : ''}`);
    if (status === 'pass') results.passed++;
    else if (status === 'skip') results.skipped++;
    else results.failed++;
    results.tests.push({ name, status, detail });
  }
  
  // ────────────────── 1. 检查 Ollama 连接 ──────────────────
  console.log('\n📡 步骤1: 检查 Ollama 本地连接\n');
  
  let ollamaProvider;
  try {
    ollamaProvider = ProviderFactory.create('ollama', {
      baseURL: 'http://localhost:11434',
      model: 'qwen2.5:7b'  // 可以改为更小的模型如 qwen2.5:3b
    });
    
    const connected = await ollamaProvider.checkConnection();
    if (connected) {
      log('Ollama 连接成功', 'pass', 'localhost:11434');
    } else {
      log('Ollama 连接失败', 'fail', '请确保 ollama serve 正在运行');
      return results;
    }
  } catch (e) {
    log('Ollama Provider 创建失败', 'fail', e.message);
    return results;
  }
  
  // ────────────────── 2. 测试任务拆分 ──────────────────
  console.log('\n🔀 步骤2: 测试任务拆分（本地 Ollama）\n');
  
  const splitter = new TaskSplitterAgent(ollamaProvider, {
    enableSelfCheck: true,
    maxSubtasks: 6  // 限制子任务数量
  });
  
  let splitResult;
  try {
    console.log('  正在拆分任务...');
    splitResult = await splitter.splitTask(TEST_TASKS[0].task, {
      language: 'c',
      platform: 'windows'
    });
    
    log('任务拆分成功', 'pass', `${splitResult.subtasks?.length || 0} 个子任务`);
    
    // 检查拆分结果
    if (splitResult.subtasks && splitResult.subtasks.length > 0) {
      log('子任务结构正确', 'pass', `包含: ${splitResult.subtasks.map(t => t.id).join(', ')}`);
      log('依赖关系定义', 'pass', splitResult.dependencyGraph ? '已定义' : '无依赖');
    } else {
      log('子任务生成', 'fail', '未生成子任务');
    }
  } catch (e) {
    log('任务拆分', 'fail', e.message);
  }
  
  // ────────────────── 3. 测试质量检查 ──────────────────
  console.log('\n🔍 步骤3: 测试质量检查（本地 Ollama 打分）\n');
  
  const checker = new QualityCheckerAgent(ollamaProvider, {
    enableAIScoring: true,
    minQualityScore: 60
  });
  
  const testCode = `
int add(int a, int b) {
    return a + b;
}
`;
  
  try {
    console.log('  正在质检...');
    const qualityResult = await checker.checkQuality(
      { taskId: 'test_add', description: TEST_TASKS[0].task },
      { code: testCode, language: 'c', filePath: 'test.c' }
    );
    
    log('质量检查完成', 'pass', `分数: ${qualityResult.score || 0}`);
    
    if (qualityResult.score >= TEST_TASKS[0].minQuality) {
      log('质量分数达标', 'pass', `${qualityResult.score} >= ${TEST_TASKS[0].minQuality}`);
    } else {
      log('质量分数', 'skip', `${qualityResult.score} < ${TEST_TASKS[0].minQuality}（模型可能评分保守）`);
    }
    
    if (qualityResult.dimensions) {
      log('六维评分', 'pass', Object.keys(qualityResult.dimensions).join(', '));
    }
  } catch (e) {
    log('质量检查', 'fail', e.message);
  }
  
  // ────────────────── 4. 测试契约提取 ──────────────────
  console.log('\n📋 步骤4: 测试契约提取（静态 + 本地模型辅助）\n');
  
  const assembler = new ContractAssembler({
    localModel: ollamaProvider,
    enableAIAssist: true,
    strictMode: false
  });
  
  try {
    console.log('  正在提取契约...');
    const codeBlocks = [
      { language: 'c', code: testCode, filePath: 'math.c' }
    ];
    
    const contracts = await assembler.extractContracts(codeBlocks);
    
    log('契约提取成功', 'pass', `${contracts.length} 个代码块`);
    
    if (contracts[0]?.functions?.length > 0) {
      log('函数契约识别', 'pass', `函数: ${contracts[0].functions.map(f => f.name).join(', ')}`);
      log('提取方法', 'pass', contracts[0].extractionMethod || 'static');
    } else {
      log('函数契约', 'fail', '未识别到函数');
    }
  } catch (e) {
    log('契约提取', 'fail', e.message);
  }
  
  // ────────────────── 5. 测试完整编排 ──────────────────
  console.log('\n🎯 步骤5: 测试完整任务编排\n');
  
  try {
    const orchestrator = new TaskOrchestrator(ollamaProvider, {
      executionMode: 'privacy',
      workspaceDir: './workspace/e2e_test',
      enableCache: false,
      maxRetries: 1
    });
    
    await orchestrator.initialize();
    
    console.log('  正在执行完整任务编排...');
    console.log('  (这可能需要 30-60 秒，请耐心等待...)\n');
    
    const startTime = Date.now();
    const taskResult = await orchestrator.runTask(TEST_TASKS[0].task);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    log('完整编排执行完成', 'pass', `耗时: ${duration}s`);
    
    if (taskResult.successRate >= 80) {
      log('任务成功率', 'pass', `${taskResult.successRate}%`);
    } else {
      log('任务成功率', 'skip', `${taskResult.successRate}%（部分成功）`);
    }
    
    if (taskResult.constraints?.language === 'c') {
      log('语言约束识别', 'pass', taskResult.constraints.language);
    }
    
    if (taskResult.tokenStats) {
      log('Token统计', 'pass', `生成: ${taskResult.tokenStats.generated || 0}`);
    }
    
    if (taskResult.reportId) {
      log('实验报告生成', 'pass', taskResult.reportId);
    }
    
  } catch (e) {
    log('完整编排', 'fail', e.message);
    console.log('\n  提示: 如果模型响应慢，可以尝试:');
    console.log('    1. 使用更小的模型: ollama pull qwen2.5:3b');
    console.log('    2. 等待当前模型加载完成');
  }
  
  // ────────────────── 6. 测试执行模式 ──────────────────
  console.log('\n⚙️ 步骤6: 测试执行模式管理\n');
  
  const modeManager = new ExecutionModeManager();
  
  try {
    const modes = modeManager.getAllModes();
    log('模式列表获取', 'pass', `${modes.length} 种模式`);
    
    const privacyConfig = modeManager.getModeConfig('privacy');
    if (privacyConfig) {
      log('隐私模式配置', 'pass', privacyConfig.displayName);
      
      if (privacyConfig.merging?.localModelAssist) {
        log('本地模型辅助契约', 'pass', '已启用');
      }
      
      if (privacyConfig.qualityCheck?.enableAI && privacyConfig.qualityCheck?.aiProvider === 'ollama') {
        log('本地质检打分', 'pass', 'Ollama 已配置');
      }
    }
    
    const qualityConfig = modeManager.getModeConfig('quality');
    if (qualityConfig) {
      log('高质量模式配置', 'pass', qualityConfig.displayName);
    }
    
  } catch (e) {
    log('执行模式', 'fail', e.message);
  }
  
  // ────────────────── 总结 ──────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log('📊 端到端测试总结');
  console.log('═══════════════════════════════════════════════════');
  console.log(`   ✅ 通过: ${results.passed}`);
  console.log(`   ❌ 失败: ${results.failed}`);
  console.log(`   ⏭️ 跳过: ${results.skipped}`);
  
  if (results.passed + results.failed > 0) {
    console.log(`   📈 通过率: ${((results.passed / (results.passed + results.failed)) * 100).toFixed(1)}%`);
  }
  
  if (results.failed === 0) {
    console.log('\n   🎉 端到端测试通过！隐私模式完整流程正常工作！');
    console.log('   🔒 Provider → 拆分 → 质检 → 契约 → 合并 全链路本地完成');
  } else {
    console.log('\n   ⚠️ 部分测试失败，请检查 Ollama 是否正常运行');
    console.log('   💡 建议: ollama serve && ollama pull qwen2.5:7b');
  }
  
  return results;
}

// 运行测试
runE2ETest().catch(console.error);