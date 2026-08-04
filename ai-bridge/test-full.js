const http = require('http');
const tests = [];
let pass = 0, fail = 0;

function log(ok, name, detail) {
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`);
  if (ok) pass++; else fail++;
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 9800, path, timeout: 30000 }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(_) { resolve({}); } });
    }).on('error', reject);
  });
}
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: 9800, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 600000 }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(_) { resolve({}); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

async function run() {
  console.log('═══ AI Bridge 全面测评 ═══\n');

  // 1. 服务启动
  const tools = await get('/api/tools');
  log(tools.tools && tools.tools.length > 0, '服务启动+工具列表', `${tools.tools.length} 个工具`);
  log(tools.total !== undefined, 'token统计字段存在', `total: ${JSON.stringify(tools.total).substring(0, 50)}`);

  // 2. 开关功能
  await post('/api/toggle', { tool: 'atom-code', enabled: false });
  const afterOff = await get('/api/tools');
  const atomOff = afterOff.tools.find(t => t.name === 'atom-code');
  log(atomOff && atomOff.enabled === false, '开关关闭 atom-code');

  await post('/api/toggle', { tool: 'atom-code', enabled: true });
  const afterOn = await get('/api/tools');
  const atomOn = afterOn.tools.find(t => t.name === 'atom-code');
  log(atomOn && atomOn.enabled === true, '开关打开 atom-code');

  // 3. 刷新工具状态
  const refresh = await post('/api/refresh', {});
  log(refresh.success === true, '刷新工具状态');

  // 4. 记忆API
  const mem = await get('/api/memory/recent?limit=5');
  log(Array.isArray(mem.tasks), '记忆:任务历史', `${mem.tasks.length} 条`);

  // 5. 日志API
  const logs = await get('/api/logs?limit=5');
  log(Array.isArray(logs.logs), '日志API', `${logs.logs.length} 条`);

  // 6. 客户端列表
  const clients = await get('/api/clients');
  log(clients.count !== undefined, '客户端列表', `${clients.count} 个`);

  // 7. Token统计
  const stats = await get('/api/stats');
  log(stats.total !== undefined, 'Token统计', `total calls: ${stats.total?.calls || 0}`);

  // 8. 讨论会(异步)
  console.log('\n--- 讨论会测试(异步) ---');
  const discuss = await post('/api/discuss', { topic: 'Python GIL 对多线程的影响', participants: ['openclaw', 'atom-code'], round2: false, guidance: '简短回答,100字以内' });
  log(discuss.meetingId !== undefined, '讨论会创建(异步)', `meetingId: ${discuss.meetingId}`);
  log(discuss.status === 'discussing', '讨论会状态=discussing');

  // 等待讨论完成
  await new Promise(r => setTimeout(r, 60000));
  const discussStatus = await get('/api/discuss/status/' + discuss.meetingId);
  log(discussStatus.status === 'closed' || discussStatus.status === 'discussing', '讨论会状态查询', `status: ${discussStatus.status}, 发言: ${discussStatus.messageCount}`);
  if (discussStatus.messages && discussStatus.messages.length > 0) {
    log(true, '讨论会有发言内容', `${discussStatus.messages.length} 条发言`);
  } else {
    log(false, '讨论会有发言内容', '0 条发言');
  }
  log(discussStatus.totalTokens !== undefined, '讨论会token统计', `totalTokens: ${discussStatus.totalTokens}`);

  // 9. 中断测试
  const discuss2 = await post('/api/discuss', { topic: '测试中断', participants: ['openclaw'], round2: false });
  const interrupt = await post('/api/discuss/interrupt', { meetingId: discuss2.meetingId, reason: '测试中断功能' });
  log(interrupt.success === true, '讨论会中断', `reason: ${interrupt.reason}`);

  // 10. 注入测试
  const discuss3 = await post('/api/discuss', { topic: '测试注入', participants: ['atom-code'], round2: false });
  const inject = await post('/api/discuss/inject', { meetingId: discuss3.meetingId, message: '请注意线程安全' });
  log(inject.success === true, '讨论会注入', '注入成功');
  await post('/api/discuss/interrupt', { meetingId: discuss3.meetingId, reason: '清理' });

  // 11. Dispatch测试
  console.log('\n--- Dispatch测试 ---');
  const dispatch = await post('/api/dispatch', { task: '写一个 Python 加法函数 add(a,b)', tools: ['atom-code'], auto_fallback: true });
  log(dispatch.results !== undefined, 'Dispatch返回结果', `success: ${dispatch.successCount}/${dispatch.total}`);
  log(dispatch.totalTokens !== undefined, 'Dispatch token统计', `${dispatch.totalTokens} tokens`);
  if (dispatch.results && dispatch.results.length > 0) {
    const r = dispatch.results[0];
    log(r.success === true, 'AtomCode产出代码', `${r.codeBlocks?.length || 0} 个代码块`);
  }

  // 12. 记忆记录验证
  const memAfter = await get('/api/memory/recent?limit=3');
  log(memAfter.tasks && memAfter.tasks.length > 0, 'Dispatch记录到记忆', `${memAfter.tasks.length} 条`);

  // 13. 日志记录验证
  const logsAfter = await get('/api/logs?limit=10');
  const hasLog = logsAfter.logs && logsAfter.logs.some(l => l.msg && l.msg.includes('dispatch'));
  log(hasLog, 'Dispatch记录到日志');

  console.log(`\n═══ 测试结果: ${pass} 通过 / ${fail} 失败 ═══`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.log('异常:', e.message); process.exit(1); });
