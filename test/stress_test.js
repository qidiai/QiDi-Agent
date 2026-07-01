#!/usr/bin/env node

/**
 * ai-orchestrator 全面压力测试套件
 * ==================================
 * 覆盖维度：
 * 1. 批量路由压力 (100/500/1000 任务)
 * 2. ContractAssembler 大代码契约提取
 * 3. ExecutionModeManager 高频切换
 * 4. AgentHub 大规模配置加载
 * 5. MergeEngine 多源合并
 * 6. CacheStore 高并发读写
 * 7. MemoryStore 大数据持久化
 * 8. TokenCounter 大量计费
 * 9. ContextCompressor 大文件压缩
 * 10. 边缘/异常场景
 * 11. 长时间运行稳定性
 * 12. 内存泄漏检测
 */

const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ════════════════════════════════════════════════
// 测试框架
// ════════════════════════════════════════════════
const results = [];
const stressResults = [];
const STRESS_TIMEOUT = 120000;
const startTime = Date.now();
const memorySnapshots = [];

function test (name, fn, timeout = STRESS_TIMEOUT) {
  return new Promise((resolve) => {
    (async () => {
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
    })();
  });
}

function stress (label, target, actual, threshold, unit = '', higherBetter = false) {
  const passed = higherBetter ? actual >= threshold : actual <= threshold;
  const status = passed ? chalk.green('✅ PASS') : chalk.red('❌ FAIL');
  const diffMsg = higherBetter
    ? (passed ? chalk.green(`(+${(actual - threshold).toFixed(2)}${unit})`) : chalk.red(`(缺 ${(threshold - actual).toFixed(2)}${unit})`))
    : (passed ? chalk.green(`(${(threshold - actual).toFixed(2)}${unit} 余量)`) : chalk.red(`(超阈值 ${(actual - threshold).toFixed(2)}${unit})`));
  console.log(`  ${status} ${label}: ${actual.toFixed(2)}${unit} / ${threshold}${unit} ${diffMsg}`);

  stressResults.push({
    name: label,
    target,
    actual: parseFloat(actual.toFixed(2)),
    threshold,
    passed,
    unit,
    higherBetter
  });

  if (!passed) {
    const errMsg = higherBetter
      ? `压力指标未达标: ${label} 实际 ${actual.toFixed(2)}${unit} < 阈值 ${threshold}${unit}`
      : `压力指标未达标: ${label} 实际 ${actual.toFixed(2)}${unit} > 阈值 ${threshold}${unit}`;
    throw new Error(errMsg);
  }
}

