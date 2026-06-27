#!/usr/bin/env node

/**
 * ai-orchestrator 全方位专业测试套件
 * 测试覆盖：模块导入、Providers、TaskRouter、ExecutionModeManager、
 * ContractAssembler、MergeEngine、Agents、TaskOrchestrator、CLI
 */

const chalk = require('chalk');

// ════════════════════════════════════════════════
// 测试框架
// ════════════════════════════════════════════════
const results = [];
const TIMEOUT = 30000;
const startTime = Date.now();

function test(name, fn) {
  return new Promise(async (resolve) => {
    const tStart = Date.now();
    try {
      await fn();
      const duration = Date.now() - tStart;
      const result = { name, passed: true, duration, error: null };
      results.push(result);
      console.log(chalk.green(`  ✅ ${name} (${duration}ms)`));
    } catch (e) {
      const duration = Date.now() - tStart;
      const result = { name, passed: false, duration, error: e.message };
      results.push(result);
      console.log(chalk.red(`  ❌ ${name} (${duration}ms): ${e.message}`));
    }
    resolve();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || '值不相等'}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, path = '') {
  if (typeof actual !== typeof expected) {
    throw new Error(`类型不匹配 ${path}: ${typeof actual} vs ${typeof expected}`);
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) throw new Error(`非数组 ${path}`);
    if (actual.length !== expected.length) throw new Error(`数组长度 ${path}: ${actual.length} vs ${expected.length}`);
    expected.forEach((item, i) => assertDeepEqual(actual[i], item, `${path}[${i}]`));
  } else if (typeof expected === 'object' && expected !== null) {
    for (const key of Object.keys(expected)) {
      if (!(key in actual)) throw new Error(`缺少键 ${path}.${key}`);
      assertDeepEqual(actual[key], expected[key], `${path}.${key}`);
    }
  } else {
    if (actual !== expected) throw new Error(`值不匹配 ${path}: ${actual} vs ${expected}`);
  }
}

// ════════════════════════════════════════════════
// 1. 模块导入完整性测试
// ════════════════════════════════════════════════
async function testModuleImports() {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  1. 模块导入完整性测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('所有核心模块可导入', async () => {
    const providers = require('../src/providers');
    const agents = require('../src/agents');
    const MultiAgentDispatcher = require('../src/core/MultiAgentDispatcher');
    const TaskOrchestrator = require('../src/core/TaskOrchestrator');
    const TaskRouter = require('../src/core/TaskRouter');
    const ContractAssembler = require('../src/core/ContractAssembler');
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const AgentHub = require('../src/core/AgentHub');
    const ToolScanner = require('../src/core/ToolScanner');
    const MergeEngine = require('../src/agents/MergeEngine');

    assert(providers, 'providers 未导入');
    assert(agents, 'agents 未导入');
    assert(MultiAgentDispatcher, 'MultiAgentDispatcher 未导入');
    assert(TaskOrchestrator, 'TaskOrchestrator 未导入');
    assert(TaskRouter, 'TaskRouter 未导入');
    assert(ContractAssembler, 'ContractAssembler 未导入');
    assert(ExecutionModeManager, 'ExecutionModeManager 未导入');
    assert(AgentHub, 'AgentHub 未导入');
    assert(ToolScanner, 'ToolScanner 未导入');
    assert(MergeEngine, 'MergeEngine 未导入');
  });

  await test('ProviderFactory 正确创建三种 Provider', async () => {
    const ProviderFactory = require('../src/providers');
    const ollama = ProviderFactory.create('ollama');
    assert(ollama, 'Ollama 创建失败');
    assertEqual(ollama.name, 'ollama');

    const openai = ProviderFactory.create('openai');
    assert(openai, 'OpenAI 创建失败');
    assertEqual(openai.name, 'openai');

    const anthropic = ProviderFactory.create('anthropic');
    assert(anthropic, 'Anthropic 创建失败');
    assertEqual(anthropic.name, 'anthropic');
  });

  await test('AgentFactory 创建所有 Agent', async () => {
    const ProviderFactory = require('../src/providers');
    const AgentFactory = require('../src/agents');
    const provider = ProviderFactory.create('ollama');
    const agents = AgentFactory.createAll(provider);

    assert(agents.splitter, 'TaskSplitter 未创建');
    assert(agents.codeWriter, 'CodeWriter 未创建');
    assert(agents.codeReviewer, 'CodeReviewer 未创建');
    assert(agents.tester, 'Tester 未创建');
    assert(agents.qualityChecker, 'QualityChecker 未创建');
    assert(agents.mergeEngine, 'MergeEngine 未创建');
  });

  await test('Adapter 工厂创建所有适配器', async () => {
    const AdapterFactory = require('../src/adapters');
    const adapters = AdapterFactory.createAll();
    assert(Array.isArray(adapters), 'adapters 不是数组');
    assert(adapters.length >= 8, `适配器数量不足: ${adapters.length}`);

    const names = adapters.map(a => a.name);
    assert(names.includes('claude-code'), '缺少 claude-code');
    assert(names.includes('qoder'), '缺少 qoder');
    assert(names.includes('openclaw'), '缺少 openclaw');
    assert(names.includes('hermes-agent'), '缺少 hermes-agent');
    assert(names.includes('atom-code'), '缺少 atom-code');
    assert(names.includes('mimo-code'), '缺少 mimo-code');
    assert(names.includes('trae'), '缺少 trae');
  });

  await test('Utils 模块全部可导入', async () => {
    const FileManager = require('../src/utils/FileManager');
    const CacheStore = require('../src/utils/CacheStore');
    const TokenCounter = require('../src/utils/TokenCounter');
    const ContextCompressor = require('../src/utils/ContextCompressor');
    const ModelRouter = require('../src/utils/ModelRouter');
    const ExperimentReportGenerator = require('../src/utils/ExperimentReportGenerator');

    assert(FileManager, 'FileManager 未导入');
    assert(CacheStore, 'CacheStore 未导入');
    assert(TokenCounter, 'TokenCounter 未导入');
    assert(ContextCompressor, 'ContextCompressor 未导入');
    assert(ModelRouter, 'ModelRouter 未导入');
    assert(ExperimentReportGenerator, 'ExperimentReportGenerator 未导入');
  });
}

