/**
 * 全项目冒烟测试 - 覆盖所有核心模块、P0-P3增强模块、API、CLI
 */
const path = require('path');
const fs = require('fs');

// 项目根目录（测试文件在 test/ 下，所以根目录是上一级）
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
const results = [];

function ok (name, detail = '') {
  pass++;
  results.push({ name, status: 'PASS', detail });
  console.log('  ✅ ' + name + (detail ? ' (' + detail + ')' : ''));
}
function err (name, detail = '') {
  fail++;
  results.push({ name, status: 'FAIL', detail });
  console.log('  ❌ ' + name + (detail ? ': ' + detail : ''));
}

function section (title) {
  console.log('\n══════════════════════════════════════');
  console.log('  ' + title);
  console.log('══════════════════════════════════════');
}

function resolveModule (relPath) {
  return require(path.resolve(ROOT, relPath));
}

// ═══════════════════════════════════════════
// 1. P0-P3 增强模块功能测试
// ═══════════════════════════════════════════
section('1. P0-P3 增强模块实例化测试');

const modules = [
  { name: 'BudgetManager', path: 'src/core/BudgetManager.js' },
  { name: 'VectorMemoryStore', path: 'src/core/VectorMemoryStore.js' },
  { name: 'ContractValidator', path: 'src/core/ContractValidator.js' },
  { name: 'GitIntegration', path: 'src/core/GitIntegration.js' },
  { name: 'ApprovalWorkflow', path: 'src/core/ApprovalWorkflow.js' },
  { name: 'SandboxExecutor', path: 'src/core/SandboxExecutor.js' },
  { name: 'DistributedExecutor', path: 'src/core/DistributedExecutor.js' },
  { name: 'TestRunner', path: 'src/core/TestRunner.js' },
  { name: 'StreamManager', path: 'src/utils/StreamManager.js' },
  { name: 'ModelRouter', path: 'src/utils/ModelRouter.js' },
  { name: 'MCPClient', path: 'src/mcp/MCPClient.js' }
];

for (const m of modules) {
  try {
    const Mod = resolveModule(m.path);
    const instance = new Mod({});
    ok(m.name, '实例化成功');
  } catch (e) {
    err(m.name, e.message);
  }
}

// RetryManager 是命名导出
try {
  const { RetryManager } = resolveModule('src/utils/RetryManager.js');
  const rm = new RetryManager({ maxRetries: 3 });
  ok('RetryManager', '实例化成功');
} catch (e) {
  err('RetryManager', e.message);
}

// ═══════════════════════════════════════════
// 2. AdaptiveOrchestrator 深度测试
// ═══════════════════════════════════════════
section('2. AdaptiveOrchestrator 自适应编排测试');

try {
  const AdaptiveOrchestrator = resolveModule('src/core/AdaptiveOrchestrator.js');
  const ao = new AdaptiveOrchestrator({ orchestrationMode: 'hybrid' });
  ok('AdaptiveOrchestrator 实例化', '模式: ' + ao.orchestrationMode);

  const tools = [
    { name: 'claude-code', displayName: 'Claude Code', status: 'online' },
    { name: 'qoder', displayName: 'Qoder', status: 'online' },
    { name: 'openclaw', displayName: 'OpenClaw', status: 'online' },
    { name: 'trae', displayName: 'Trae CN', status: 'online' },
    { name: 'hermes-agent', displayName: 'Hermes Agent', status: 'online' }
  ];

  const cases = [
    { desc: '用Python写一个爬虫', expectLang: 'python', expectType: 'feature' },
    { desc: '重构前端Vue界面,涉及微服务架构,复杂度高,使用TypeScript', expectLang: 'typescript', expectType: 'refactoring' },
    { desc: '修复bug,涉及数据库,使用Java Spring', expectLang: 'java', expectType: 'bugfix' },
    { desc: '部署docker容器到k8s集群', expectLang: 'unknown', expectType: 'devops' },
    { desc: '优化性能,加速API响应,使用Rust', expectLang: 'rust', expectType: 'optimization' }
  ];

  for (const c of cases) {
    const r = ao.recommend(c.desc, tools);
    const langOk = r.features.language === c.expectLang;
    const typeOk = r.features.taskType === c.expectType;
    const shortDesc = c.desc.substring(0, 30);
    if (langOk && typeOk) {
      ok('识别: ' + shortDesc, r.features.language + '/' + r.features.taskType + ' 置信度' + Math.round(r.confidence * 100) + '%');
    } else {
      err('识别: ' + shortDesc, '期望 ' + c.expectLang + '/' + c.expectType + ' 实际 ' + r.features.language + '/' + r.features.taskType);
    }
  }

  // 模式切换测试
  const r1 = ao.setOrchestrationMode('auto');
  if (r1.success && ao.orchestrationMode === 'auto') ok('切换到 auto 模式');
  else err('切换到 auto 模式');

  const r2 = ao.setOrchestrationMode('manual');
  if (r2.success && ao.orchestrationMode === 'manual') ok('切换到 manual 模式');
  else err('切换到 manual 模式');

  try {
    ao.setOrchestrationMode('invalid');
    err('拒绝非法模式', '未拒绝');
  } catch (_) {
    ok('拒绝非法模式');
  }

  // 偏好更新
  const r4 = ao.updatePreferences({ privacySensitivity: 'high', maxParallelTools: 5 });
  if (r4.success && r4.preferences.privacySensitivity === 'high') ok('更新用户偏好');
  else err('更新用户偏好');

  // 状态查询
  const status = ao.getStatus();
  if (status.orchestrationMode && status.userPreferences) ok('获取编排状态');
  else err('获取编排状态');
} catch (e) {
  err('AdaptiveOrchestrator', e.message);
}