function assert (condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

function assertEqual (actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || '值不相等'}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`);
  }
}

function measureMemory () {
  const usage = process.memoryUsage();
  memorySnapshots.push({
    timestamp: Date.now(),
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    rss: usage.rss,
    external: usage.external
  });
  return usage;
}

function getHeapInMB () {
  const mem = process.memoryUsage();
  return Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100;
}

// ════════════════════════════════════════════════
// 1. 批量路由压力测试
// ════════════════════════════════════════════════
async function stressTaskRouter () {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  1. TaskRouter 批量路由压力测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  const BaseToolAdapter = require('../src/adapters/BaseToolAdapter');
  const TaskRouter = require('../src/core/TaskRouter');

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
    createMockAdapter('atom-code', ['python', 'javascript', 'java'], ['code_writer']),
    createMockAdapter('hermes-agent', ['python', 'go', 'rust'], ['code_writer', 'code_reviewer']),
    createMockAdapter('mimo-code', ['python', 'html', 'css'], ['code_writer', 'tester']),
    createMockAdapter('trae', ['python', 'javascript', 'go', 'rust', 'java'], ['architect', 'code_writer', 'code_reviewer']),
    createMockAdapter('open-code', ['python', 'javascript', 'typescript', 'go', 'rust'], ['code_writer', 'tester'])
  ];

  const roles = ['architect', 'code_writer', 'code_reviewer', 'tester'];

  await test('轮询策略 - 100个任务路由', async () => {
    const router = new TaskRouter(adapters, { strategy: 'round_robin' });
    const tasks = Array.from({ length: 100 }, (_, i) => ({
      id: `T${i + 1}`, title: `任务${i + 1}`, role: roles[i % roles.length]
    }));
    const t0 = Date.now();
    const routed = router.routeTasks(tasks);
    const duration = Date.now() - t0;

    assertEqual(routed.length, 100);
    const assigned = routed.filter(r => r.adapter !== null).length;
    assertEqual(assigned, 100);

    stress('100任务路由耗时', duration, duration, 50, 'ms');
    stress('100任务分配率', assigned, 100, 100, '', true);
  });

  await test('轮询策略 - 500个任务路由', async () => {
    const router = new TaskRouter(adapters, { strategy: 'round_robin' });
    const tasks = Array.from({ length: 500 }, (_, i) => ({
      id: `T${i + 1}`, title: `任务${i + 1}`, role: roles[i % roles.length]
    }));
    const t0 = Date.now();
    const routed = router.routeTasks(tasks);
    const duration = Date.now() - t0;

    assertEqual(routed.length, 500);
    stress('500任务路由耗时', duration, duration, 200, 'ms');
  });

  await test('轮询策略 - 1000个任务路由', async () => {
    const router = new TaskRouter(adapters, { strategy: 'round_robin' });
    const tasks = Array.from({ length: 1000 }, (_, i) => ({
      id: `T${i + 1}`, title: `任务${i + 1}`, role: roles[i % roles.length]
    }));
    const t0 = Date.now();
    const routed = router.routeTasks(tasks);
    const duration = Date.now() - t0;

    assertEqual(routed.length, 1000);
    stress('1000任务路由耗时', duration, duration, 300, 'ms');

    // 验证负载均衡
    const toolCounts = {};
    for (const r of routed) {
      const name = r.adapter.name;
      toolCounts[name] = (toolCounts[name] || 0) + 1;
    }
    const counts = Object.values(toolCounts);
    const maxDiff = Math.max(...counts) - Math.min(...counts);
    stress('1000任务工具间最大偏差', maxDiff, maxDiff, 2);
  });

  await test('能力匹配 - 500个带语言/框架任务', async () => {
    const router = new TaskRouter(adapters, { strategy: 'capability' });
    const languages = ['python', 'javascript', 'go', 'rust', 'lua', 'java', 'typescript', 'html'];
    const tasks = Array.from({ length: 500 }, (_, i) => ({
      id: `T${i + 1}`,
      title: `任务${i + 1}`,
      language: languages[i % languages.length],
      role: roles[i % roles.length],
      complexity: ['low', 'medium', 'high'][i % 3]
    }));
    const t0 = Date.now();
    const routed = router.routeTasks(tasks);
    const duration = Date.now() - t0;

    assertEqual(routed.length, 500);
    stress('500任务能力匹配耗时', duration, duration, 500, 'ms');

    // 验证语言专用任务分配正确（仅 code_writer/tester 角色保证语言独占）
    const luaWriterTasks = routed.filter(r => r.task.language === 'lua' && (r.task.role === 'code_writer' || r.task.role === 'tester'));
    const luaToOpenclaw = luaWriterTasks.filter(r => r.adapter && r.adapter.name === 'openclaw');
    assert(luaToOpenclaw.length === luaWriterTasks.length, `Lua(code_writer/tester)任务应全部到 openclaw: ${luaToOpenclaw.length}/${luaWriterTasks.length}`);
  });

  await test('广播策略 - 100个任务广播', async () => {
    const router = new TaskRouter(adapters, { strategy: 'broadcast' });
    const tasks = Array.from({ length: 100 }, (_, i) => ({
      id: `T${i + 1}`, title: `广播任务${i + 1}`, role: roles[i % roles.length]
    }));
    const t0 = Date.now();
    const routed = router.routeTasks(tasks);
    const duration = Date.now() - t0;

    assertEqual(routed.length, 100);
    const broadcastCount = routed.filter(r => r.isBroadcast).length;
    assertEqual(broadcastCount, 100);
    stress('100任务广播路由耗时', duration, duration, 200, 'ms');

    // 验证广播标记已正确传递
    const firstRouted = routed[0];
    assert(firstRouted.isBroadcast === true, '广播模式应标记 isBroadcast');
  });

  await test('路由统计 - 1000任务统计性能', async () => {
    const router = new TaskRouter(adapters, { strategy: 'round_robin' });
    const tasks = Array.from({ length: 1000 }, (_, i) => ({
      id: `T${i + 1}`, title: `任务${i + 1}`, role: roles[i % roles.length]
    }));
    const routed = router.routeTasks(tasks);

    const t0 = Date.now();
    const stats = router.getRoutingStats(routed);
    const duration = Date.now() - t0;

    assertEqual(stats.totalTasks, 1000);
    assertEqual(stats.assignedTasks, 1000);
    stress('1000任务统计耗时', duration, duration, 100, 'ms');
  });

  await test('路由验证 - 1000任务混合场景', async () => {
    const router = new TaskRouter(adapters, { strategy: 'round_robin' });
    const tasks = Array.from({ length: 1000 }, (_, i) => ({
      id: `T${i + 1}`, title: `任务${i + 1}`, role: roles[i % roles.length]
    }));
    const routed = router.routeTasks(tasks);

    const t0 = Date.now();
    const validation = router.validateRouting(routed);
    const duration = Date.now() - t0;

    assert(validation.valid, `路由验证应有问题: ${validation.issues.join(', ')}`);
    stress('1000任务验证耗时', duration, duration, 100, 'ms');
  });

  await test('手动路由 - 1000任务精确分发', async () => {
    const router = new TaskRouter(adapters, {
      strategy: 'manual',
      manualRouting: {
        architect: 'claude-code',
        code_writer: 'qoder',
        code_reviewer: 'hermes-agent',
        tester: 'openclaw'
      }
    });
    const tasks = Array.from({ length: 1000 }, (_, i) => ({
      id: `T${i + 1}`, title: `任务${i + 1}`, role: roles[i % roles.length]
    }));
    const t0 = Date.now();
    const routed = router.routeTasks(tasks);
    const duration = Date.now() - t0;

    assertEqual(routed.length, 1000);
    stress('1000任务手动路由耗时', duration, duration, 300, 'ms');

    // 验证手动路由正确性
    const architectTasks = routed.filter(r => r.task.role === 'architect');
    const allArchitectToClaude = architectTasks.every(r => r.adapter && r.adapter.name === 'claude-code');
    assert(allArchitectToClaude, '架构师任务未全部到 claude-code');
  });
}

// ════════════════════════════════════════════════
// 2. ContractAssembler 大规模契约提取压力
// ════════════════════════════════════════════════
async function stressContractAssembler () {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  2. ContractAssembler 大规模契约提取压力'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  const ContractAssembler = require('../src/core/ContractAssembler');
  const assembler = new ContractAssembler({
    supportedLanguages: ['c', 'python', 'javascript', 'typescript', 'java', 'go', 'rust'],
    enableAIAssist: false
  });

  // 生成大代码块
  function generateCFunctions (count) {
    const funcs = [];
    for (let i = 0; i < count; i++) {
      funcs.push(`int func_${i}(int arg1, char* arg2) {
    // 处理第 ${i} 个功能
    int result = arg1 + ${i};
    printf("func_%d called with %s\\n", result, arg2);
    return result;
}`);
    }
    return funcs.join('\n\n');
  }

  function generatePythonClasses (count) {
    const classes = [];
    for (let i = 0; i < count; i++) {
      classes.push(`class Handler${i}:
    """Handles ${i}th type of request."""
    def __init__(self, config: dict):
        self.config = config
        self.name = f"handler_{${i}}"
    
    def process(self, data: str) -> dict:
        """Process the input data."""
        return {"handler": self.name, "result": data.strip()}
    
    def validate(self) -> bool:
        return len(self.config) > 0`);
    }
    return classes.join('\n\n');
  }

  // 超大量代码 - 生成500个C函数
  await test('C语言 - 500个函数契约提取', async () => {
    const megaCode = generateCFunctions(500);
    const codeSize = megaCode.length;

    const t0 = Date.now();
    const contracts = await assembler.extractContracts([
      { language: 'c', code: megaCode, filePath: 'mega_math.c' }
    ]);
    const duration = Date.now() - t0;

    assertEqual(contracts.length, 1);
    assert(contracts[0].functions.length >= 400, `应提取至少400个函数, 实际 ${contracts[0].functions.length}`);

    stress('500函数提取耗时', duration, duration, 5000, 'ms');
    stress('500函数提取数量', contracts[0].functions.length, contracts[0].functions.length, 500);
    console.log(chalk.gray(`    代码大小: ${(codeSize / 1024).toFixed(1)}KB, 提取函数: ${contracts[0].functions.length}个`));
  });

  // 超大Python类
  await test('Python - 200个类契约提取', async () => {
    const megaCode = generatePythonClasses(200);
    const codeSize = megaCode.length;

    const t0 = Date.now();
    const contracts = await assembler.extractContracts([
      { language: 'python', code: megaCode, filePath: 'mega_handler.py' }
    ]);
    const duration = Date.now() - t0;

    assertEqual(contracts.length, 1);
    assert(contracts[0].classes.length >= 150, `应提取至少150个类, 实际 ${contracts[0].classes.length}`);

    stress('200类提取耗时', duration, duration, 5000, 'ms');
    console.log(chalk.gray(`    代码大小: ${(codeSize / 1024).toFixed(1)}KB, 提取类: ${contracts[0].classes.length}个`));
  });

  // 多源合并压力
  await test('多源拼装 - 8个来源各100行', async () => {
    const sources = [];
    for (let i = 0; i < 8; i++) {
      const sourceCode = `
def process_part${i}(data: dict) -> dict:
    """Process part ${i} of the pipeline."""
    result = {"part": ${i}, "status": "ok"}
    for key, value in data.items():
        result[f"processed_{key}"] = str(value) + "_${i}"
    return result

class Stage${i}:
    def __init__(self):
        self.stage_id = ${i}
    
    def execute(self, input_data: dict) -> dict:
        return process_part${i}(input_data)
`;
      sources.push({ language: 'python', code: sourceCode, filePath: `agent_${i}_output.py` });
    }

    const t0 = Date.now();
    const contracts = await assembler.extractContracts(sources);
    const extractionDuration = Date.now() - t0;

    assertEqual(contracts.length, 8);

    const t1 = Date.now();
    const result = await assembler.assemble(contracts, { language: 'python', strictMode: false });
    const assembleDuration = Date.now() - t1;
    const totalDuration = Date.now() - t0;

    assert(result.success, `契约拼装失败: ${result.error}`);
    stress('8源提取耗时', extractionDuration, extractionDuration, 1000, 'ms');
    stress('8源拼装耗时', assembleDuration, assembleDuration, 500, 'ms');
    stress('8源总耗时', totalDuration, totalDuration, 1500, 'ms');
  });

  // 所有语言同时提取
  await test('7种语言并行契约提取', async () => {
    const blocks = [
      { language: 'c', code: 'int add(int a, int b);\nvoid print(const char* msg);\nfloat divide(float a, float b);', filePath: 'ops.c' },
      { language: 'python', code: 'def hello(name: str) -> str:\n    return "Hello " + name\n\nclass Calc:\n    def add(self, a: int, b: int) -> int:\n        return a + b', filePath: 'calc.py' },
      { language: 'javascript', code: 'function add(a, b) { return a + b; }\nconst multiply = (a, b) => a * b;\nexport function calculate(x, y) { return add(x, y) * multiply(x, y); }', filePath: 'math.js' },
      { language: 'typescript', code: 'interface User { id: number; name: string; }\ntype Result<T> = { success: boolean; data: T };\nfunction getUser(id: number): Promise<User> { return fetch("/api/users/" + id).then(r => r.json()); }', filePath: 'user.ts' },
      { language: 'go', code: 'type User struct { ID int64; Name string }\ntype Storage interface { Get(id int64) (*User, error); Save(user *User) error }\nfunc NewService(s Storage) *Service { return &Service{storage: s} }', filePath: 'main.go' },
      { language: 'rust', code: 'pub struct Config { pub host: String, pub port: u16 }\npub trait Handler { fn handle(&self, request: &str) -> String; }\npub fn start(config: Config) -> Result<(), String> { Ok(()) }', filePath: 'main.rs' },
      { language: 'java', code: 'public class Calculator {\n    public int add(int a, int b) { return a + b; }\n    public int subtract(int a, int b) { return a - b; }\n    public interface MathOp { int operate(int a, int b); }\n}', filePath: 'Calc.java' }
    ];

    const t0 = Date.now();
    const contracts = await assembler.extractContracts(blocks);
    const duration = Date.now() - t0;

    assertEqual(contracts.length, 7);
    stress('7语言并行提取耗时', duration, duration, 500, 'ms');

    const langSummary = contracts.map(c => `${c.language}: ${c.functions.length}f ${c.classes.length}c ${c.interfaces.length}i`).join(', ');
    console.log(chalk.gray(`    提取摘要: ${langSummary}`));
  });

  // 超大单文件压力
  await test('超大单文件 - 10000行代码契约提取', async () => {
    let megaCode = '// 自动生成超大文件\n';
    for (let i = 0; i < 1000; i++) {
      megaCode += `
function handleOperation_${i}(param1, param2, param3) {
    // Operation ${i}
    const result = param1 + param2 * param3;
    const transformed = transform(result, ${i}, ${i % 10});
    return {
        operation: ${i},
        input: { param1, param2, param3 },
        result: transformed,
        status: transformed > 0 ? 'success' : 'failure'
    };
}

class OperationHandler_${i} {
    constructor(config) {
        this.id = ${i};
        this.config = config || {};
    }
    
    async execute(ctx) {
        if (!ctx) throw new Error('Context required');
        const start = Date.now();
        const data = ctx.getData(this.id);
        const processed = this._process(data);
        return { id: this.id, result: processed, duration: Date.now() - start };
    }
    
    _process(data) {
        return data.map(x => x * ${i + 1});
    }
}
`;
    }

    const codeSize = megaCode.length;

    const t0 = Date.now();
    const contracts = await assembler.extractContracts([
      { language: 'javascript', code: megaCode, filePath: 'mega_handler.js' }
    ]);
    const duration = Date.now() - t0;

    assertEqual(contracts.length, 1);
    stress('10000行超大文件提取耗时', duration, duration, 10000, 'ms');
    console.log(chalk.gray(`    代码大小: ${(codeSize / 1024).toFixed(1)}KB, 提取函数: ${contracts[0].functions.length}个, 类: ${contracts[0].classes.length}个`));

    // 性能指标
    const funcsCount = contracts[0].functions.length;
    const classesCount = contracts[0].classes.length;
    const totalElements = funcsCount + classesCount;
    const throughput = Math.round(totalElements / (duration / 1000));
    console.log(chalk.gray(`    吞吐量: ${throughput} 元素/秒`));
    stress('超大文件吞吐量', throughput, throughput, 1000, '', true);

    // 验证提取数量合理（更多是好现象，使用断言而非压力指标）
    assert(totalElements >= 1000, `应提取至少1000个元素, 实际 ${totalElements}`);
    console.log(chalk.gray(`    ✅ 元素提取数达标: ${totalElements} >= 1000`));
  });
}

// ════════════════════════════════════════════════
// 3. ExecutionModeManager 高频切换压力
// ════════════════════════════════════════════════
async function stressExecutionMode () {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  3. ExecutionModeManager 高频模式切换压力'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  const modes = ['privacy', 'quality', 'efficiency'];

  await test('模式切换 - 1000次快速切换', async () => {
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const mgr = new ExecutionModeManager();

    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      mgr.setMode(modes[i % 3]);
      const config = mgr.getModeConfig();
      assert(config.name === modes[i % 3]);
    }
    const duration = Date.now() - t0;

    stress('1000次模式切换耗时', duration, duration, 100, 'ms');
  });

  await test('模式对比 - 1000次调用', async () => {
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const mgr = new ExecutionModeManager();

    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      const comparison = mgr.compareModes('privacy', 'quality');
      assert(Array.isArray(comparison.dimensions));
    }
    const duration = Date.now() - t0;

    stress('1000次模式对比耗时', duration, duration, 200, 'ms');
  });

  await test('模式推荐 - 1000次不同描述', async () => {
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const mgr = new ExecutionModeManager();

    const descriptions = [];
    for (let i = 0; i < 1000; i++) {
      const categories = ['私密项目核心代码', '高质量重构优化', '大规模并行分布式', '实现一个简单计算器'];
      descriptions.push(`${categories[i % 4]} ${i}`);
    }

    const t0 = Date.now();
    for (const desc of descriptions) {
      const result = mgr.recommendMode(desc);
      assert(result.mode, '应有推荐模式');
      assert(result.confidence >= 0);
    }
    const duration = Date.now() - t0;

    stress('1000次模式推荐耗时', duration, duration, 200, 'ms');
  });

  await test('配置读取 - 10000次深度遍历', async () => {
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const mgr = new ExecutionModeManager();

    const t0 = Date.now();
    for (let i = 0; i < 10000; i++) {
      const mode = modes[i % 3];
      mgr.getSplitterConfig(mode);
      mgr.getCodeGenerationConfig(mode);
      mgr.getQualityCheckConfig(mode);
      mgr.getMergingConfig(mode);
      mgr.getRoutingConfig(mode);
      mgr.getPrivacyConfig(mode);
    }
    const duration = Date.now() - t0;

    stress('10000次配置深度遍历耗时', duration, duration, 200, 'ms');
  });

  // 极限场景 - 未知模式处理
  await test('未知模式降级行为 - 100次', async () => {
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const mgr = new ExecutionModeManager();

    for (let i = 0; i < 100; i++) {
      try {
        mgr.setMode(`nonexistent_mode_${i}`);
        assert(false, '应抛出异常');
      } catch (e) {
        assert(e.message.includes('未知模式') || e.message.includes('privacy'), '异常信息应包含可选模式');
      }
    }
    // 降级后应为 privacy
    assertEqual(mgr.getCurrentMode(), 'privacy');
  });
}

// ════════════════════════════════════════════════
// 4. MergeEngine 多源合并压力
// ════════════════════════════════════════════════
async function stressMergeEngine () {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  4. MergeEngine 多源合并压力测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('合并 - 20个Agent结果', async () => {
    const MergeEngine = require('../src/agents/MergeEngine');
    const engine = new MergeEngine(null, { name: 'stress-merge' });

    const agentResults = {};
    for (let i = 0; i < 20; i++) {
      agentResults[`agent_${i}`] = {
        success: true,
        result: {
          codeBlocks: [
            { language: 'python', code: `def func_${i}(): return ${i}`, filePath: `module_${i}.py` }
          ]
        }
      };
    }

    const t0 = Date.now();
    const result = await engine.merge(agentResults);
    const duration = Date.now() - t0;

    assert(result.mergedCode, '合并代码不应为空');
    stress('20源合并耗时', duration, duration, 1000, 'ms');
  });

  await test('合并 - 50个Agent结果（含失败）', async () => {
    const MergeEngine = require('../src/agents/MergeEngine');
    const engine = new MergeEngine(null, { name: 'stress-merge-50' });

    const agentResults = {};
    for (let i = 0; i < 50; i++) {
      agentResults[`agent_${i}`] = {
        success: i % 5 !== 0, // 20% 失败率
        error: i % 5 === 0 ? `Simulated failure ${i}` : undefined,
        result: i % 5 === 0
          ? undefined
          : {
            codeBlocks: [
              { language: 'python', code: `def handler_${i}(data): return data * ${i}`, filePath: `handler_${i}.py` }
            ]
          }
      };
    }

    const t0 = Date.now();
    const result = await engine.merge(agentResults);
    const duration = Date.now() - t0;

    assert(result.mergedCode, '合并代码不应为空');
    stress('50源(含20%失败)合并耗时', duration, duration, 2000, 'ms');
  });

  await test('合并报告生成 - 50次', async () => {
    const MergeEngine = require('../src/agents/MergeEngine');
    const engine = new MergeEngine(null);

    const agentResults = {};
    for (let i = 0; i < 10; i++) {
      agentResults[`agent_${i}`] = {
        success: true,
        result: {
          codeBlocks: [
            { language: 'python', code: `def func_${i}(): pass`, filePath: `f${i}.py` }
          ]
        }
      };
    }

    const mergeResult = await engine.merge(agentResults);

    const t0 = Date.now();
    for (let i = 0; i < 50; i++) {
      const report = engine.generateMergeReport(agentResults, mergeResult);
      assert(report, '报告不应为空');
    }
    const duration = Date.now() - t0;

    stress('50次合并报告生成耗时', duration, duration, 500, 'ms');
  });
}

// ════════════════════════════════════════════════
// 5. AgentHub 大规模配置压力
// ════════════════════════════════════════════════
async function stressAgentHub () {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  5. AgentHub 大规模配置压力测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('AgentHub 创建和初始化', async () => {
    const AgentHub = require('../src/core/AgentHub');
    const hub = new AgentHub({ configDir: './test_stress_config' });

    const t0 = Date.now();
    await hub.initialize();
    const duration = Date.now() - t0;

    assert(hub.initialized, '初始化失败');
    assert(hub.getConfig(), '配置不存在');
    stress('AgentHub初始化耗时', duration, duration, 500, 'ms');

    // 清理
    try {
      fs.rmSync('./test_stress_config', { recursive: true });
    } catch (e) {}
  });

  await test('AgentHub - 1000次 Agent 查询', async () => {
    const AgentHub = require('../src/core/AgentHub');
    const hub = new AgentHub({ configDir: './test_stress_config2' });
    await hub.initialize();

    const names = ['ollama', 'openai', 'anthropic', 'deepseek'];

    // 启用所有 agent
    hub.enableAgent('openai');
    hub.enableAgent('anthropic');
    hub.enableAgent('deepseek');

    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      const agent = hub.getAgent(names[i % 4]);
      assert(agent !== undefined, `Agent ${names[i % 4]} 应存在`);
    }
    const duration = Date.now() - t0;

    stress('1000次Agent查询耗时', duration, duration, 100, 'ms');

    try {
      fs.rmSync('./test_stress_config2', { recursive: true });
    } catch (e) {}
  });

  await test('AgentHub - 1000次配置更新', async () => {
    const AgentHub = require('../src/core/AgentHub');
    const hub = new AgentHub({ configDir: './test_stress_config3' });
    await hub.initialize();

    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      hub.updateAgentConfig('ollama', { timeout: 10000 + (i % 1000) });
    }
    const duration = Date.now() - t0;

    const agent = hub.getAgent('ollama');
    stress('1000次配置更新耗时', duration, duration, 2000, 'ms');
    assert(agent, 'ollama 应在更新后仍存在');

    try {
      fs.rmSync('./test_stress_config3', { recursive: true });
    } catch (e) {}
  });

  await test('AgentHub - 100次启用/禁用循环', async () => {
    const AgentHub = require('../src/core/AgentHub');
    const hub = new AgentHub({ configDir: './test_stress_config4' });
    await hub.initialize();

    const t0 = Date.now();
    for (let i = 0; i < 100; i++) {
      hub.enableAgent('openai');
      hub.enableAgent('anthropic');
      hub.disableAgent('openai');
      hub.disableAgent('anthropic');
    }
    const duration = Date.now() - t0;

    stress('100次启用/禁用循环耗时', duration, duration, 500, 'ms');

    try {
      fs.rmSync('./test_stress_config4', { recursive: true });
    } catch (e) {}
  });
}

// ════════════════════════════════════════════════
// 6. CacheStore 高并发读写压力
// ════════════════════════════════════════════════
async function stressCacheStore () {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  6. CacheStore 高并发读写压力测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('CacheStore - 10000次写入', async () => {
    const CacheStore = require('../src/utils/CacheStore');
    const store = new CacheStore({ maxSize: 20000, maxAge: 3600000, persistDir: './test_stress_cache' });

    const t0 = Date.now();
    for (let i = 0; i < 10000; i++) {
      store.set(`key_${i}`, { data: `value_${i}`, timestamp: Date.now() });
    }
    const duration = Date.now() - t0;
    const stats = store.getStats();

    stress('10000次缓存写入耗时', duration, duration, 500, 'ms');
    stress('缓存大小', stats.size, stats.size, 10000, '', true);

    try {
      fs.rmSync('./test_stress_cache', { recursive: true });
    } catch (e) {}
  });

  await test('CacheStore - 50000次混合读写', async () => {
    const CacheStore = require('../src/utils/CacheStore');
    const store = new CacheStore({ maxSize: 100000, maxAge: 3600000, persistDir: './test_stress_cache2' });

    // 先写入10000条
    for (let i = 0; i < 10000; i++) {
      store.set(`key_${i}`, { data: `value_${i}` });
    }

    const t0 = Date.now();
    for (let i = 0; i < 50000; i++) {
      if (i % 2 === 0) {
        store.get(`key_${i % 10000}`);
      } else {
        store.set(`new_key_${i}`, { data: `new_value_${i}` });
      }
    }
    const duration = Date.now() - t0;

    stress('50000次混合读写耗时', duration, duration, 500, 'ms');

    try {
      fs.rmSync('./test_stress_cache2', { recursive: true });
    } catch (e) {}
  });

  await test('CacheStore - 10000次语义相似搜索', async () => {
    const CacheStore = require('../src/utils/CacheStore');
    const store = new CacheStore({ maxSize: 5000, maxAge: 3600000, persistDir: './test_stress_cache3' });

    // 写入已知数据
    store.setTaskResponse('task_1', 'agent_1', { prompt: '写一个Python函数计算斐波那契数列', response: 'def fib(n): ...' });
    store.setTaskResponse('task_2', 'agent_2', { prompt: '实现一个二叉搜索树', response: 'class BST: ...' });

    const t0 = Date.now();
    for (let i = 0; i < 10000; i++) {
      store.findSimilar(`test query ${i}`, 0.5);
    }
    const duration = Date.now() - t0;

    stress('10000次相似搜索耗时', duration, duration, 500, 'ms');

    try {
      fs.rmSync('./test_stress_cache3', { recursive: true });
    } catch (e) {}
  });
}

// ════════════════════════════════════════════════
// 7. MemoryStore 大数据持久化压力
// ════════════════════════════════════════════════
async function stressMemoryStore () {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  7. MemoryStore 大数据持久化压力测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('MemoryStore - 5000个任务存储', async () => {
    const MemoryStore = require('../src/core/MemoryStore');
    const store = new MemoryStore({ persistDir: './test_stress_memory' });

    const t0 = Date.now();
    for (let i = 0; i < 5000; i++) {
      store.put(`task_${i}`, 'content', `这是任务 ${i} 的内容，包含一些模拟数据用于压力测试`);
      store.put(`task_${i}`, 'codeBlocks', [`code_block_${i}`]);
      store.put(`task_${i}`, 'qualityScore', Math.random() * 100);
      store.put(`task_${i}`, 'status', i % 2 === 0 ? 'completed' : 'failed');
    }
    const duration = Date.now() - t0;

    stress('5000个任务写入耗时', duration, duration, 500, 'ms');
    stress('全局数据量', Object.keys(store.store.tasks).length, Object.keys(store.store.tasks).length, 5000, '', true);

    try {
      fs.rmSync('./test_stress_memory', { recursive: true });
    } catch (e) {}
  });

  await test('MemoryStore - 10000次全局读写', async () => {
    const MemoryStore = require('../src/core/MemoryStore');
    const store = new MemoryStore({ persistDir: './test_stress_memory2' });

    const t0 = Date.now();
    for (let i = 0; i < 10000; i++) {
      store.setGlobal(`config_${i}`, { value: i, enabled: i % 2 === 0 });
      const val = store.getGlobal(`config_${i}`);
      assert(val !== null, `config_${i} 应存在`);
    }
    const duration = Date.now() - t0;

    stress('10000次全局读写耗时', duration, duration, 500, 'ms');

    try {
      fs.rmSync('./test_stress_memory2', { recursive: true });
    } catch (e) {}
  });

  await test('MemoryStore - 10000次标签查询', async () => {
    const MemoryStore = require('../src/core/MemoryStore');
    const store = new MemoryStore({ persistDir: './test_stress_memory3' });

    for (let i = 0; i < 1000; i++) {
      store.put(`task_${i}`, 'content', `Task ${i}`);
      store.addTag(`task_${i}`, `tag_${i % 20}`);
    }

    const t0 = Date.now();
    for (let i = 0; i < 10000; i++) {
      const results = store.queryByTag(`tag_${i % 20}`);
      assert(results.length > 0, `tag_${i % 20} 应有结果`);
    }
    const duration = Date.now() - t0;

    stress('10000次标签查询耗时', duration, duration, 500, 'ms');

    try {
      fs.rmSync('./test_stress_memory3', { recursive: true });
    } catch (e) {}
  });
}

// ════════════════════════════════════════════════
// 8. TokenCounter 大量计费压力
// ════════════════════════════════════════════════
async function stressTokenCounter () {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  8. TokenCounter 大量计费压力测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('TokenCounter - 50000次计费记录', async () => {
    const TokenCounter = require('../src/utils/TokenCounter');
    const counter = new TokenCounter({ maxHistory: 50000 });

    const t0 = Date.now();
    for (let i = 0; i < 50000; i++) {
      counter.record(
        ['ollama', 'openai', 'anthropic', 'qoder'][i % 4],
        `task_${i}`,
        `这是第 ${i} 个任务的提示词，包含一些模拟内容用于测试`,
        `这是第 ${i} 个任务的响应，包含生成的代码和说明`,
        { model: `model_${i % 3}` }
      );
    }
    const duration = Date.now() - t0;
    const stats = counter.getStats();

    stress('50000次计费记录耗时', duration, duration, 500, 'ms');
    stress('计费总Token数', stats.total, stats.total, 5000000);
    stress('各Agent数据完整性', Object.keys(stats.byAgent).length, Object.keys(stats.byAgent).length, 4, '', true);
  });

  await test('TokenCounter - 100000次 token 估算', async () => {
    const TokenCounter = require('../src/utils/TokenCounter');
    const counter = new TokenCounter();

    const samples = [];
    for (let i = 0; i < 100000; i++) {
      samples.push(`这是样本 ${i} 的文本内容，包含中英文混合 text and Chinese，以及一些代码片段 console.log("test")`);
    }

    const t0 = Date.now();
    for (const sample of samples) {
      counter.estimateTokens(sample);
    }
    const duration = Date.now() - t0;

    stress('100000次Token估算耗时', duration, duration, 500, 'ms');
  });

  await test('TokenCounter - 大文本估算', async () => {
    const TokenCounter = require('../src/utils/TokenCounter');
    const counter = new TokenCounter();

    // 生成1MB文本
    const largeText = Buffer.alloc(1024 * 1024, 'A large text for token counting pressure test with Chinese 中文混合. ').toString();

    const t0 = Date.now();
    for (let i = 0; i < 100; i++) {
      counter.estimateTokens(largeText);
    }
    const duration = Date.now() - t0;

    stress('100次1MB文本估算耗时', duration, duration, 2000, 'ms');
  });
}

// ════════════════════════════════════════════════
// 9. ContextCompressor 大文件压缩压力
// ════════════════════════════════════════════════
async function stressContextCompressor () {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  9. ContextCompressor 大文件压缩压力测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('ContextCompressor - 压缩10MB代码', async () => {
    const ContextCompressor = require('../src/utils/ContextCompressor');
    const compressor = new ContextCompressor({ maxContextTokens: 500 });

    // 生成10MB代码
    let largeCode = '';
    for (let i = 0; i < 50000; i++) {
      largeCode += `function test_${i}(param1, param2) {
    // This is test function ${i}
    const result = param1 + param2;
    return result;
}

// TODO: 需要优化第 ${i} 个函数
class Handler_${i} {
    constructor(config) {
        this.config = config;
        this.id = ${i};
    }
    
    process(data) {
        return data.map(x => x * this.id);
    }
}
`;
    }

    const t0 = Date.now();
    const compressed = compressor.compressCode(largeCode, { maxTokens: 1000 });
    const duration = Date.now() - t0;
    const ratio = ((1 - compressed.length / largeCode.length) * 100).toFixed(1);

    stress('10MB代码压缩耗时', duration, duration, 3000, 'ms');
    console.log(chalk.gray(`    原始: ${(largeCode.length / 1024 / 1024).toFixed(2)}MB → 压缩后: ${(compressed.length / 1024).toFixed(1)}KB (压缩率 ${ratio}%)`));
  });

  await test('ContextCompressor - 100次重复压缩', async () => {
    const ContextCompressor = require('../src/utils/ContextCompressor');
    const compressor = new ContextCompressor({ maxContextTokens: 2000 });

    const sampleCode = `
import React from 'react';
import { useState, useEffect } from 'react';

function App() {
    const [count, setCount] = useState(0);
    
    useEffect(() => {
        document.title = \`Count: \${count}\`;
    }, [count]);
    
    return (
        <div>
            <h1>Counter: {count}</h1>
            <button onClick={() => setCount(c => c + 1)}>+</button>
        </div>
    );
}

export default App;
`;

    const t0 = Date.now();
    let totalCompressed = 0;
    for (let i = 0; i < 100; i++) {
      const compressed = compressor.compressCode(sampleCode);
      totalCompressed += compressed.length;
    }
    const duration = Date.now() - t0;

    stress('100次压缩耗时', duration, duration, 200, 'ms');
    assert(totalCompressed > 0, '压缩输出不应为空');
  });
}

// ════════════════════════════════════════════════
// 10. 边缘/异常场景测试
// ════════════════════════════════════════════════
async function testEdgeCases () {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  10. 边缘与异常场景测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('TaskRouter - 空适配器列表', async () => {
    const TaskRouter = require('../src/core/TaskRouter');
    const router = new TaskRouter([]);
    const routes = router.routeTasks([{ id: 'T1', title: 'test' }]);
    assertEqual(routes.length, 1);
    assertEqual(routes[0].adapter, null);
    assert(routes[0].reason, '应返回原因');
  });

  await test('TaskRouter - 所有适配器不可用', async () => {
    const BaseToolAdapter = require('../src/adapters/BaseToolAdapter');
    const TaskRouter = require('../src/core/TaskRouter');

    const adapter = new BaseToolAdapter({ name: 'test', displayName: 'Test' });
    adapter.isAvailable = () => false;

    const router = new TaskRouter([adapter]);
    const routes = router.routeTasks([{ id: 'T1', title: 'test' }]);
    assertEqual(routes[0].adapter, null);
  });

  await test('ContractAssembler - 空代码输入', async () => {
    const ContractAssembler = require('../src/core/ContractAssembler');
    const assembler = new ContractAssembler({ enableAIAssist: false });

    const contracts = await assembler.extractContracts([]);
    assertEqual(contracts.length, 0);
  });

  await test('ContractAssembler - 不支持的语言', async () => {
    const ContractAssembler = require('../src/core/ContractAssembler');
    const assembler = new ContractAssembler({ supportedLanguages: ['python'], enableAIAssist: false });

    const contracts = await assembler.extractContracts([
      { language: 'brainfuck', code: '+++>+++', filePath: 'test.bf' }
    ]);
    assertEqual(contracts.length, 0);
  });

  await test('ContractAssembler - 空字符串代码', async () => {
    const ContractAssembler = require('../src/core/ContractAssembler');
    const assembler = new ContractAssembler({ enableAIAssist: false });

    const contracts = await assembler.extractContracts([
      { language: 'python', code: '', filePath: 'empty.py' }
    ]);
    // 应优雅处理空代码，不抛异常
    assert(Array.isArray(contracts));
  });

  await test('MemoryStore - 超大value持久化', async () => {
    const MemoryStore = require('../src/core/MemoryStore');
    const store = new MemoryStore({ persistDir: './test_stress_edge' });

    const largeValue = Buffer.alloc(1024 * 100, 'x').toString(); // 100KB
    store.setGlobal('large_data', largeValue);
    const retrieved = store.getGlobal('large_data');

    assertEqual(retrieved.length, largeValue.length);

    try {
      fs.rmSync('./test_stress_edge', { recursive: true });
    } catch (e) {}
  });

  await test('TokenCounter - 空值/undefined/null', async () => {
    const TokenCounter = require('../src/utils/TokenCounter');
    const counter = new TokenCounter();

    assertEqual(counter.estimateTokens(null), 0);
    assertEqual(counter.estimateTokens(undefined), 0);
    assertEqual(counter.estimateTokens(''), 0);
    assertEqual(counter.estimateTokens(12345), 0); // 非字符串
  });

  await test('ContextCompressor - 空代码', async () => {
    const ContextCompressor = require('../src/utils/ContextCompressor');
    const compressor = new ContextCompressor();

    assertEqual(compressor.compressCode(''), '');
    assertEqual(compressor.compressCode(null), '');
    assertEqual(compressor.compressCode(undefined), '');
  });

  await test('AgentHub - 无效配置路径', async () => {
    const AgentHub = require('../src/core/AgentHub');
    const hub = new AgentHub({ configDir: './nonexistent_dir/config' });

    // 应创建默认配置而非抛异常
    await hub.initialize();
    assert(hub.initialized, '即使配置不存在也应初始化成功');
    assert(hub.getConfig(), '应有默认配置');

    try {
      fs.rmSync('./nonexistent_dir', { recursive: true });
    } catch (e) {}
  });

  await test('ExecutionModeManager - 所有配置字段验证', async () => {
    const ExecutionModeManager = require('../src/core/ExecutionModeManager');
    const mgr = new ExecutionModeManager();

    for (const modeName of ['privacy', 'quality', 'efficiency']) {
      const fullConfig = mgr.getModeConfig(modeName);
      // 验证所有必要字段
      assert(fullConfig.name, `mode ${modeName} 缺少 name`);
      assert(fullConfig.displayName, `mode ${modeName} 缺少 displayName`);
      assert(fullConfig.splitter, `mode ${modeName} 缺少 splitter`);
      assert(fullConfig.codeGeneration, `mode ${modeName} 缺少 codeGeneration`);
      assert(fullConfig.qualityCheck, `mode ${modeName} 缺少 qualityCheck`);
      assert(fullConfig.merging, `mode ${modeName} 缺少 merging`);
      assert(fullConfig.routing, `mode ${modeName} 缺少 routing`);
      assert(fullConfig.privacy, `mode ${modeName} 缺少 privacy`);
    }
  });
}

// ════════════════════════════════════════════════
// 11. 长时间运行稳定性测试
// ════════════════════════════════════════════════
async function stressLongRunning () {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  11. 长时间运行稳定性测试'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('Router + MergeEngine - 100轮循环无内存泄漏', async () => {
    const BaseToolAdapter = require('../src/adapters/BaseToolAdapter');
    const TaskRouter = require('../src/core/TaskRouter');
    const MergeEngine = require('../src/agents/MergeEngine');

    const createMockAdapter = (name, langs, roles) => {
      const adapter = new BaseToolAdapter({ name, displayName: name });
      adapter.isAvailable = () => true;
      adapter.languages = langs;
      adapter.roles = roles;
      return adapter;
    };

    const adapters = [
      createMockAdapter('tool-a', ['python'], ['code_writer']),
      createMockAdapter('tool-b', ['javascript'], ['code_writer']),
      createMockAdapter('tool-c', ['go', 'rust'], ['code_writer']),
      createMockAdapter('tool-d', ['java'], ['code_writer'])
    ];

    const router = new TaskRouter(adapters, { strategy: 'round_robin' });
    const engine = new MergeEngine(null, { name: 'longrun' });
    const roles = ['code_writer', 'architect', 'tester', 'code_reviewer'];

    const memBefore = getHeapInMB();

    for (let round = 0; round < 100; round++) {
      const tasks = Array.from({ length: 50 }, (_, i) => ({
        id: `R${round}_T${i}`, title: `Task ${i}`, role: roles[i % roles.length]
      }));

      const routed = router.routeTasks(tasks);
      assertEqual(routed.length, 50);

      const agentResults = {};
      for (let i = 0; i < 10; i++) {
        agentResults[`agent_${round}_${i}`] = {
          success: true,
          result: { codeBlocks: [{ language: 'python', code: `def f${round}_${i}(): return ${i}`, filePath: `f${round}_${i}.py` }] }
        };
      }

      const mergeResult = await engine.merge(agentResults);
      assert(mergeResult.mergedCode, `第${round}轮合并结果不应为空`);
    }

    const memAfter = getHeapInMB();
    const memDelta = memAfter - memBefore;

    console.log(chalk.gray(`    100轮循环 - 内存: ${memBefore}MB → ${memAfter}MB (变化 ${memDelta >= 0 ? '+' : ''}${memDelta}MB)`));
    stress('100轮后内存增量', memDelta, memDelta, 10, 'MB');
  });

  await test('CacheStore - 20000次操作循环', async () => {
    const CacheStore = require('../src/utils/CacheStore');
    const store = new CacheStore({ maxSize: 50000, maxAge: 3600000, persistDir: './test_stress_longrun' });

    const memBefore = getHeapInMB();

    for (let i = 0; i < 20000; i++) {
      store.set(`key_${i % 1000}`, { data: `value_${i}`, timestamp: Date.now() });
      if (i % 2 === 0) store.get(`key_${i % 1000}`);
    }

    const memAfter = getHeapInMB();
    const memDelta = memAfter - memBefore;

    stress('20000次缓存操作后内存增量', memDelta, memDelta, 20, 'MB');

    try {
      fs.rmSync('./test_stress_longrun', { recursive: true });
    } catch (e) {}
  });
}