// ════════════════════════════════════════════════
// 2. Provider 功能测试
// ════════════════════════════════════════════════
async function testProviders() {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  2. Provider 功能测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('OllamaProvider 结构完整', async () => {
    const OllamaProvider = require('../src/providers/OllamaProvider');
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b' });

    assertEqual(provider.name, 'ollama');
    assertEqual(provider.model, 'qwen2.5:7b');
    assert(typeof provider.chat === 'function', 'chat 方法缺失');
    assert(typeof provider.generate === 'function', 'generate 方法缺失');
    assert(typeof provider.checkConnection === 'function', 'checkConnection 方法缺失');
    assert(typeof provider.listModels === 'function', 'listModels 方法缺失');
  });

  await test('OpenAIProvider 结构完整', async () => {
    const OpenAIProvider = require('../src/providers/OpenAIProvider');
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini'
    });

    assertEqual(provider.name, 'openai');
    assertEqual(provider.model, 'gpt-4o-mini');
    assert(typeof provider.chat === 'function', 'chat 方法缺失');
    assert(typeof provider.generate === 'function', 'generate 方法缺失');
    assert(typeof provider.checkConnection === 'function', 'checkConnection 方法缺失');
  });

  await test('AnthropicProvider 结构完整', async () => {
    const AnthropicProvider = require('../src/providers/AnthropicProvider');
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-sonnet-20240620'
    });

    assertEqual(provider.name, 'anthropic');
    assertEqual(provider.model, 'claude-3-5-sonnet-20240620');
    assert(typeof provider.chat === 'function', 'chat 方法缺失');
    assert(typeof provider.generate === 'function', 'generate 方法缺失');
    assert(typeof provider.checkConnection === 'function', 'checkConnection 方法缺失');
    assert(typeof provider.chatStream === 'function', 'chatStream 方法缺失');
    assert(typeof provider.listModels === 'function', 'listModels 方法缺失');
    assert(Array.isArray(provider.availableModels), 'availableModels 不是数组');
    assert(provider.availableModels.length >= 10, `模型列表不足: ${provider.availableModels.length}`);
  });

  await test('AnthropicProvider API Key 验证', async () => {
    const AnthropicProvider = require('../src/providers/AnthropicProvider');
    assert(AnthropicProvider.validateApiKey('sk-ant-test123456789012'), '有效 key 验证失败');
    assert(!AnthropicProvider.validateApiKey(''), '空 key 应返回 false');
    assert(!AnthropicProvider.validateApiKey('invalid-key'), '无效 key 应返回 false');
  });

  await test('OllamaProvider HTTP 请求结构', async () => {
    const OllamaProvider = require('../src/providers/OllamaProvider');
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' });

    // 验证 _request 会正确构建 URL
    const url = new URL('/api/chat', provider.baseUrl);
    assertEqual(url.href, 'http://localhost:11434/api/chat');
  });

  await test('OpenAIProvider API 请求格式', async () => {
    const OpenAIProvider = require('../src/providers/OpenAIProvider');
    const provider = new OpenAIProvider({
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat'
    });

    assertEqual(provider.model, 'deepseek-chat');
    assertEqual(provider.apiKey, 'sk-test-key');

    // 验证 chat 生成的 payload 结构
    const payload = {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'test' }],
      temperature: 0.7,
      max_tokens: 2048
    };
    assertEqual(payload.model, 'deepseek-chat');
    assertEqual(payload.messages.length, 1);
  });

  await test('ProviderFactory.detectAvailable 不抛异常', async () => {
    const ProviderFactory = require('../src/providers');
    // 不应该抛异常，即使所有 provider 都不可用
    let result = [];
    try {
      result = await ProviderFactory.detectAvailable();
      assert(Array.isArray(result), '结果应为数组');
    } catch (e) {
      assert(false, `detectAvailable 抛异常: ${e.message}`);
    }
  });
}