// ═══════════════════════════════════════════
// 3. TaskOrchestrator 集成测试
// ═══════════════════════════════════════════
section('3. TaskOrchestrator 集成测试');

try {
  const TaskOrchestrator = resolveModule('src/core/TaskOrchestrator.js');
  const orch = new TaskOrchestrator({});
  ok('TaskOrchestrator 实例化');

  if (orch.adaptiveOrchestrator) ok('自适应编排器已集成');
  else err('自适应编排器未集成');

  if (typeof orch.getAdaptiveRecommendation === 'function') ok('getAdaptiveRecommendation API');
  else err('getAdaptiveRecommendation API');

  if (typeof orch.applyAdaptiveRecommendation === 'function') ok('applyAdaptiveRecommendation API');
  else err('applyAdaptiveRecommendation API');

  if (typeof orch.setOrchestrationMode === 'function') ok('setOrchestrationMode API');
  else err('setOrchestrationMode API');

  if (typeof orch.getOrchestrationMode === 'function') ok('getOrchestrationMode API');
  else err('getOrchestrationMode API');

  // 默认模式
  const mode = orch.getOrchestrationMode();
  if (mode === 'hybrid') ok('默认编排模式: hybrid');
  else err('默认编排模式', '期望 hybrid 实际 ' + mode);

  // 切换模式
  orch.setOrchestrationMode('auto');
  if (orch.getOrchestrationMode() === 'auto') ok('切换到 auto');
  else err('切换到 auto');

  orch.setOrchestrationMode('manual');
  if (orch.getOrchestrationMode() === 'manual') ok('切换到 manual');
  else err('切换到 manual');
} catch (e) {
  err('TaskOrchestrator', e.message);
}

// ═══════════════════════════════════════════
// 4. 智能涌现模块测试
// ═══════════════════════════════════════════
section('4. 智能涌现模块测试');

const emergenceModules = [
  'SynchronyMeter',
  'EmergenceEvaluator',
  'AgentCapabilityTree',
  'EmergenceAudit',
  'SelfEvalLayer',
  'ToolHealthChecker'
];

for (const m of emergenceModules) {
  try {
    const Mod = resolveModule('src/core/' + m + '.js');
    const instance = new Mod({});
    ok(m, '实例化成功');
  } catch (e) {
    err(m, e.message);
  }
}

// ═══════════════════════════════════════════
// 5. 工具适配器测试
// ═══════════════════════════════════════════
section('5. 工具适配器测试');

try {
  const adapters = resolveModule('src/adapters/index.js');
  const all = adapters.createAll();
  ok('适配器工厂', '创建 ' + all.length + ' 个适配器');

  const requiredMethods = ['detect', 'connect', 'execute'];
  const optionalMethods = ['disconnect', 'checkVersion'];
  let methodOk = true;
  for (const a of all) {
    for (const m of requiredMethods) {
      if (typeof a[m] !== 'function') {
        err(a.name + '.' + m + ' 方法缺失');
        methodOk = false;
        break;
      }
    }
  }
  if (methodOk) ok('所有适配器必需方法完整', 'detect/connect/execute');
  // 统计可选方法覆盖率
  let optionalCount = 0;
  for (const a of all) {
    for (const m of optionalMethods) {
      if (typeof a[m] === 'function') optionalCount++;
    }
  }
  ok('可选方法覆盖', optionalCount + '/' + (all.length * optionalMethods.length));
} catch (e) {
  err('工具适配器', e.message);
}

// ═══════════════════════════════════════════
// 6. Provider 测试
// ═══════════════════════════════════════════
section('6. Provider 测试');

const providers = [
  { name: 'OllamaProvider', path: 'src/providers/OllamaProvider.js' },
  { name: 'OpenAIProvider', path: 'src/providers/OpenAIProvider.js' },
  { name: 'AnthropicProvider', path: 'src/providers/AnthropicProvider.js' }
];