// ════════════════════════════════════════════════
// 12. 内存快照与泄漏检测
// ════════════════════════════════════════════════
async function testMemoryLeaks () {
  console.log(chalk.bold.cyan('\n══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  12. 内存泄漏检测'));
  console.log(chalk.bold.cyan('══════════════════════════════════════\n'));

  await test('模块反复加载卸载 - 内存稳定性', async () => {
    const memBefore = process.memoryUsage().heapUsed;

    for (let cycle = 0; cycle < 100; cycle++) {
      // 反复卸载/重载核心模块
      delete require.cache[require.resolve('../src/core/TaskRouter')];
      delete require.cache[require.resolve('../src/core/ExecutionModeManager')];
      delete require.cache[require.resolve('../src/core/ContractAssembler')];

      const TaskRouter = require('../src/core/TaskRouter');
      const ExecutionModeManager = require('../src/core/ExecutionModeManager');
      const ContractAssembler = require('../src/core/ContractAssembler');

      const router = new TaskRouter([], { strategy: 'round_robin' });
      const mgr = new ExecutionModeManager();
      const assembler = new ContractAssembler({ enableAIAssist: false });

      mgr.setMode('quality');
      router.getStrategies();
      await assembler.extractContracts([]);

      if (cycle % 10 === 0 && cycle > 0) {
        global.gc && global.gc();
      }
    }

    const memAfter = process.memoryUsage().heapUsed;
    const memDelta = (memAfter - memBefore) / 1024 / 1024;

    console.log(chalk.gray(`    100次模块加载循环 - 内存变化: ${memDelta >= 0 ? '+' : ''}${memDelta.toFixed(2)}MB`));
    stress('模块循环加载内存增量', memDelta, memDelta, 20, 'MB');
  });

  // 记录最终内存快照
  measureMemory();
}