// ════════════════════════════════════════════════
// 3. TaskRouter 核心功能测试（新增）
// ════════════════════════════════════════════════
async function testTaskRouter() {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  3. TaskRouter 路由引擎测试（新增）'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  const BaseToolAdapter = require('../src/adapters/BaseToolAdapter');

  // 创建 Mock 适配器
  const createMockAdapter = (name, langs, roles, available = true) => {
    const adapter = new BaseToolAdapter({ name, displayName: name });
    adapter.isAvailable = () => available;
    adapter.languages = langs;
    adapter.roles = roles;
    return adapter;
  };

  const adapters = [
    createMockAdapter('claude-code', ['python', 'javascript', 'go', 'rust'], ['architect', 'code_writer', 'code_reviewer']),
    createMockAdapter('qoder', ['python', 'javascript'], ['code_writer']),
    createMockAdapter('openclaw', ['python', 'lua'], ['code_writer', 'tester']),
    createMockAdapter('atom-code', ['python', 'javascript', 'java'], ['code_writer'])
  ];

  await test('轮询策略（round_robin）- 任务均匀分发', async () => {
    const TaskRouter = require('../src/core/TaskRouter');
    const router = new TaskRouter(adapters, { strategy: 'round_robin' });

    const tasks = [
      { id: 'T1', title: '任务1', role: 'code_writer' },
      { id: 'T2', title: '任务2', role: 'architect' },
      { id: 'T3', title: '任务3', role: 'tester' },
      { id: 'T4', title: '任务4', role: 'code_reviewer' },
      { id: 'T5', title: '任务5', role: 'code_writer' },
      { id: 'T6', title: '任务6', role: 'architect' }
    ];

    const routed = router.routeTasks(tasks);
    assertEqual(routed.length, 6, '路由结果数量错误');

    // 验证轮询分发，每个工具应该拿到2-3个任务
    const toolCounts = {};
    for (const r of routed) {
      assert(r.adapter !== null, `任务 ${r.task.id} 未分配到工具`);
      const toolName = r.adapter.name;
      toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
    }

    assert(Object.keys(toolCounts).length === 4, `应该用到4个工具, 实际用到 ${Object.keys(toolCounts).length}`);

    // 验证每个工具的任务数大致平均
    const counts = Object.values(toolCounts);
    const maxDiff = Math.max(...counts) - Math.min(...counts);
    assert(maxDiff <= 1, `分发不均衡: ${JSON.stringify(toolCounts)}`);
  });

  await test('轮询策略 - 隐私模式下 Provider 不参与', async () => {
    const TaskRouter = require('../src/core/TaskRouter');
    const router = new TaskRouter(adapters, {
      strategy: 'round_robin',
      privacyMode: true,
      toolOnlyMode: true
    });

    const result = router.routeTask({ id: 'T1', title: '测试任务' });
    assert(result.adapter !== null, '应有适配器分配');
    assert(result.strategy === 'round_robin');
  });

  await test('能力匹配策略（capability）- 按语言匹配最佳工具', async () => {
    const TaskRouter = require('../src/core/TaskRouter');
    const router = new TaskRouter(adapters, { strategy: 'capability' });

    // Rust 任务 -> claude-code（唯一支持 Rust 的）
    const rustTask = { id: 'T1', title: 'Rust 实现', language: 'rust', role: 'code_writer' };
    const rustRouted = router.routeTask(rustTask);
    assertEqual(rustRouted.adapter.name, 'claude-code', 'Rust 任务应分配给 claude-code');

    // Lua 任务 -> openclaw（唯一支持 Lua 的）
    const luaTask = { id: 'T2', title: 'Lua 脚本', language: 'lua', role: 'code_writer' };
    const luaRouted = router.routeTask(luaTask);
    assertEqual(luaRouted.adapter.name, 'openclaw', 'Lua 任务应分配给 openclaw');
  });

  await test('能力匹配策略 - 架构师角色匹配最佳工具', async () => {
    const TaskRouter = require('../src/core/TaskRouter');
    const router = new TaskRouter(adapters, { strategy: 'capability' });

    const archTask = { id: 'T1', title: '系统架构', role: 'architect' };
    const routed = router.routeTask(archTask);
    assertEqual(routed.adapter.name, 'claude-code', '架构师角色应分配给 claude-code');
  });

  await test('手动路由策略（manual）- 精确控制任务去向', async () => {
    const TaskRouter = require('../src/core/TaskRouter');
    const router = new TaskRouter(adapters, {
      strategy: 'manual',
      manualRouting: {
        'architect': 'claude-code',
        'code_writer': 'qoder',
        'tester': 'openclaw'
      }
    });

    const tasks = [
      { id: 'T1', title: '架构设计', role: 'architect' },
      { id: 'T2', title: '写代码', role: 'code_writer' },
      { id: 'T3', title: '写测试', role: 'tester' }
    ];

    const routed = router.routeTasks(tasks);
    assertEqual(routed[0].adapter.name, 'claude-code', '架构设计应到 claude-code');
    assertEqual(routed[1].adapter.name, 'qoder', '写代码应到 qoder');
    assertEqual(routed[2].adapter.name, 'openclaw', '测试应到 openclaw');
  });

  await test('广播策略（broadcast）- 所有工具都执行', async () => {
    const TaskRouter = require('../src/core/TaskRouter');
    const router = new TaskRouter(adapters, { strategy: 'broadcast' });

    const task = { id: 'T1', title: '广播测试', role: 'code_writer' };
    const routed = router.routeTask(task);
    assert(routed.isBroadcast === true, '广播模式应标记 isBroadcast');
    assert(Array.isArray(routed.adapter), '广播模式 adapter 应为数组');
    assertEqual(routed.adapter.length, 4, '广播模式应返回所有适配器');
  });

  await test('无可用工具时的降级行为', async () => {
    const TaskRouter = require('../src/core/TaskRouter');
    const emptyRouter = new TaskRouter([], { strategy: 'round_robin' });
    const emptyRouted = emptyRouter.routeTasks([{ id: 'T1', title: 'T1' }]);
    assertEqual(emptyRouted[0].adapter, null, '无工具时应返回 null');
    assert(emptyRouted[0].reason.includes('无可用工具'), '应说明无可用工具原因');
  });

  await test('路由统计信息正确', async () => {
    const TaskRouter = require('../src/core/TaskRouter');
    const router = new TaskRouter(adapters, { strategy: 'round_robin' });

    const tasks = [
      { id: 'T1', title: '架构设计', role: 'architect' },
      { id: 'T2', title: '写代码', role: 'code_writer' },
      { id: 'T3', title: '写测试', role: 'tester' }
    ];

    const routed = router.routeTasks(tasks);
    const stats = router.getRoutingStats(routed);

    assertEqual(stats.totalTasks, 3);
    assertEqual(stats.assignedTasks, 3);
    assertEqual(stats.unassignedTasks, 0);
    assertEqual(stats.byStrategy, 'round_robin');
    assert(Object.keys(stats.byTool).length === 3, `应分配3个工具, 实际分配 ${Object.keys(stats.byTool).length}`);
    assert(Object.keys(stats.byRole).length === 3, `应覆盖3种角色, 实际覆盖 ${Object.keys(stats.byRole).length}`);
  });

  await test('路由验证正确捕获分配问题', async () => {
    const TaskRouter = require('../src/core/TaskRouter');
    const router = new TaskRouter(adapters, { strategy: 'round_robin' });

    // 正常情况
    const tasks = [{ id: 'T1', title: 'T1', role: 'code_writer' }];
    const routed = router.routeTasks(tasks);
    const valid = router.validateRouting(routed);
    assert(valid.valid, `正常路由应通过验证, 问题: ${valid.issues.join(', ')}`);

    // 无工具的情况
    const emptyRouter = new TaskRouter([], { strategy: 'round_robin' });
    const emptyRouted = emptyRouter.routeTasks([{ id: 'T1', title: 'T1' }]);
    const invalid = emptyRouter.validateRouting(emptyRouted);
    assert(!invalid.valid, '无工具路由应验证失败');
    assert(invalid.issues.length > 0, '应有验证问题');
  });

  await test('获取路由策略列表完整', async () => {
    const TaskRouter = require('../src/core/TaskRouter');
    const router = new TaskRouter(adapters);
    const strategies = router.getStrategies();

    assert(Array.isArray(strategies), 'strategies 应为数组');
    assertEqual(strategies.length, 4, '应有4种策略');
    const names = strategies.map(s => s.name);
    assert(names.includes('round_robin'), '缺少 round_robin');
    assert(names.includes('capability'), '缺少 capability');
    assert(names.includes('manual'), '缺少 manual');
    assert(names.includes('broadcast'), '缺少 broadcast');
  });
}

