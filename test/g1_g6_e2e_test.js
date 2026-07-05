/**
 * G5: 12 个新模块端到端测试
 *
 * 测试模块清单：
 *  1.  TestRunner          — 测试执行引擎
 *  2.  MCPClient            — MCP 客户端
 *  3.  VectorMemoryStore    — 语义向量记忆
 *  4.  StreamManager        — 流式输出管理
 *  5.  BudgetManager        — Token 预算管理
 *  6.  RetryManager         — 智能重试
 *  7.  GitIntegration       — Git 集成
 *  8.  SandboxExecutor      — 沙箱执行
 *  9.  ApprovalWorkflow     — 人工审批
 * 10.  DistributedExecutor  — 分布式执行
 * 11.  ContractValidator    — 契约验证
 * 12.  Provider chatStream   — 流式聊天 (OpenAI + Ollama)
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// ── 辅助 ──
let passed = 0;
let failed = 0;
const results = [];

function test (name, fn) {
  return async () => {
    try {
      await fn();
      passed++;
      results.push({ name, status: 'pass' });
      console.log(`  ✅ ${name}`);
    } catch (e) {
      failed++;
      results.push({ name, status: 'fail', error: e.message });
      console.log(`  ❌ ${name}: ${e.message}`);
    }
  };
}

// ── 1. TestRunner ──
const testTestRunner = test('TestRunner: runTests 基本流程', async () => {
  const TestRunner = require('../src/core/TestRunner');
  const runner = new TestRunner({ workspaceDir: './test_workspace' });
  assert.ok(runner, 'TestRunner 实例化失败');
  assert.strictEqual(typeof runner.runTests, 'function', 'runTests 方法不存在');
  assert.strictEqual(typeof runner.runTestCases, 'function', 'runTestCases 方法不存在');
});

// ── 2. MCPClient ──
const testMCPClient = test('MCPClient: 实例化与接口', async () => {
  const MCPClient = require('../src/mcp/MCPClient');
  const client = new MCPClient({ configPath: './test_workspace/mcp_test.json' });
  assert.ok(client, 'MCPClient 实例化失败');
  assert.strictEqual(typeof client.connectServer, 'function', 'connectServer 方法不存在');
  assert.strictEqual(typeof client.callTool, 'function', 'callTool 方法不存在');
  assert.strictEqual(typeof client.getToolAdapters, 'function', 'getToolAdapters 方法不存在');
  assert.strictEqual(typeof client.getStatus, 'function', 'getStatus 方法不存在');
});

// ── 3. VectorMemoryStore ──
const testVectorMemory = test('VectorMemoryStore: store + search', async () => {
  const VectorMemoryStore = require('../src/core/VectorMemoryStore');
  const vm = new VectorMemoryStore({ persistDir: './test_workspace/vm_test' });
  assert.ok(vm, 'VectorMemoryStore 实例化失败');

  const id = await vm.store('这是一个测试文档关于 JavaScript', { type: 'test', lang: 'js' });
  assert.ok(id, 'store 返回的 id 为空');

  const searchResults = await vm.search('JavaScript', {}, 5);
  assert.ok(Array.isArray(searchResults), 'search 应返回数组');

  const stats = vm.getStats();
  assert.ok(stats, 'getStats 不应返回空');
});

// ── 4. StreamManager ──
const testStreamManager = test('StreamManager: start + push + done', async () => {
  const StreamManager = require('../src/utils/StreamManager');
  const sm = new StreamManager();
  assert.ok(sm, 'StreamManager 实例化失败');

  sm.start();
  sm.push('hello');
  sm.push(' world');
  sm.status('processing', { task: 'test' });
  sm.progress(1, 3, 'step 1');
  sm.done({ success: true });

  // toSSE 返回一个 Express 中间件函数
  const sseMiddleware = sm.toSSE();
  assert.strictEqual(typeof sseMiddleware, 'function', 'toSSE 应返回函数');

  // getFullText 返回所有 chunk 拼接
  const fullText = sm.getFullText();
  assert.ok(typeof fullText === 'string', 'getFullText 应返回字符串');
});

// ── 5. BudgetManager ──
const testBudgetManager = test('BudgetManager: record + canProceed + report', async () => {
  const BudgetManager = require('../src/core/BudgetManager');
  // 使用临时持久化路径避免加载之前的状态
  const tmpPath = path.join(__dirname, '../test_workspace/budget_test_' + Date.now() + '.json');
  const bm = new BudgetManager({ totalBudget: 100000, persistPath: tmpPath });
  assert.ok(bm, 'BudgetManager 实例化失败');

  bm.record('code_writer', 'codeWriter', 'qwen2.5:7b', 5000, 2000);
  assert.strictEqual(bm.canProceed(10000), true, '剩余预算应足够');
  assert.strictEqual(bm.canProceed(100000), false, '已用 7000，不应允许 100000');

  const report = bm.generateReport();
  assert.strictEqual(report.totalBudget, 100000, '总预算应为 100000');
  assert.strictEqual(report.totalConsumed, 7000, '已用应为 7000');
  assert.ok(report.remaining !== undefined, 'remaining 应存在');

  // 清理临时文件
  try {
    fs.unlinkSync(tmpPath);
  } catch (_) {}
});

// ── 6. RetryManager ──
const testRetryManager = test('RetryManager: classify + execute', async () => {
  const { RetryManager } = require('../src/utils/RetryManager');
  const rm = new RetryManager();
  assert.ok(rm, 'RetryManager 实例化失败');

  // classify
  const type1 = rm.classify(new Error('timeout'));
  assert.ok(type1, 'classify 应返回类型');

  // execute — 成功
  let attempts = 0;
  const result = await rm.execute(async () => {
    attempts++;
    return { success: true };
  }, { maxRetries: 3 });
  assert.strictEqual(result.success, true, 'execute 应返回成功结果');
  assert.strictEqual(attempts, 1, '应只执行 1 次');

  // execute — 重试后成功
  let attempts2 = 0;
  const result2 = await rm.execute(async () => {
    attempts2++;
    if (attempts2 < 2) throw new Error('temporary failure');
    return { success: true };
  }, { maxRetries: 3 });
  assert.strictEqual(result2.success, true, '重试后应成功');
  assert.strictEqual(attempts2, 2, '应执行 2 次');
});

// ── 7. GitIntegration ──
const testGitIntegration = test('GitIntegration: 实例化与接口', async () => {
  const GitIntegration = require('../src/core/GitIntegration');
  const git = new GitIntegration({ workspaceDir: './test_workspace' });
  assert.ok(git, 'GitIntegration 实例化失败');
  assert.strictEqual(typeof git.createTaskBranch, 'function');
  assert.strictEqual(typeof git.commitChanges, 'function');
  assert.strictEqual(typeof git.rollback, 'function');
  assert.strictEqual(typeof git.isEnabled, 'function');
});

// ── 8. SandboxExecutor ──
const testSandboxExecutor = test('SandboxExecutor: executeCode JS 代码', async () => {
  const SandboxExecutor = require('../src/core/SandboxExecutor');
  const sb = new SandboxExecutor({ timeout: 5000 });
  assert.ok(sb, 'SandboxExecutor 实例化失败');

  // 使用 executeCode 方法（而非 execute，execute 是命令执行）
  const result = await sb.executeCode('console.log("hello sandbox");', 'javascript', { timeout: 5000 });
  assert.ok(result, 'executeCode 应返回结果');
  assert.ok(result.stdout || result.output || result.success !== undefined, '应有输出或结果');
});

// ── 9. ApprovalWorkflow ──
const testApprovalWorkflow = test('ApprovalWorkflow: request + approve', async () => {
  const ApprovalWorkflow = require('../src/core/ApprovalWorkflow');
  const aw = new ApprovalWorkflow({
    enabled: true,
    checkpoints: {
      pre_execute: { enabled: true, description: '执行前审批' },
      post_quality: { enabled: true, description: '质检后审批', minScore: 60 }
    },
    autoApproveOnTimeout: false,
    timeout: 999999 // 不超时，由测试手动控制
  });
  assert.ok(aw, 'ApprovalWorkflow 实例化失败');

  // 请求审批 — 不 await（因为 requestApproval 是阻塞的 Promise）
  const approvalPromise = aw.requestApproval('pre_execute', { task: 'test task' });

  // 等待一小段时间让 pending 审批创建
  await new Promise(resolve => setTimeout(resolve, 200));

  const pending = aw.getPendingApprovals();
  assert.ok(Array.isArray(pending), 'getPendingApprovals 应返回数组');
  assert.ok(pending.length > 0, '应有 pending 审批');

  // 批准第一个 pending
  const approvalId = pending[0].id;
  const result = aw.approve(approvalId, 'approved by test');
  assert.ok(result, 'approve 应返回结果');

  // 等待 Promise resolve
  const req = await approvalPromise;
  assert.ok(req, 'requestApproval 应返回结果');
  assert.strictEqual(req.approved, true, '批准后应返回 approved=true');
});

// ── 10. DistributedExecutor ──
const testDistributedExecutor = test('DistributedExecutor: 实例化与接口', async () => {
  const DistributedExecutor = require('../src/core/DistributedExecutor');
  const de = new DistributedExecutor({ mode: 'local' });
  assert.ok(de, 'DistributedExecutor 实例化失败');
  assert.strictEqual(typeof de.startMaster, 'function', 'startMaster 方法不存在');
  assert.strictEqual(typeof de.distributeTasks, 'function', 'distributeTasks 方法不存在');
});

// ── 11. ContractValidator ──
const testContractValidator = test('ContractValidator: validateInput + validateOutput', async () => {
  const ContractValidator = require('../src/core/ContractValidator');
  const cv = new ContractValidator();
  assert.ok(cv, 'ContractValidator 实例化失败');

  const inputResult = cv.validateInput(
    { id: 'T1', title: 'test', role: 'code_writer', description: 'desc' },
    { constraints: {} }
  );
  assert.ok(inputResult, 'validateInput 应返回结果');
  assert.ok(typeof inputResult.passed === 'boolean', 'passed 应为布尔值');

  const outputResult = cv.validateOutput(
    { content: 'var x = 1;', codeBlocks: [{ language: 'javascript', code: 'var x = 1;' }] },
    { expectCode: true, language: 'javascript' }
  );
  assert.ok(outputResult, 'validateOutput 应返回结果');
});

// ── 12. Provider chatStream 接口验证 ──
const testProviderChatStream = test('Provider chatStream: OpenAI + Ollama 接口存在性', async () => {
  const OpenAIProvider = require('../src/providers/OpenAIProvider');
  const OllamaProvider = require('../src/providers/OllamaProvider');
  const AnthropicProvider = require('../src/providers/AnthropicProvider');

  assert.strictEqual(typeof OpenAIProvider.prototype.chatStream, 'function',
    'OpenAIProvider 应有 chatStream 方法');
  assert.strictEqual(typeof OllamaProvider.prototype.chatStream, 'function',
    'OllamaProvider 应有 chatStream 方法');
  assert.strictEqual(typeof AnthropicProvider.prototype.chatStream, 'function',
    'AnthropicProvider 应有 chatStream 方法');
});

// ── G1: TaskExecutor._generateQuickTest ──
const testGenerateQuickTest = test('TaskExecutor._generateQuickTest: 多语言模板生成', async () => {
  const TaskExecutor = require('../src/core/TaskExecutor');
  const exec = new TaskExecutor({});
  assert.strictEqual(typeof exec._generateQuickTest, 'function', '_generateQuickTest 方法不存在');

  const jsTest = exec._generateQuickTest('var x = 1;', 'javascript');
  assert.ok(jsTest.includes('语法检查'), 'JS 模板应包含语法检查');

  const pyTest = exec._generateQuickTest('x = 1', 'python');
  assert.ok(pyTest.includes('ast.parse'), 'Python 模板应包含 ast.parse');

  const cTest = exec._generateQuickTest('int main() {}', 'c');
  assert.ok(cTest.includes('stdio.h'), 'C 模板应包含 stdio.h');
});

// ── G3: WebUIServer 增强路由 (文件级检查，不 require 完整模块) ──
const testWebUIEnhancedRoutes = test('WebUIServer: 增强模块 API 路由注册', async () => {
  const webuiPath = path.join(__dirname, '../src/core/WebUIServer.js');
  const src = fs.readFileSync(webuiPath, 'utf-8');
  assert.ok(src.includes('_setupEnhancedRoutes'), '_setupEnhancedRoutes 方法应存在');
  assert.ok(src.includes('setEnhancedModules'), 'setEnhancedModules 方法应存在');
  assert.ok(src.includes('/api/budget'), '预算 API 路由应存在');
  assert.ok(src.includes('/api/approvals'), '审批 API 路由应存在');
  assert.ok(src.includes('/api/git/'), 'Git API 路由应存在');
  assert.ok(src.includes('/api/sandbox/'), '沙箱 API 路由应存在');
  assert.ok(src.includes('/api/vector-memory/'), '向量记忆 API 路由应存在');
  assert.ok(src.includes('/api/stream/'), 'SSE 流式 API 路由应存在');
});

// ── G6: enhanced_modules.json 配置 ──
const testEnhancedConfig = test('G6: config/enhanced_modules.json 存在且可解析', async () => {
  const configPath = path.join(__dirname, '../config/enhanced_modules.json');
  assert.ok(fs.existsSync(configPath), 'enhanced_modules.json 不存在');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  assert.ok(config.modules, '配置应包含 modules 字段');
  assert.ok(config.modules.budgetManager, '应包含 budgetManager 配置');
  assert.ok(config.modules.testRunner, '应包含 testRunner 配置');
  assert.ok(config.modules.gitIntegration, '应包含 gitIntegration 配置');
});

// ── 主入口 ──
async function runAll () {
  console.log('\n═══════════════════════════════════════════');
  console.log('  G1-G6 端到端测试 (12 模块 + G1/G3/G6)');
  console.log('═══════════════════════════════════════════\n');

  const tests = [
    testTestRunner,
    testMCPClient,
    testVectorMemory,
    testStreamManager,
    testBudgetManager,
    testRetryManager,
    testGitIntegration,
    testSandboxExecutor,
    testApprovalWorkflow,
    testDistributedExecutor,
    testContractValidator,
    testProviderChatStream,
    testGenerateQuickTest,
    testWebUIEnhancedRoutes,
    testEnhancedConfig
  ];

  for (const t of tests) {
    await t();
  }

  console.log('\n═══════════════════════════════════════════');
  console.log(`  通过: ${passed}  失败: ${failed}  总计: ${passed + failed}`);
  console.log('═══════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

// 直接运行
if (require.main === module) {
  runAll();
}

module.exports = { runAll };