// ════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════
async function main () {
  console.log(chalk.bold.green('\n╔═══════════════════════════════════════════════════════╗'));
  console.log(chalk.bold.green('║       ai-orchestrator 全面压力测试套件             ║'));
  console.log(chalk.bold.green('║       ai-orchestrator Comprehensive Stress Test Suite   ║'));
  console.log(chalk.bold.green('╚═══════════════════════════════════════════════════════╝'));
  console.log(chalk.gray(`\n测试时间: ${new Date().toLocaleString()}`));
  console.log(chalk.gray(`Node.js: ${process.version}`));
  console.log(chalk.gray(`平台: ${process.platform}`));
  console.log(chalk.gray(`CPU: ${os.cpus().length}核`));
  console.log(chalk.gray(`内存: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)}GB`));

  measureMemory();

  try {
    // 1. 批量路由
    await stressTaskRouter();

    // 2. 契约提取
    await stressContractAssembler();

    // 3. 模式管理
    await stressExecutionMode();

    // 4. 合并引擎
    await stressMergeEngine();

    // 5. AgentHub
    await stressAgentHub();

    // 6. CacheStore
    await stressCacheStore();

    // 7. MemoryStore
    await stressMemoryStore();

    // 8. TokenCounter
    await stressTokenCounter();

    // 9. ContextCompressor
    await stressContextCompressor();

    // 10. 边缘场景
    await testEdgeCases();

    // 11. 长时间运行
    await stressLongRunning();

    // 12. 内存泄漏
    await testMemoryLeaks();

    // ════════════════════════════════════════════
    // 最终报告
    // ════════════════════════════════════════════
    const totalTests = results.length;
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const totalDuration = Date.now() - startTime;

    const stressPassed = stressResults.filter(r => r.passed).length;
    const stressFailed = stressResults.filter(r => !r.passed).length;
    const stressTotal = stressResults.length;

    const memEnd = process.memoryUsage();
    const memPeakIncrease = Math.max(...memorySnapshots.map(s => s.heapUsed)) - memorySnapshots[0].heapUsed;

    console.log(chalk.bold.cyan('\n═══════════════════════════════════════════════════════════'));
    console.log(chalk.bold.cyan('  压力测试报告摘要'));
    console.log(chalk.bold.cyan('═══════════════════════════════════════════════════════════\n'));

    console.log(chalk.white(`  功能测试: ${passed}/${totalTests}`));
    console.log(chalk.white(`  压力指标: ${stressPassed}/${stressTotal}`));
    console.log(chalk.green(`  通过: ${passed}`));
    console.log(chalk.red(`  失败: ${failed}`));
    console.log(chalk.gray(`  总耗时: ${(totalDuration / 1000).toFixed(1)}秒\n`));

    if (failed > 0) {
      console.log(chalk.bold.yellow('  失败测试详情:\n'));
      for (const r of results.filter(r => !r.passed)) {
        console.log(chalk.red(`  ❌ ${r.name} (${r.duration}ms)`));
        console.log(chalk.red(`     ${r.error}\n`));
      }
    }

    if (stressFailed > 0) {
      console.log(chalk.bold.yellow('  未达标压力指标:\n'));
      for (const r of stressResults.filter(r => !r.passed)) {
        console.log(chalk.red(`  ❌ ${r.name}: ${r.actual}${r.unit} > 阈值 ${r.threshold}${r.unit}\n`));
      }
    }

    const stressPassRate = Math.round((stressPassed / stressTotal) * 100);
    const funcPassRate = Math.round((passed / totalTests) * 100);
    const overallScore = Math.round((stressPassRate + funcPassRate) / 2);
    const grade = overallScore === 100 ? 'S' : overallScore >= 90 ? 'A' : overallScore >= 80 ? 'B' : overallScore >= 70 ? 'C' : 'D';

    console.log(chalk.bold.cyan('═══════════════════════════════════════════════════════════'));
    console.log(chalk.bold[overallScore >= 90 ? 'green' : 'yellow'](
      `  功能测试: ${funcPassRate}% | 压力指标达标率: ${stressPassRate}%`
    ));
    console.log(chalk.bold[overallScore >= 90 ? 'green' : 'yellow'](
      `  综合评估: ${overallScore}% - 等级 ${grade}`
    ));
    console.log(chalk.bold.cyan('═══════════════════════════════════════════════════════════\n'));

    // 内存报告
    console.log(chalk.bold('  内存使用报告:\n'));
    console.log(chalk.gray(`  起始堆内存: ${(memorySnapshots[0].heapUsed / 1024 / 1024).toFixed(2)}MB`));
    console.log(chalk.gray(`  峰值堆内存: ${(Math.max(...memorySnapshots.map(s => s.heapUsed)) / 1024 / 1024).toFixed(2)}MB`));
    console.log(chalk.gray(`  最终堆内存: ${(memEnd.heapUsed / 1024 / 1024).toFixed(2)}MB`));
    console.log(chalk.gray(`  峰值增量: ${(memPeakIncrease / 1024 / 1024).toFixed(2)}MB`));
    console.log(chalk.gray(`  RSS: ${(memEnd.rss / 1024 / 1024).toFixed(1)}MB`));

    // 保存报告
    const reportDir = path.join(__dirname, 'reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const report = {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
      cpuCores: os.cpus().length,
      totalMemory: `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)}GB`,
      summary: {
        functionalTests: { total: totalTests, passed, failed, passRate: `${funcPassRate}%` },
        stressMetrics: { total: stressTotal, passed: stressPassed, failed: stressFailed, passRate: `${stressPassRate}%` },
        overallScore: `${overallScore}%`,
        grade,
        duration: `${(totalDuration / 1000).toFixed(1)}s`
      },
      memory: {
        startHeapMB: parseFloat((memorySnapshots[0].heapUsed / 1024 / 1024).toFixed(2)),
        peakHeapMB: parseFloat((Math.max(...memorySnapshots.map(s => s.heapUsed)) / 1024 / 1024).toFixed(2)),
        endHeapMB: parseFloat((memEnd.heapUsed / 1024 / 1024).toFixed(2)),
        peakIncreaseMB: parseFloat((memPeakIncrease / 1024 / 1024).toFixed(2)),
        rssMB: parseFloat((memEnd.rss / 1024 / 1024).toFixed(1))
      },
      functionalResults: results,
      stressMetrics: stressResults
    };

    const reportPath = path.join(reportDir, `stress_test_${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(chalk.gray(`\n  报告已保存: ${reportPath}\n`));
  } catch (e) {
    console.error(chalk.red(`\n测试框架异常: ${e.message}`));
    console.error(e.stack);
    process.exit(1);
  }
}

main().catch(console.error);