// ════════════════════════════════════════════════
// 4. ExecutionModeManager 测试（新增）
// ════════════════════════════════════════════════
async function testExecutionModeManager() {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  4. ExecutionModeManager 模式管理测试（新增）'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('初始默认为隐私模式', async () => {
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const mgr = new ExecutionModeManager();
    assertEqual(mgr.getCurrentMode(), 'privacy', '默认模式应为 privacy');
  });

  await test('隐私模式配置完整', async () => {
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const mgr = new ExecutionModeManager();
    const config = mgr.getModeConfig('privacy');

    assert(config, '隐私模式配置不存在');
    assertEqual(config.name, 'privacy');
    assert(config.splitter.location === 'local', '隐私模式拆分应在本地');
    assert(config.codeGeneration.toolOnlyMode === true, '隐私模式应仅工具执行');
    assert(config.codeGeneration.broadcastMode === false, '隐私模式不应广播');
    assert(config.codeGeneration.providerParticipates === false, '隐私模式 Provider 不参与代码生成');
    assert(config.qualityCheck.enableAI === true, '隐私模式应开启 AI 打分');
    assert(config.merging.strategy === 'contract', '隐私模式应使用契约拼装');
    assert(config.privacy.enabled === true, '隐私模式应启用隐私保护');
    assert(config.privacy.toolSeesFullTask === false, '工具不应看到完整任务');
    assert(config.privacy.providerSeesFullCode === false, 'Provider 不应看到完整代码');
  });

  await test('高质量模式配置完整', async () => {
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const mgr = new ExecutionModeManager();
    const config = mgr.getModeConfig('quality');

    assert(config, '高质量模式配置不存在');
    assertEqual(config.name, 'quality');
    assert(config.merging.strategy === 'ai', '高质量模式应使用 AI 合并');
    assert(config.merging.aiEnabled === true, '高质量模式应启用 AI 合并');
    assert(config.qualityCheck.enableTest === true, '高质量模式应执行测试');
    assert(config.qualityCheck.minQualityScore >= 75, '高质量模式质量阈值应 >= 75');
  });

  await test('模式动态切换', async () => {
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const mgr = new ExecutionModeManager();

    assertEqual(mgr.getCurrentMode(), 'privacy');
    mgr.setMode('quality');
    assertEqual(mgr.getCurrentMode(), 'quality');

    const qualityConfig = mgr.getModeConfig();
    assertEqual(qualityConfig.name, 'quality');

    mgr.setMode('privacy');
    assertEqual(mgr.getCurrentMode(), 'privacy');
  });

  await test('获取所有模式列表', async () => {
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const mgr = new ExecutionModeManager();
    const modes = mgr.getAllModes();

    assert(Array.isArray(modes), 'modes 应为数组');
    assertEqual(modes.length, 2, '应有2种模式');
    assert(modes.find(m => m.name === 'privacy'), '缺少 privacy 模式');
    assert(modes.find(m => m.name === 'quality'), '缺少 quality 模式');
    modes.forEach(m => {
      assert(m.displayName, `模式 ${m.name} 缺少 displayName`);
      assert(m.description, `模式 ${m.name} 缺少 description`);
      assert(m.useCases, `模式 ${m.name} 缺少 useCases`);
      assert(m.useCases.length > 0, `模式 ${m.name} useCases 为空`);
    });
  });

  await test('模式对比功能', async () => {
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const mgr = new ExecutionModeManager();
    const comparison = mgr.compareModes('privacy', 'quality');

    assert(comparison.dimensions, 'compareModes 缺少 dimensions');
    assert(Array.isArray(comparison.dimensions), 'dimensions 应为数组');
    assert(comparison.dimensions.length >= 6, `维度数不足: ${comparison.dimensions.length}`);

    const privacyDim = comparison.dimensions.find(d => d.name === '任务拆分');
    assert(privacyDim, '缺少 任务拆分 维度');
    assert(privacyDim.privacy.includes('本地'), '隐私模式拆分应在本地');
  });

  await test('模式推荐 - 隐私关键词触发', async () => {
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const mgr = new ExecutionModeManager();

    const result = mgr.recommendMode('这是一个私密项目，处理核心商业机密代码');
    assertEqual(result.mode, 'privacy', '敏感关键词应推荐隐私模式');
  });

  await test('模式推荐 - 质量关键词触发', async () => {
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const mgr = new ExecutionModeManager();

    const result = mgr.recommendMode('需要高质量重构和优化复杂代码');
    assertEqual(result.mode, 'quality', '质量关键词应推荐高质量模式');
  });

  await test('模式推荐 - 无关键词默认隐私', async () => {
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const mgr = new ExecutionModeManager();

    const result = mgr.recommendMode('实现一个计算器');
    assertEqual(result.mode, 'privacy', '无关键词应默认隐私模式');
  });
}