for (const p of providers) {
  try {
    const Provider = resolveModule(p.path);
    const inst = new Provider({});
    if (typeof inst.chat === 'function') ok(p.name, 'chat 方法可用');
    else err(p.name, 'chat 方法缺失');
  } catch (e) {
    err(p.name, e.message);
  }
}

// ═══════════════════════════════════════════
// 7. Agent 测试
// ═══════════════════════════════════════════
section('7. Agent 测试');

const agents = [
  'TaskSplitterAgent',
  'CodeWriterAgent',
  'CodeReviewerAgent',
  'TesterAgent',
  'QualityCheckerAgent',
  'MergeEngine'
];

for (const a of agents) {
  try {
    resolveModule('src/agents/' + a + '.js');
    ok(a, '导入成功');
  } catch (e) {
    err(a, e.message);
  }
}

// ═══════════════════════════════════════════
// 8. CLI 命令注册测试
// ═══════════════════════════════════════════
section('8. CLI 命令注册测试');

try {
  const cliPath = path.resolve(ROOT, 'src/cli/index.js');
  const cliSource = fs.readFileSync(cliPath, 'utf-8');

  const commands = [
    'run', 'check', 'list', 'reports', 'report', 'context',
    'multi', 'agents', 'scan', 'connect', 'health', 'web', 'chat',
    'interactive', 'tui', 'mcp', 'config', 'test', 'budget',
    'git', 'sandbox', 'approval'
  ];

  let cmdOk = 0;
  for (const cmd of commands) {
    const pattern = new RegExp('command\\([\'"]' + cmd + '[\'"]');
    if (pattern.test(cliSource)) cmdOk++;
  }

  if (cmdOk === commands.length) ok('CLI 命令注册', cmdOk + '/' + commands.length + ' 全部注册');
  else err('CLI 命令注册', cmdOk + '/' + commands.length + ' 注册');
} catch (e) {
  err('CLI 命令注册', e.message);
}

// ═══════════════════════════════════════════
// 9. 配置文件完整性
// ═══════════════════════════════════════════
section('9. 配置文件完整性');

const configFiles = [
  { path: 'config/agents.json', check: (c) => c && typeof c === 'object' },
  { path: 'package.json', check: (c) => c.name && c.version },
  { path: '.env.example', check: (c) => c.length > 100 }
];

for (const cf of configFiles) {
  try {
    const full = path.resolve(ROOT, cf.path);
    if (!fs.existsSync(full)) {
      err(cf.path, '文件不存在');
      continue;
    }
    if (cf.path.endsWith('.json')) {
      const data = JSON.parse(fs.readFileSync(full, 'utf-8'));
      if (cf.check(data)) ok(cf.path);
      else err(cf.path, '结构不正确');
    } else {
      const data = fs.readFileSync(full, 'utf-8');
      if (cf.check(data)) ok(cf.path);
      else err(cf.path, '内容不正确');
    }
  } catch (e) {
    err(cf.path, e.message);
  }
}

// ═══════════════════════════════════════════
// 10. 文档完整性
// ═══════════════════════════════════════════
section('10. 文档完整性');

const docs = [
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'docs/ROADMAP_TO_99_AND_BEYOND.md',
  'docs/OPTIMIZATION_COMPLETE_REPORT.md'
];

for (const d of docs) {
  if (fs.existsSync(path.resolve(ROOT, d))) ok(d);
  else err(d, '文档缺失');
}

// ═══════════════════════════════════════════
// 总结
// ═══════════════════════════════════════════
console.log('\n══════════════════════════════════════');
console.log('  冒烟测试总结');
console.log('══════════════════════════════════════');
console.log('  通过: ' + pass);
console.log('  失败: ' + fail);
console.log('  总数: ' + (pass + fail));
const rate = ((pass / (pass + fail)) * 100).toFixed(1);
console.log('  通过率: ' + rate + '%');
let grade = 'D';
if (rate >= 95) grade = 'S';
else if (rate >= 85) grade = 'A';
else if (rate >= 75) grade = 'B';
else if (rate >= 60) grade = 'C';
console.log('  等级: ' + grade);

if (fail > 0) {
  console.log('\n  ❌ 失败项:');
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log('     - ' + r.name + ': ' + r.detail);
  });
}

// 保存报告
const report = {
  timestamp: new Date().toISOString(),
  pass,
  fail,
  total: pass + fail,
  passRate: parseFloat(rate),
  grade,
  results
};
const reportPath = path.resolve(ROOT, 'test/reports/smoke_all_' + Date.now() + '.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log('\n  报告已保存: ' + reportPath);

process.exit(fail > 0 ? 1 : 0);
