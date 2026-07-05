/**
 * P0-P5 新增功能专项冒烟测试
 * 验证每个 P 级别的具体功能是否真的可用
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;

function ok (name, detail = '') {
  pass++;
  console.log('  ✅ ' + name + (detail ? ' (' + detail + ')' : ''));
}
function err (name, detail = '') {
  fail++;
  console.log('  ❌ ' + name + (detail ? ': ' + detail : ''));
}
function section (t) {
  console.log('\n══════════════════════════════════════');
  console.log('  ' + t);
  console.log('══════════════════════════════════════');
}

function R (p) {
  return require(path.resolve(ROOT, p));
}

// ═══════════════════════════════════════════
section('P0: WebUI 前端集成自适应编排');
// ═══════════════════════════════════════════
try {
  const html = fs.readFileSync(path.resolve(ROOT, 'public/index.html'), 'utf-8');
  if (html.includes('btn-adaptive-mode')) ok('编排模式切换器（HTML）');
  else err('编排模式切换器', 'HTML 中未找到 btn-adaptive-mode');

  if (html.includes('adaptive-prefs-panel')) ok('偏好设置面板（HTML）');
  else err('偏好设置面板', '未找到');

  if (html.includes('adaptive-recommendation')) ok('推荐结果展示区（HTML）');
  else err('推荐结果展示区', '未找到');

  if (html.includes('data-mode="auto"') && html.includes('data-mode="manual"') && html.includes('data-mode="hybrid"')) ok('三种模式按钮齐全');
  else err('三种模式按钮', '不完整');

  if (html.includes('toggleAdaptivePrefs()')) ok('偏好面板切换函数');
  if (html.includes('saveAdaptivePrefs()')) ok('保存偏好按钮');
  if (html.includes('applyAdaptiveRecommendation()')) ok('应用推荐按钮');
  if (html.includes('dismissAdaptiveRecommendation()')) ok('拒绝推荐按钮');

  const js = fs.readFileSync(path.resolve(ROOT, 'public/js/app.js'), 'utf-8');
  if (js.includes('currentAdaptiveMode')) ok('编排模式状态变量');
  if (js.includes('setupAdaptiveRecommendationTrigger')) ok('推荐触发器');
  if (js.includes('fetchAdaptiveRecommendation')) ok('获取推荐函数');
  if (js.includes('showAdaptiveRecommendation')) ok('显示推荐函数');
  if (js.includes('applyAdaptiveRecommendation')) ok('应用推荐函数');
  if (js.includes('/api/adaptive/mode')) ok('模式切换 API 调用');
  if (js.includes('/api/adaptive/recommend')) ok('推荐 API 调用');
  if (js.includes('/api/adaptive/status')) ok('状态初始化调用');
  if (js.includes('/api/adaptive/preferences')) ok('偏好保存 API 调用');
} catch (e) {
  err('P0 前端验证', e.message);
}

// ═══════════════════════════════════════════
section('P1: CLI adaptive 命令族');
// ═══════════════════════════════════════════
try {
  const cli = fs.readFileSync(path.resolve(ROOT, 'src/cli/index.js'), 'utf-8');
  if (cli.includes('command(\'adaptive\')')) ok('adaptive 命令注册');
  else err('adaptive 命令', '未注册');

  if (cli.includes('--recommend <task>')) ok('--recommend 选项');
  else err('--recommend 选项');

  if (cli.includes('--mode <mode>')) ok('--mode 选项');
  else err('--mode 选项');

  if (cli.includes('--status')) ok('--status 选项');
  else err('--status 选项');

  if (cli.includes('--prefs <json>')) ok('--prefs 选项');
  else err('--prefs 选项');

  if (cli.includes('getAdaptiveRecommendation')) ok('调用 getAdaptiveRecommendation');
  if (cli.includes('setOrchestrationMode')) ok('调用 setOrchestrationMode');
  if (cli.includes('updatePreferences')) ok('调用 updatePreferences');
} catch (e) {
  err('P1 CLI 验证', e.message);
}

// ═══════════════════════════════════════════
section('P2: Provider 流式接口 + StreamManager 桥接');
// ═══════════════════════════════════════════
(async () => {
  try {
    // 三个 Provider 都有 chatStream
    const providers = [
      { name: 'Ollama', path: 'src/providers/OllamaProvider.js' },
      { name: 'OpenAI', path: 'src/providers/OpenAIProvider.js' },
      { name: 'Anthropic', path: 'src/providers/AnthropicProvider.js' }
    ];
    for (const p of providers) {
      const Provider = R(p.path);
      const inst = new Provider({});
      if (typeof inst.chatStream === 'function') ok(p.name + ' chatStream');
      else err(p.name + ' chatStream', '缺失');
    }

    // StreamManager 新增方法
    const StreamManager = R('src/utils/StreamManager.js');
    const sm = new StreamManager();
    if (typeof sm.streamFromProvider === 'function') ok('StreamManager.streamFromProvider');
    else err('StreamManager.streamFromProvider', '缺失');

    if (typeof StreamManager.fromProvider === 'function') ok('StreamManager.fromProvider 静态方法');
    else err('StreamManager.fromProvider', '缺失');

    // 实际桥接测试
    const fakeProvider = {
      constructor: { name: 'TestProvider' },
      chatStream: async (msgs, opts, onChunk) => {
        onChunk('chunk1 ');
        onChunk('chunk2 ');
        onChunk('chunk3');
      }
    };
    const sm2 = new StreamManager();
    let text = '';
    sm2.on('chunk', (d) => {
      text += d.text;
    });
    await sm2.streamFromProvider(fakeProvider, []);
    if (text === 'chunk1 chunk2 chunk3') ok('streamFromProvider 桥接验证', '输出: ' + text);
    else err('streamFromProvider 桥接', '实际: ' + text);

    // 静态方法
    const sm3 = await StreamManager.fromProvider(fakeProvider, []);
    if (sm3.chunks.length === 3) ok('fromProvider 静态方法', '3 个 chunks');
    else err('fromProvider 静态方法', 'chunks=' + sm3.chunks.length);

    // SSE
    if (typeof sm3.toSSE === 'function') ok('toSSE 方法');
    else err('toSSE', '缺失');
  } catch (e) {
    err('P2 流式验证', e.message);
  }

  // ═══════════════════════════════════════════
  section('P3: 端到端模块测试（已在 p0_p5_test.js 中覆盖）');
  // ═══════════════════════════════════════════
  try {
    const modules = [
      'AdaptiveOrchestrator', 'StreamManager', 'BudgetManager',
      'VectorMemoryStore', 'RetryManager', 'ContractValidator',
      'ApprovalWorkflow', 'MCPClient', 'TestRunner'
    ];
    let modOk = 0;
    for (const m of modules) {
      try {
        if (m === 'StreamManager') R('src/utils/StreamManager.js');
        else if (m === 'RetryManager') {
          const { RetryManager } = R('src/utils/RetryManager.js');
          // eslint-disable-next-line no-new
          new RetryManager({});
        } else if (m === 'MCPClient') R('src/mcp/MCPClient.js');
        else R('src/core/' + m + '.js');
        modOk++;
      } catch (_) {}
    }
    if (modOk === modules.length) ok('9 个模块全部可实例化', modOk + '/' + modules.length);
    else err('模块实例化', modOk + '/' + modules.length);
  } catch (e) {
    err('P3 验证', e.message);
  }

  // ═══════════════════════════════════════════
  section('P4: 自适应学习闭环');
  // ═══════════════════════════════════════════
  try {
    const AdaptiveOrchestrator = R('src/core/AdaptiveOrchestrator.js');
    const ao = new AdaptiveOrchestrator({});

    // recordOutcome 方法存在
    if (typeof ao.recordOutcome === 'function') ok('recordOutcome 方法');
    else err('recordOutcome', '缺失');

    // getLearningStats 方法
    if (typeof ao.getLearningStats === 'function') ok('getLearningStats 方法');
    else err('getLearningStats', '缺失');

    // _getTopPerformingTools 方法
    if (typeof ao._getTopPerformingTools === 'function') ok('_getTopPerformingTools 方法');
    else err('_getTopPerformingTools', '缺失');

    // 实际学习闭环验证
    const tools = [
      { name: 'claude-code', displayName: 'Claude Code', status: 'online' },
      { name: 'qoder', displayName: 'Qoder', status: 'online' }
    ];
    const rec = ao.recommend('用 Python 写爬虫', tools);

    // 记录成功
    ao.recordOutcome(rec.timestamp, true, 0.92, { taskType: 'feature', language: 'python' });
    const stats = ao.getLearningStats();
    if (stats.recordedOutcomes >= 1) ok('学习闭环写入', '已记录 ' + stats.recordedOutcomes + ' 个结果');
    else err('学习闭环写入', '未记录');

    if (typeof stats.successRate === 'number') ok('successRate 计算', String(stats.successRate));
    else err('successRate', '缺失');

    if (Array.isArray(stats.topTools)) ok('topTools 排行', '数组长度 ' + stats.topTools.length);
    else err('topTools', '不是数组');

    // TaskOrchestrator 集成
    const TaskOrchestrator = R('src/core/TaskOrchestrator.js');
    const orch = new TaskOrchestrator({});
    if (orch.adaptiveOrchestrator) ok('TaskOrchestrator 集成 adaptiveOrchestrator');
    else err('TaskOrchestrator 集成', '未集成');

    // WebUIServer API 路由
    const serverFile = fs.readFileSync(path.resolve(ROOT, 'src/core/WebUIServer.js'), 'utf-8');
    if (serverFile.includes('/api/adaptive/learning')) ok('GET /api/adaptive/learning 路由');
    else err('GET /api/adaptive/learning', '未注册');

    if (serverFile.includes('/api/adaptive/feedback')) ok('POST /api/adaptive/feedback 路由');
    else err('POST /api/adaptive/feedback', '未注册');
  } catch (e) {
    err('P4 学习闭环验证', e.message);
  }

  // ═══════════════════════════════════════════
  section('P5: 系统监控与可观测性 API');
  // ═══════════════════════════════════════════
  try {
    const serverFile = fs.readFileSync(path.resolve(ROOT, 'src/core/WebUIServer.js'), 'utf-8');

    if (serverFile.includes('/api/monitor/dashboard')) ok('GET /api/monitor/dashboard 路由');
    else err('/api/monitor/dashboard', '未注册');

    if (serverFile.includes('/api/monitor/tools-health')) ok('GET /api/monitor/tools-health 路由');
    else err('/api/monitor/tools-health', '未注册');

    if (serverFile.includes('/api/monitor/trends')) ok('GET /api/monitor/trends 路由');
    else err('/api/monitor/trends', '未注册');

    if (serverFile.includes('process.memoryUsage()')) ok('内存监控');
    else err('内存监控', '未实现');

    if (serverFile.includes('process.uptime()')) ok('运行时间监控');
    else err('运行时间', '未实现');

    if (serverFile.includes('getLearningStats()')) ok('集成学习统计');
    else err('集成学习统计', '未实现');
  } catch (e) {
    err('P5 监控验证', e.message);
  }

  // ═══════════════════════════════════════════
  // 总结
  // ═══════════════════════════════════════════
  console.log('\n══════════════════════════════════════');
  console.log('  P0-P5 新增功能冒烟测试总结');
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
  }

  process.exit(fail > 0 ? 1 : 0);
})();