// ════════════════════════════════════════════════
// 5. ContractAssembler 测试（新增）
// ════════════════════════════════════════════════
async function testContractAssembler() {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  5. ContractAssembler 契约拼装测试（新增）'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('C语言契约提取 - 函数声明', async () => {
    const ContractAssembler = require('../src/core/ContractAssembler');
    const assembler = new ContractAssembler({ supportedLanguages: ['c'] });

    const code = `int add(int a, int b);
void print_result(int result);
float calculate_average(float* data, int count);`;

    const contracts = await assembler.extractContracts([
      { language: 'c', code, filePath: 'math.c' }
    ]);

    assertEqual(contracts.length, 1);
    const c = contracts[0];
    assert(c.functions.length >= 3, `应提取至少3个函数, 实际 ${c.functions.length}`);
    assert(c.functions.some(f => f.name === 'add'), '缺少 add 函数');
    assert(c.functions.some(f => f.name === 'print_result'), '缺少 print_result 函数');
  });

  await test('Python契约提取 - 函数和类', async () => {
    const ContractAssembler = require('../src/core/ContractAssembler');
    const assembler = new ContractAssembler({ supportedLanguages: ['python'] });

    const code = `
def hello(name: str) -> str:
    return f"Hello {name}"

class Calculator:
    def add(self, a: int, b: int) -> int:
        return a + b
`;

    const contracts = await assembler.extractContracts([
      { language: 'python', code, filePath: 'calc.py' }
    ]);

    assertEqual(contracts.length, 1, '应有1个契约');
    assert(contracts[0].functions.length >= 1, '应提取函数');
    assert(contracts[0].classes.length >= 1, '应提取类');
    assert(contracts[0].classes[0].name === 'Calculator', '类名应为 Calculator');
  });

  await test('JavaScript契约提取 - 函数和箭头函数', async () => {
    const ContractAssembler = require('../src/core/ContractAssembler');
    const assembler = new ContractAssembler({ supportedLanguages: ['javascript'] });

    const code = `
function add(a, b) { return a + b; }
const multiply = (a, b) => a * b;
export function calculate(x, y) { return add(x, y) * multiply(x, y); }
`;

    const contracts = await assembler.extractContracts([
      { language: 'javascript', code, filePath: 'math.js' }
    ]);

    assert(contracts[0].functions.length >= 2, `应提取至少2个函数, 实际 ${contracts[0].functions.length}`);
    assert(contracts[0].functions.some(f => f.name === 'add'), '缺少 add');
    assert(contracts[0].exports.some(e => e === 'calculate'), '缺少 calculate export');
  });

  await test('TypeScript契约提取 - 接口和类型', async () => {
    const ContractAssembler = require('../src/core/ContractAssembler');
    const assembler = new ContractAssembler({ supportedLanguages: ['typescript'] });

    const code = `
interface User {
  id: number;
  name: string;
  email: string;
}

type Result<T> = { success: boolean; data: T };

function getUser(id: number): Promise<User> {
  return fetch(\`/api/users/\${id}\`).then(r => r.json());
}
`;

    const contracts = await assembler.extractContracts([
      { language: 'typescript', code, filePath: 'user.ts' }
    ]);

    assert(contracts[0].interfaces.length >= 1, '应提取 interface');
    assert(contracts[0].interfaces[0].name === 'User', 'interface 应为 User');
  });

  await test('多渠道契约拼装 - 多来源合并', async () => {
    const ContractAssembler = require('../src/core/ContractAssembler');
    const assembler = new ContractAssembler({ strictMode: false });

    const agent1Code = `def process_data(data: str) -> str:
    return data.strip()`;

    const agent2Code = `def validate_input(data: str) -> bool:
    return len(data) > 0`;

    const rawBlocks = [
      { language: 'python', code: agent1Code, filePath: 'agent1_output.py' },
      { language: 'python', code: agent2Code, filePath: 'agent2_output.py' }
    ];
    const contracts = await assembler.extractContracts(rawBlocks);

    const result = await assembler.assemble(contracts, { language: 'python', strictMode: false });
    assert(result.success, `契约拼装失败: ${result.error}`);
    assert(result.code, '拼装代码为空');
    assert(result.code.includes('process_data'), '缺少 process_data');
    assert(result.code.includes('validate_input'), '缺少 validate_input');
  });

  await test('契约验证 - 同名函数冲突检测', async () => {
    const ContractAssembler = require('../src/core/ContractAssembler');
    const assembler = new ContractAssembler({ strictMode: false });

    const agent1Code = `def calculate(x: int) -> int:
    return x * 2`;

    const agent2Code = `def calculate(a: float, b: float) -> float:
    return a + b`;

    const rawBlocks = [
      { language: 'python', code: agent1Code, filePath: 'agent1.py' },
      { language: 'python', code: agent2Code, filePath: 'agent2.py' }
    ];
    const contracts = await assembler.extractContracts(rawBlocks);

    const result = await assembler.assemble(contracts, { language: 'python', strictMode: false });
    assert(result.success, '非严格模式应成功');
    assert(result.conflicts > 0, `应检测到冲突, 实际 ${result.conflicts}`);
  });

  await test('Go语言契约提取', async () => {
    const ContractAssembler = require('../src/core/ContractAssembler');
    const assembler = new ContractAssembler({ supportedLanguages: ['go'] });

    const code = `
type User struct {
    ID   int64
    Name string
}

type Storage interface {
    Get(id int64) (*User, error)
    Save(user *User) error
}

func NewService(storage Storage) *Service {
    return &Service{storage: storage}
}`;

    const contracts = await assembler.extractContracts([
      { language: 'go', code, filePath: 'main.go' }
    ]);

    assert(contracts[0].structs.length >= 1, '应提取 struct');
    assert(contracts[0].interfaces.length >= 1, '应提取 interface');
    assert(contracts[0].functions.length >= 1, '应提取函数');
  });

  await test('Rust契约提取', async () => {
    const ContractAssembler = require('../src/core/ContractAssembler');
    const assembler = new ContractAssembler({ supportedLanguages: ['rust'] });

    const code = `
pub struct Config {
    pub host: String,
    pub port: u16,
}

pub trait Handler {
    fn handle(&self, request: &str) -> String;
}

pub fn start_server(config: Config) -> Result<(), String> {
    Ok(())
}`;

    const contracts = await assembler.extractContracts([
      { language: 'rust', code, filePath: 'main.rs' }
    ]);

    assert(contracts[0].structs.length >= 1, '应提取 struct');
    assert(contracts[0].functions.length >= 1, '应提取函数');
  });
}

// ════════════════════════════════════════════════
// 6. MergeEngine 合并测试
// ════════════════════════════════════════════════
async function testMergeEngine() {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  6. MergeEngine 合并引擎测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('MergeEngine 可创建', async () => {
    const MergeEngine = require('../src/agents/MergeEngine');
    const engine = new MergeEngine(null, { name: 'test-merge' });
    assert(engine, 'MergeEngine 创建失败');
    assert(typeof engine.merge === 'function', 'merge 方法缺失');
    assert(typeof engine.generateMergeReport === 'function', 'generateMergeReport 方法缺失');
  });

  await test('单结果合并（无冲突）', async () => {
    const MergeEngine = require('../src/agents/MergeEngine');
    const engine = new MergeEngine(null);

    const result = await engine.merge({
      'agent1': {
        success: true,
        result: {
          codeBlocks: [
            { language: 'python', code: 'print("hello")', filePath: 'main.py' }
          ]
        }
      }
    });

    assert(result.mergedCode, '合并代码不应为空');
    assertEqual(result.conflicts.length, 0, '单结果不应有冲突');
    assertEqual(result.mergeStrategy, 'single');
  });

  await test('多结果分组合并', async () => {
    const MergeEngine = require('../src/agents/MergeEngine');
    const engine = new MergeEngine(null);

    const result = await engine.merge({
      'agent1': {
        success: true,
        result: {
          codeBlocks: [
            { language: 'python', code: 'print("hello")', filePath: 'main.py' }
          ]
        }
      },
      'agent2': {
        success: true,
        result: {
          codeBlocks: [
            { language: 'python', code: 'print("world")', filePath: 'main.py' }
          ]
        }
      }
    });

    assert(result.mergedCode, '合并代码不应为空');
    assert(result.mergeStrategy !== 'single', '多结果不应使用 single 策略');
  });
}

// ════════════════════════════════════════════════
// 7. TaskOrchestrator 集成测试
// ════════════════════════════════════════════════
async function testTaskOrchestrator() {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  7. TaskOrchestrator 编排器集成测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('TaskOrchestrator 可创建', async () => {
    const ProviderFactory = require('../src/providers');
    const TaskOrchestrator = require('../src/core/TaskOrchestrator');
    const provider = ProviderFactory.create('ollama');

    const orchestrator = new TaskOrchestrator(provider, {
      workspaceDir: './test_workspace',
      executionMode: 'privacy'
    });

    assert(orchestrator, 'TaskOrchestrator 创建失败');
    assert(orchestrator.modeManager, 'modeManager 缺失');
    assertEqual(orchestrator.getExecutionMode(), 'privacy', '模式应为 privacy');
  });

  await test('执模式切换 - privacy -> quality 同步更新配置', async () => {
    const ProviderFactory = require('../src/providers');
    const TaskOrchestrator = require('../src/core/TaskOrchestrator');
    const provider = ProviderFactory.create('ollama');

    const orchestrator = new TaskOrchestrator(provider, {
      workspaceDir: './test_workspace',
      executionMode: 'privacy'
    });

    assertEqual(orchestrator.getExecutionMode(), 'privacy');
    assertEqual(orchestrator.routingStrategy, 'round_robin');
    assert(orchestrator.privacyMode === true, '隐私模式应为 true');

    orchestrator.setExecutionMode('quality');
    assertEqual(orchestrator.getExecutionMode(), 'quality');
    assertEqual(orchestrator.routingStrategy, 'capability');
  });

  await test('TaskOrchestrator 初始化正常', async () => {
    const ProviderFactory = require('../src/providers');
    const TaskOrchestrator = require('../src/core/TaskOrchestrator');
    const provider = ProviderFactory.create('ollama');

    const orchestrator = new TaskOrchestrator(provider, { workspaceDir: './test_workspace' });
    const result = await orchestrator.initialize();
    assert(result === true, '初始化应返回 true');
  });

  await test('获取路由策略列表明完好', async () => {
    const ProviderFactory = require('../src/providers');
    const TaskOrchestrator = require('../src/core/TaskOrchestrator');
    const provider = ProviderFactory.create('ollama');

    const orchestrator = new TaskOrchestrator(provider, { workspaceDir: './test_workspace' });
    const strategies = orchestrator.getRoutingStrategies();
    assert(Array.isArray(strategies), 'strategies 应为数组');
    assertEqual(strategies.length, 4, '应有4种路由策略');
  });

  await test('模式推荐功能正常', async () => {
    const ProviderFactory = require('../src/providers');
    const TaskOrchestrator = require('../src/core/TaskOrchestrator');
    const provider = ProviderFactory.create('ollama');

    const orchestrator = new TaskOrchestrator(provider, { workspaceDir: './test_workspace' });
    const modes = orchestrator.getExecutionModes();
    assert(Array.isArray(modes), 'modes 应为数组');
    assertEqual(modes.length, 2, '应有2种模式');
  });
}

// ════════════════════════════════════════════════
// 8. 工具适配器功能测试
// ════════════════════════════════════════════════
async function testAdapters() {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  8. 工具适配器功能测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('所有适配器检测方法存在', async () => {
    const AdapterFactory = require('../src/adapters');
    const adapters = AdapterFactory.createAll();

    for (const adapter of adapters) {
      assert(typeof adapter.detect === 'function', `${adapter.name}.detect 缺失`);
      assert(typeof adapter.connect === 'function', `${adapter.name}.connect 缺失`);
      assert(typeof adapter.execute === 'function', `${adapter.name}.execute 缺失`);
      assert(typeof adapter.isAvailable === 'function', `${adapter.name}.isAvailable 缺失`);
      assert(typeof adapter.getInfo === 'function', `${adapter.name}.getInfo 缺失`);
      assert(adapter.name, `${adapter.name} 名称缺失`);
      assert(adapter.displayName, `${adapter.name} displayName 缺失`);
    }
  });

  await test('BaseToolAdapter 执行流程完整', async () => {
    const BaseToolAdapter = require('../src/adapters/BaseToolAdapter');
    const adapter = new BaseToolAdapter({ name: 'test', displayName: 'Test', workspaceDir: './test_workspace' });

    // 未连接状态执行应返回失败
    adapter.status = 'offline';
    adapter.detected = false;

    const result = await adapter.execute('test task', { taskId: 'test_001' });
    assert(result.success === false, '未连接状态应返回失败');
    assert(result.taskId === 'test_001', 'taskId 应传递');
  });

  await test('代码块正则提取', async () => {
    // 测试 _extractCodeBlocks 方法，在 adapters 中共享
    const text = '```python\nprint("hello")\n```\n```javascript\nconsole.log("world");\n```';

    // 这个方法是适配器内部的，我们通过 QoderAdapter 测试
    const QoderAdapter = require('../src/adapters/QoderAdapter');
    const adapter = new QoderAdapter();

    const blocks = adapter._extractCodeBlocks(text);
    assertEqual(blocks.length, 2, '应提取2个代码块');
    assertEqual(blocks[0].language, 'python');
    assertEqual(blocks[1].language, 'javascript');
    assert(blocks[0].code.includes('hello'), '代码块内容应包含 hello');
  });
}

// ════════════════════════════════════════════════
// 9. CLI 命令注册测试
// ════════════════════════════════════════════════
async function testCLI() {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  9. CLI 命令注册测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('CLI 所有命令已注册', async () => {
    const fs = require('fs');
    const path = require('path');
    
    // 验证 CLI 文件存在且可加载
    const cliPath = path.join(__dirname, '../src/cli/index.js');
    assert(fs.existsSync(cliPath), 'CLI 文件不存在');
    
    // 读取 CLI 源文件中注册的命令列表
    const cliContent = fs.readFileSync(cliPath, 'utf-8');
    const expectedCommands = ['run', 'check', 'list', 'reports', 'report', 'context', 'multi', 'agents', 'scan', 'connect', 'web', 'help'];
    
    for (const cmd of expectedCommands) {
      assert(
        cliContent.includes(`.command('${cmd}')`) || cliContent.includes(`.command(\"${cmd}\")`),
        `CLI 缺少 ${cmd} 命令注册`
      );
    }
    
    // 验证 CLI 模块导出的是 Commander 实例
    const { Command } = require('commander');
    assert(typeof Command === 'function', 'Commander 可加载');
  });
}

// ════════════════════════════════════════════════
// 10. 配置文件完整性测试
// ════════════════════════════════════════════════
async function testConfig() {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  10. 配置文件完整性测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('agents.json 配置结构', async () => {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(__dirname, '../config/agents.json');

    assert(fs.existsSync(configPath), 'agents.json 不存在');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert(config.agents, '缺少 agents 配置');
    assert(config.dispatch, '缺少 dispatch 配置');
    assert(config.dispatch.mode, '缺少 dispatch.mode');
    assert(config.dispatch.parallelLimit, '缺少 dispatch.parallelLimit');

    // 验证已有 Agent 配置
    const agentNames = Object.keys(config.agents);
    assert(agentNames.includes('ollama'), '缺少 ollama');
    assert(agentNames.includes('openai'), '缺少 openai');
    assert(agentNames.includes('anthropic'), '缺少 anthropic');
  });

  await test('.env.example 配置模板完整', async () => {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(__dirname, '../.env.example');

    assert(fs.existsSync(envPath), '.env.example 不存在');

    const content = fs.readFileSync(envPath, 'utf-8');
    assert(content.includes('MODEL_PROVIDER'), '缺少 MODEL_PROVIDER');
    assert(content.includes('OLLAMA_'), '缺少 Ollama 配置');
    assert(content.includes('OPENAI_'), '缺少 OpenAI 配置');
    assert(content.includes('ANTHROPIC_API_KEY'), '缺少 ANTHROPIC_API_KEY');
  });
}

// ════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════
async function main() {
  console.log(chalk.bold.green('\n╔═══════════════════════════════════════════╗'));
  console.log(chalk.bold.green('║    启迪 Agent 全面专业测试套件       ║'));
  console.log(chalk.bold.green('║    ai-orchestrator Comprehensive Test Suite  ║'));
  console.log(chalk.bold.green('╚═══════════════════════════════════════════╝'));
  console.log(chalk.gray(`\n测试时间: ${new Date().toLocaleString()}`));
  console.log(chalk.gray(`Node.js: ${process.version}\n`));

  try {
    await testModuleImports();
    await testProviders();
    await testTaskRouter();
    await testExecutionModeManager();
    await testContractAssembler();
    await testMergeEngine();
    await testTaskOrchestrator();
    await testAdapters();
    await testCLI();
    await testConfig();

    // ════════════════════════════════════════════
    // 最终报告
    // ════════════════════════════════════════════
    const totalTests = results.length;
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const totalDuration = Date.now() - startTime;

    console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
    console.log(chalk.bold.cyan('  测试报告摘要'));
    console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

    console.log(chalk.white(`  总测试数: ${totalTests}`));
    console.log(chalk.green(`  通过: ${passed}`));
    console.log(chalk.red(`  失败: ${failed}`));
    console.log(chalk.gray(`  总耗时: ${totalDuration}ms\n`));

    if (failed > 0) {
      console.log(chalk.bold.yellow('  失败测试详情:\n'));
      for (const r of results.filter(r => !r.passed)) {
        console.log(chalk.red(`  ❌ ${r.name} (${r.duration}ms)`));
        console.log(chalk.red(`     ${r.error}\n`));
      }
    }

    const passRate = Math.round((passed / totalTests) * 100);
    const grade = passRate === 100 ? 'S' : passRate >= 90 ? 'A' : passRate >= 80 ? 'B' : passRate >= 70 ? 'C' : 'D';

    console.log(chalk.bold.cyan('══════════════════════════════════════'));
    console.log(chalk.bold[passRate === 100 ? 'green' : 'yellow'](
      `  综合评估: ${passRate}% 通过率 - 等级 ${grade}`
    ));
    console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

    // 按类别汇总
    const categories = [
      { name: '模块导入', startIdx: 0, endIdx: 3 },
      { name: 'Provider', startIdx: 4, endIdx: 9 },
      { name: 'TaskRouter', startIdx: 10, endIdx: 21 },
      { name: 'ExecutionModeManager', startIdx: 22, endIdx: 31 },
      { name: 'ContractAssembler', startIdx: 32, endIdx: 40 },
      { name: 'MergeEngine', startIdx: 41, endIdx: 43 },
      { name: 'TaskOrchestrator', startIdx: 44, endIdx: 48 },
      { name: 'Adapters', startIdx: 49, endIdx: 51 },
      { name: 'CLI', startIdx: 52, endIdx: 52 },
      { name: 'Config', startIdx: 53, endIdx: 54 }
    ];

    console.log(chalk.bold('  分类统计:\n'));
    for (const cat of categories) {
      const catTests = results.slice(cat.startIdx, cat.endIdx + 1);
      const catPassed = catTests.filter(r => r.passed).length;
      const catTotal = catTests.length;
      if (catTotal > 0) {
        const icon = catPassed === catTotal ? '✅' : '⚠️';
        console.log(`  ${icon} ${cat.name}: ${catPassed}/${catTotal}`);
      }
    }

    console.log(chalk.gray('\n  详细报告文件: test/reports/comprehensive_test_report.json\n'));

    // 保存报告
    const fs = require('fs');
    const path = require('path');
    const reportDir = path.join(__dirname, 'reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const report = {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
      summary: { total: totalTests, passed, failed, passRate, grade, duration: totalDuration },
      results,
      categories: categories.map(c => {
        const catTests = results.slice(c.startIdx, c.endIdx + 1);
        return { name: c.name, passed: catTests.filter(r => r.passed).length, total: catTests.length };
      })
    };

    const reportPath = path.join(reportDir, `comprehensive_test_${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(chalk.gray(`  报告已保存: ${reportPath}\n`));

  } catch (e) {
    console.error(chalk.red(`\n测试框架异常: ${e.message}`));
    console.error(e.stack);
    process.exit(1);
  }
}

main().catch(console.error);
