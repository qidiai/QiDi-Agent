#!/usr/bin/env node
'use strict';

/**
 * AI Bridge 全链路 E2E 测试(整合自 10 个已弃用的遗留测试)
 *
 * 覆盖真正的生产路径:server.js 共享中枢 + bridge-stdio 客户端 + 反向调用(sampling)往返。
 * 取代旧的 spawn mcp-server.js 单进程测试(mcp-server.js 已弃用/移除)。
 *
 * 运行隔离:独立端口、JSON 数据目录、SQLite 和观测目录，测试期间不改写生产状态。
 *
 * 运行:node test-e2e.mjs
 * 退出码:0 全通过 / 1 有失败
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const PORT = 9810;
const HOST = '127.0.0.1';
const CLIENT = 'e2e-probe';
const STALE_CLIENT = 'e2e-stale-probe';
const REVIEWER = 'e2e-reviewer';
const CONFLICT_CLIENT = 'openclaw';
const CONFLICT_CLIENT_ID = 'client-openclaw';
const TEST_RUNTIME = path.join(__dirname, 'test-runtime-data'); // JSON 运行态隔离:开关/统计/记忆/日志/ACL
const TEST_DB = path.join(TEST_RUNTIME, 'test-bridge.db'); // 全局库隔离:测试专用库,测后随目录删除
const TEST_OBSERVE = path.join(TEST_RUNTIME, 'observe'); // 观测层隔离:路由/接管状态专用目录
function testDataPath (name) { return path.join(TEST_RUNTIME, name); }

// ── 断言框架 ──
let passed = 0;
let failed = 0;
const failures = [];
function check (name, cond, detail) {
  if (cond) { passed++; process.stdout.write(`  ✅ ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  ❌ ${name}${detail ? ' — ' + detail : ''}\n`); }
}
function section (title) { process.stdout.write(`\n── ${title} ──\n`); }

// ── HTTP 客户端(直连中枢) ──
function req (method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: HOST, port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 60000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('http timeout ' + p)); });
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── MCP stdio 双向通道(既发请求给桥接器,又应答桥接器的反向调用) ──
let lastSamplingTask = '';
function makeMcpChannel (child) {
  let buf = '';
  const pending = new Map();
  let idc = 0;
  child.stdout.on('data', d => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      // 反向调用:桥接器请求宿主(本测试)生成内容
      if (msg.method === 'sampling/createMessage' && msg.id !== undefined) {
        lastSamplingTask = msg.params?.messages?.[0]?.content || '';
        // 含 LONGOUT_MARK 标记时返回超长文本,用于验证 RESULT_MAX_CHARS 截断
        const text = lastSamplingTask.includes('LONGOUT_MARK')
          ? 'L'.repeat(5000)
          : '```python\ndef add(a, b):\n    return a + b\n```';
        const result = {
          content: { type: 'text', text },
          usage: { inputTokens: 12, outputTokens: 34 }
        };
        const reply = () => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
        if (lastSamplingTask.includes('BUSY_STATE_MARK')) setTimeout(reply, 500);
        else reply();
        continue;
      }
      // 桥接器对本测试请求的应答
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  return {
    request (method, params) {
      const id = ++idc;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('mcp timeout: ' + method)); } }, 60000);
      });
    }
  };
}

async function waitServerReady (timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // 就绪探针只验证 HTTP 主循环；/api/tools 会执行 CLI 可用性探测，不能作为启动判据。
    try {
      const r = await req('GET', '/api/health');
      if (r.status === 200 && r.body.status === 'ok') return true;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('server 启动超时');
}

async function waitClientConnected (name, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await req('GET', '/api/clients');
      if ((r.body.clients || []).some(c => c.id === name && c.online === true)) return true;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('客户端连接超时: ' + name);
}

async function waitClientDisconnected (name, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await req('GET', '/api/clients');
      const client = (r.body.clients || []).find(c => c.id === name);
      if (!client || client.state === 'approved_offline') return true;
    } catch { /* retry */ }
    await sleep(100);
  }
  return false;
}

// 轮询会议直到进入终态(closed/interrupted),返回最终状态体;超时抛错
async function pollMeetingClosed (id, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await req('GET', '/api/discuss/status/' + id);
    if (r.status === 200 && (r.body.status === 'closed' || r.body.status === 'interrupted')) return r.body;
    await sleep(200);
  }
  throw new Error('会议未在预期时间内结束: ' + id);
}

// ── 主流程 ──
let serverProc = null;
let bridgeProc = null;
let reviewerProc = null;
let conflictProc = null;
let serverErr = '';

async function main () {
  process.stdout.write('AI Bridge 全链路 E2E 测试\n');
  process.stdout.write('='.repeat(40) + '\n');

  // 清理上次遗留的测试运行目录并建立全新隔离状态。
  fs.rmSync(TEST_RUNTIME, { recursive: true, force: true });
  fs.mkdirSync(TEST_RUNTIME, { recursive: true });
  // 种子 ACL:预批准 e2e 客户端；另含与内置 CLI 同名的 openclaw，验证 client- 前缀 ID 回传链路
  fs.writeFileSync(testDataPath('clients-acl.json'),
    JSON.stringify({ allowlist: [CLIENT, STALE_CLIENT, REVIEWER, CONFLICT_CLIENT, CONFLICT_CLIENT_ID], blocklist: [], pending: [] }, null, 2));

  // 1) 启动中枢(JSON/SQLite/观测数据全部指向测试专用目录)
  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_DATA_DIR: TEST_RUNTIME, AI_BRIDGE_DB: TEST_DB, AI_BRIDGE_OBSERVE_DIR: TEST_OBSERVE, AI_BRIDGE_CLIENT_TTL: '1200', AI_BRIDGE_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stderr.on('data', d => { serverErr += d.toString(); });
  await waitServerReady();
  process.stdout.write('中枢已就绪 (127.0.0.1:' + PORT + ')\n');

  // 2) 准入管理全流程(HTTP 直连中枢)
  section('准入控制:陌生客户端 → 待审批 → 批准 → 踢出');
  const reg = await req('POST', '/api/client/register', { name: 'e2e-stranger' });
  check('陌生客户端进入待审批(pending)', reg.body.status === 'pending', JSON.stringify(reg.body));
  const cl1 = await req('GET', '/api/clients');
  check('待审批队列包含 e2e-stranger', (cl1.body.pending || []).some(p => p.clientId === 'e2e-stranger'));
  const ap = await req('POST', '/api/clients/approve', { clientId: 'e2e-stranger' });
  check('批准成功', ap.body.status === 'approved');
  const cl2 = await req('GET', '/api/clients');
  check('批准后进入白名单', (cl2.body.allowlist || []).includes('e2e-stranger'));
  const kick = await req('POST', '/api/clients/kick', { clientId: 'e2e-stranger' });
  check('踢出成功', kick.body.success === true);
  const cl3 = await req('GET', '/api/clients');
  check('踢出后移出白名单(防自动重连)', !(cl3.body.allowlist || []).includes('e2e-stranger'));

  // 2b) 同名注册必须幂等:网络层重试不能覆盖客户端状态或制造日志风暴
  section('准入控制:同名客户端重复注册幂等');
  const firstReg = await req('POST', '/api/client/register', { name: CLIENT });
  check('首次白名单注册标记 reused=false', firstReg.body.status === 'approved' && firstReg.body.reused === false, JSON.stringify(firstReg.body));
  const beforeDup = await req('GET', '/api/clients');
  const beforeDupClient = (beforeDup.body.clients || []).find(c => c.id === CLIENT);
  const connectedAtBefore = beforeDupClient?.connectedAt;
  check('注册后未首轮 poll 时为 connecting 而非在线', beforeDupClient?.state === 'connecting' && beforeDupClient?.online === false, JSON.stringify(beforeDupClient));
  const beforePollTools = await req('GET', '/api/tools');
  check('connecting 客户端不进入可调度工具列表', !(beforePollTools.body.tools || []).some(t => t.name === CLIENT));
  check('未声明 sampling 的控制连接无执行资格', beforeDupClient?.supportsSampling === false && beforeDupClient?.executionEligible === false, JSON.stringify(beforeDupClient));
  const secondReg = await req('POST', '/api/client/register', { name: CLIENT });
  const afterDup = await req('GET', '/api/clients');
  const connectedAtAfter = (afterDup.body.clients || []).find(c => c.id === CLIENT)?.connectedAt;
  check('重复注册标记 reused=true', secondReg.body.status === 'approved' && secondReg.body.reused === true, JSON.stringify(secondReg.body));
  check('重复注册保留原连接身份', !!connectedAtBefore && connectedAtAfter === connectedAtBefore, `${connectedAtBefore} -> ${connectedAtAfter}`);
  await req('POST', '/api/client/unregister', { clientId: CLIENT });
  const approvedOffline = await req('GET', '/api/clients');
  const offlineClient = (approvedOffline.body.clients || []).find(c => c.id === CLIENT);
  check('注销后保留 ACL 并显示 approved_offline', offlineClient?.state === 'approved_offline' && offlineClient?.approved === true && offlineClient?.online === false, JSON.stringify(offlineClient));

  // 2c) stale/reconnecting：超出 TTL 后状态应过期；重复注册后须重新 poll 才恢复在线。
  section('生命周期:stale → reconnecting → online_idle');
  const staleReg = await req('POST', '/api/client/register', { name: STALE_CLIENT });
  check('stale 用例重新注册成功', staleReg.body.status === 'approved');
  await sleep(1400);
  const staleView = await req('GET', '/api/clients');
  check('超过 TTL 且未 poll 显示 stale', (staleView.body.clients || []).find(c => c.id === STALE_CLIENT)?.state === 'stale');
  const reconnectReg = await req('POST', '/api/client/register', { name: STALE_CLIENT });
  check('stale 客户端重复注册进入 reconnecting', reconnectReg.body.reused === true && reconnectReg.body.lifecycle === 'reconnecting', JSON.stringify(reconnectReg.body));
  const reconnectView = await req('GET', '/api/clients');
  check('重连注册后仍未冒充在线', (reconnectView.body.clients || []).find(c => c.id === STALE_CLIENT)?.state === 'reconnecting' && !(reconnectView.body.clients || []).find(c => c.id === STALE_CLIENT)?.online);
  req('POST', '/api/poll', { clientId: STALE_CLIENT }).catch(() => {});
  await sleep(100);
  const reconnectedView = await req('GET', '/api/clients');
  check('重连完成首轮 poll 后恢复 online_idle', (reconnectedView.body.clients || []).find(c => c.id === STALE_CLIENT)?.state === 'online_idle');
  await req('POST', '/api/client/unregister', { clientId: STALE_CLIENT });

  // 2d) 客户端名与内置 CLI 重名时，桥接器必须保存服务端分配的 client- 前缀 ID
  section('准入控制:同名 CLI 冲突客户端使用服务端分配 ID');
  conflictProc = spawn(process.execPath, ['bridge-stdio.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: CONFLICT_CLIENT },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const conflictMcp = makeMcpChannel(conflictProc);
  await waitClientConnected(CONFLICT_CLIENT_ID);
  await conflictMcp.request('initialize', { capabilities: { sampling: {} } });
  await sleep(1200);
  const conflictClients = await req('GET', '/api/clients');
  check('同名客户端稳定连接为 client-openclaw', (conflictClients.body.clients || []).some(c => c.id === CONFLICT_CLIENT_ID && c.state === 'online_idle'));
  check('未出现错误原名 openclaw 在线连接条目', !(conflictClients.body.clients || []).some(c => c.id === CONFLICT_CLIENT && c.online));
  const conflictTools = await req('GET', '/api/tools');
  const cliOpenClaw = (conflictTools.body.tools || []).find(t => t.name === 'openclaw');
  const clientOpenClaw = (conflictTools.body.tools || []).find(t => t.name === CONFLICT_CLIENT_ID);
  check('CLI 与客户端共享 canonicalId 但实例 ID 隔离', cliOpenClaw?.id === 'cli:openclaw' && clientOpenClaw?.id === 'client:openclaw' && cliOpenClaw?.canonicalId === clientOpenClaw?.canonicalId);
  check('工具 API 返回 sourceId/aliases/type', clientOpenClaw?.sourceId === 'openclaw' && Array.isArray(clientOpenClaw?.aliases) && clientOpenClaw?.type === 'client');
  await req('POST', '/api/toggle', { tool: 'client:openclaw', enabled: false });
  const conflictToolsOff = await req('GET', '/api/tools');
  check('稳定实例键只关闭客户端 OpenClaw', conflictToolsOff.body.tools.find(t => t.id === 'client:openclaw')?.enabled === false && conflictToolsOff.body.tools.find(t => t.id === 'cli:openclaw')?.enabled !== false);
  await req('POST', '/api/toggle', { tool: 'client-openclaw', enabled: true });
  conflictProc.stdin.end();
  const conflictDisconnected = await waitClientDisconnected(CONFLICT_CLIENT_ID);
  check('stdio 正常关闭后立即注销客户端', conflictDisconnected);
  conflictProc.kill();
  conflictProc = null;
  const kickConflict = await req('POST', '/api/clients/kick', { clientId: CONFLICT_CLIENT_ID });
  const conflictAfterKick = await req('GET', '/api/clients');
  check('同名冲突客户端离线后踢出会移除原始授权', kickConflict.body.success === true && !(conflictAfterKick.body.allowlist || []).includes(CONFLICT_CLIENT) && !(conflictAfterKick.body.allowlist || []).includes(CONFLICT_CLIENT_ID));

  // 3) 启动 bridge-stdio 客户端(白名单直接批准)
  bridgeProc = spawn(process.execPath, ['bridge-stdio.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: CLIENT },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const mcp = makeMcpChannel(bridgeProc);
  await waitClientConnected(CLIENT);

  // 3b) 启动第二个客户端(评审者,用于交叉评审/共识引擎的活体双客户端测试)
  reviewerProc = spawn(process.execPath, ['bridge-stdio.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: REVIEWER },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const reviewerMcp = makeMcpChannel(reviewerProc);
  await waitClientConnected(REVIEWER);
  await reviewerMcp.request('initialize', { capabilities: { sampling: {} } });

  // 4) MCP 协议握手 + 工具清单
  section('MCP 协议:initialize + tools/list');
  const init = await mcp.request('initialize', { capabilities: { sampling: {} } });
  check('initialize 返回 sampling capability', !!init.result?.capabilities?.sampling);
  await sleep(100);
  const capabilityView = await req('GET', '/api/clients');
  const capabilityClient = (capabilityView.body.clients || []).find(c => c.id === CLIENT);
  check('宿主声明 sampling 后客户端具备执行资格', capabilityClient?.supportsSampling === true && capabilityClient?.executionEligible === true, JSON.stringify(capabilityClient));
  const tl = await mcp.request('tools/list', {});
  const names = (tl.result?.tools || []).map(t => t.name);
  const expected = ['dispatch', 'list_tools', 'toggle_tool', 'list_switches', 'token_stats', 'handoff',
    'memory_search', 'memory_recent', 'logs', 'discuss', 'list_clients', 'approve_client', 'deny_client', 'kick_client'];
  check('tools/list 暴露全部核心工具', expected.every(n => names.includes(n)), '缺失: ' + expected.filter(n => !names.includes(n)).join(','));
  const dispatchTool = (tl.result?.tools || []).find(t => t.name === 'dispatch');
  check('dispatch 工具含 context 参数', !!dispatchTool?.inputSchema?.properties?.context);

  // 5) 皇冠用例:dispatch 反向调用往返 + 上下文注入 + token 记录
  section('dispatch 反向调用往返(中枢 → 客户端 sampling → 结果回收)');
  const disp = await req('POST', '/api/dispatch', {
    task: '写一个 Python add(a,b) 函数', tools: [CLIENT], context: '这是 e2e 上下文标记 CTXMARK'
  });
  check('dispatch 往返成功(1/1)', disp.body.successCount === 1, JSON.stringify(disp.body).slice(0, 200));
  check('dispatch 产出代码块', (disp.body.results?.[0]?.codeBlocks || []).length > 0);
  check('dispatch 结果回显稳定身份', disp.body.results?.[0]?.toolId === 'client:e2e-probe' && disp.body.results?.[0]?.canonicalId === 'e2e-probe', JSON.stringify(disp.body.results?.[0]).slice(0, 180));
  check('上下文注入:子工具收到 context 标记', lastSamplingTask.includes('CTXMARK') && lastSamplingTask.includes('## 上下文'), lastSamplingTask.slice(0, 80));
  check('dispatch 记录 token 用量', (disp.body.totalTokens || 0) > 0, 'totalTokens=' + disp.body.totalTokens);
  check('dispatch 响应含追踪 id(dispatchId)', typeof disp.body.dispatchId === 'string' && disp.body.dispatchId.startsWith('dispatch_'), 'dispatchId=' + disp.body.dispatchId);
  check('dispatch 响应含耗时(elapsedMs)', typeof disp.body.elapsedMs === 'number' && disp.body.elapsedMs >= 0, 'elapsedMs=' + disp.body.elapsedMs);
  const busyDispatch = req('POST', '/api/dispatch', { task: '检查生命周期 BUSY_STATE_MARK', tools: [CLIENT] });
  await sleep(150);
  const duringBusy = await req('GET', '/api/clients');
  check('任务执行期间客户端为 online_busy', (duringBusy.body.clients || []).find(c => c.id === CLIENT)?.state === 'online_busy', JSON.stringify((duringBusy.body.clients || []).find(c => c.id === CLIENT)));
  await busyDispatch;
  const afterBusy = await req('GET', '/api/clients');
  check('任务完成后客户端恢复 online_idle', (afterBusy.body.clients || []).find(c => c.id === CLIENT)?.state === 'online_idle');

  // 6) handoff 接力(同样走反向调用)
  section('handoff 接力');
  const ho = await req('POST', '/api/handoff', { task: '补全减法并加错误处理', existing_code: 'def sub(a, b):\n    # TODO', from: 'atom-code', to: CLIENT });
  check('handoff 成功', ho.body.success === true, JSON.stringify(ho.body).slice(0, 150));
  check('handoff 有产出', (ho.body.codeBlocks || []).length > 0 || !!ho.body.content);

  // 7) 开关:toggle_tool 关/开 + list_switches 反映(dispatch 之后再测,避免阻断)
  section('开关:toggle_tool 关闭 → 打开');
  await req('POST', '/api/toggle', { tool: CLIENT, enabled: false });
  const t1 = await req('GET', '/api/tools');
  check('toggle 关闭生效', t1.body.tools.find(x => x.name === CLIENT)?.enabled === false);
  check('toggle 写入稳定客户端实例键', JSON.parse(fs.readFileSync(testDataPath('switches.json'), 'utf-8'))['client:e2e-probe'] === false);
  await req('POST', '/api/toggle', { tool: 'client:e2e-probe', enabled: true });
  const t2 = await req('GET', '/api/tools');
  check('稳定实例 ID toggle 打开生效', t2.body.tools.find(x => x.name === CLIENT)?.enabled === true);

  // 8) 统计 / 记忆 / 日志 结构
  section('统计 / 记忆 / 日志');
  const stats = await req('GET', '/api/stats');
  check('token_stats 新调用写入稳定客户端实例键', !!stats.body.tools?.['client:e2e-probe'] && stats.body.tools['client:e2e-probe'].calls > 0);
  const toolStatsView = await req('GET', '/api/tools');
  check('工具 API 聚合稳定实例统计', toolStatsView.body.tools.find(t => t.id === 'client:e2e-probe')?.calls > 0);
  const mem = await req('GET', '/api/memory/recent?limit=5');
  check('memory_recent 结构正确(tasks 数组)', Array.isArray(mem.body.tasks));
  check('memory_recent 记录了本次 dispatch', (mem.body.tasks || []).some(t => (t.tools || []).includes(CLIENT)));
  const logs = await req('GET', '/api/logs?limit=10');
  check('logs 结构正确(logs 数组)', Array.isArray(logs.body.logs));

  // 9) 通过 MCP tools/call 调用 list_clients(客户端侧管理工具链路)
  section('MCP tools/call:list_clients');
  const lc = await mcp.request('tools/call', { name: 'list_clients', arguments: {} });
  check('list_clients 工具可调用', !lc.result?.isError && /共享中枢/.test(lc.result?.content?.[0]?.text || ''));

  // 9.5) 智能路由:关闭全部本机 CLI 工具(确定性),未指定 tools 时按综合评分自动选优
  section('智能路由:未指定 tools 使用可解释综合评分');
  const allT = await req('GET', '/api/tools');
  for (const t of allT.body.tools) {
    if (t.name !== CLIENT && t.name !== REVIEWER && t.enabled) await req('POST', '/api/toggle', { tool: t.name, enabled: false });
  }
  const auto = await req('POST', '/api/dispatch', { task: '写一个 Python max3(a,b,c) 函数' });
  check('routing.mode=auto 且回显 ranking 依据', auto.body.routing?.mode === 'auto' && Array.isArray(auto.body.routing.ranking), JSON.stringify(auto.body.routing || {}).slice(0, 200));
  check('综合路由策略与任务类别正确', auto.body.routing?.strategy === 'composite-v1' && auto.body.routing?.taskCategory === 'code', JSON.stringify(auto.body.routing || {}).slice(0, 250));
  const topRoute = auto.body.routing?.ranking?.[0];
  check('综合路由返回七个可解释分量', ['success', 'capability', 'latency', 'tokenCost', 'freshness', 'stability', 'confidence'].every(k => Number.isFinite(topRoute?.components?.[k])), JSON.stringify(topRoute || {}).slice(0, 350));
  check('综合路由返回选择原因与稳定 ID', typeof auto.body.routing?.selectedReason === 'string' && topRoute?.toolId === 'client:e2e-probe', JSON.stringify(auto.body.routing || {}).slice(0, 350));
  check('综合路由选中已验证工具(e2e-probe)', auto.body.routing?.selected === CLIENT, 'selected=' + auto.body.routing?.selected);
  check('智能路由 dispatch 往返成功', auto.body.successCount === 1, JSON.stringify(auto.body).slice(0, 120));

  // 9.6) 交叉评审闭环:生产者产出 → 独立评审者评审
  section('交叉评审:生成 → 另一工具评审');
  const rv = await req('POST', '/api/dispatch', { task: '写一个 Python mul(a,b) 函数', tools: [CLIENT], review: true, reviewer: REVIEWER });
  check('主产出成功', rv.body.successCount === 1, JSON.stringify(rv.body).slice(0, 120));
  check('评审由独立工具完成(reviewer≠producer)', rv.body.review?.reviewer === REVIEWER && rv.body.review?.producer === CLIENT, JSON.stringify(rv.body.review || {}).slice(0, 200));
  check('评审有实质内容', typeof rv.body.review?.content === 'string' && rv.body.review.content.length > 0);

  // 9.7) 异步任务队列:async dispatch 立即返回 taskId,轮询取结果
  section('异步任务队列:async dispatch + taskId 轮询');
  const at = await req('POST', '/api/dispatch', { task: '写一个 Python neg(x) 函数', tools: [CLIENT], async: true });
  check('async 模式返回 202 + taskId', at.status === 202 && typeof at.body.taskId === 'string', JSON.stringify(at.body).slice(0, 120));
  let atFinal = null;
  for (let i = 0; i < 40; i++) {
    const q = await req('GET', '/api/task/' + at.body.taskId);
    if (q.body.status === 'done' || q.body.status === 'failed') { atFinal = q.body; break; }
    await sleep(250);
  }
  check('异步任务完成(done)', atFinal?.status === 'done', 'status=' + atFinal?.status);
  check('异步结果可查(successCount=1)', atFinal?.result?.successCount === 1, JSON.stringify(atFinal?.result || {}).slice(0, 120));
  const nf = await req('GET', '/api/task/atask_notexist');
  check('不存在的任务返回 404', nf.status === 404, 'status=' + nf.status);

  // 9.8) 共识引擎:双参与者讨论正常结束后自动生成共识总结
  section('共识引擎:讨论结束自动生成共识总结');
  const cm = await req('POST', '/api/discuss', { topic: 'e2e 共识话题:加法函数实现方案', participants: [CLIENT, REVIEWER], round2: false, implement: false });
  check('双参与者讨论启动', cm.status === 200 && !!cm.body.meetingId, JSON.stringify(cm.body).slice(0, 120));
  const cmFinal = await pollMeetingClosed(cm.body.meetingId, 30000);
  check('会议正常关闭(非中断)', cmFinal.status === 'closed' && !cmFinal.interrupted, 'status=' + cmFinal.status + ' interrupted=' + cmFinal.interrupted);
  check('自动生成共识总结发言', (cmFinal.messages || []).some(m => m.speaker === '共识总结' && (m.content || '').length > 0), '发言者: ' + (cmFinal.messages || []).map(m => m.speaker).join(','));

  // 11) 健康检查端点(免鉴权/免工具检测)
  section('健康检查端点 /api/health');
  const health = await req('GET', '/api/health');
  check('/api/health 返回 ok', health.body.status === 'ok');
  check('/api/health 含 uptime/port/clients 字段', typeof health.body.uptime === 'number' && health.body.port === PORT && typeof health.body.clients === 'number');

  // 11.5) 主动干预:讨论会自动止损(token 预算 + 时长上限),防无限讨论
  //   置于并发闸门测试之前——后者会向 memory.json 注入 fake discussing 会议污染状态
  section('主动干预:讨论会自动止损(token 预算 / 时长上限)');
  // token 预算=0:首位发言者前即超预算,不调用任何真实 CLI 工具(确定性)
  const stopTok = await req('POST', '/api/discuss', { topic: '自动止损-token', participants: [CLIENT], round2: false, implement: false, max_tokens: 0 });
  check('discuss 启动并回显 budget.maxTokens=0', stopTok.status === 200 && stopTok.body.budget?.maxTokens === 0, JSON.stringify(stopTok.body.budget));
  const tokFinal = await pollMeetingClosed(stopTok.body.meetingId);
  check('token 预算耗尽触发自动止损(会议终止)', tokFinal.interrupted === true, 'status=' + tokFinal.status);
  check('止损原因含“自动止损”且含“token”', /自动止损/.test(tokFinal.interruptReason || '') && /token/.test(tokFinal.interruptReason || ''), tokFinal.interruptReason);

  // 时长上限=0:token 预算用默认,壁钟时长立即超限
  const stopMs = await req('POST', '/api/discuss', { topic: '自动止损-时长', participants: [CLIENT], round2: false, implement: false, max_ms: 0 });
  check('discuss 启动并回显 budget.maxMs=0', stopMs.status === 200 && stopMs.body.budget?.maxMs === 0, JSON.stringify(stopMs.body.budget));
  const msFinal = await pollMeetingClosed(stopMs.body.meetingId);
  check('时长超限触发自动止损(会议终止)', msFinal.interrupted === true, 'status=' + msFinal.status);
  check('止损原因含“自动止损”且含“时长”', /自动止损/.test(msFinal.interruptReason || '') && /时长/.test(msFinal.interruptReason || ''), msFinal.interruptReason);

  // 12) 讨论会并发闸门(注入 MAX 个 discussing 会议,验证第 4 个被拒)
  section('讨论会并发闸门 MAX_CONCURRENT_MEETINGS');
  const memPath = testDataPath('memory.json');
  const memObj = fs.existsSync(memPath) ? JSON.parse(fs.readFileSync(memPath, 'utf-8')) : {};
  memObj.meetings = [
    { id: 'm1', status: 'discussing', topic: 't1', participants: [], messages: [] },
    { id: 'm2', status: 'discussing', topic: 't2', participants: [], messages: [] },
    { id: 'm3', status: 'discussing', topic: 't3', participants: [], messages: [] }
  ];
  fs.writeFileSync(memPath, JSON.stringify(memObj, null, 2));
  const guard = await req('POST', '/api/discuss', { topic: '应被闸门拒绝', participants: [CLIENT] });
  check('并发达上限时 discuss 返回 429', guard.status === 429, 'status=' + guard.status);
  check('429 提示信息含“上限”', /上限/.test(guard.body.error || ''), guard.body.error);

  // 10) estimateTokens 单元校验(中文友好估算)
  section('estimateTokens 单元校验');
  const { estimateTokens } = require('./tool-registry.js');
  check('estimateTokens ASCII > 0', estimateTokens('hello world') > 0);
  check('estimateTokens CJK 密度更高', estimateTokens('这是一段中文测试文本内容') > estimateTokens('abcdefghijkl'));

  // 13) 可观测性:/api/metrics 运行指标端点
  section('运行指标端点 /api/metrics');
  const metrics = await req('GET', '/api/metrics');
  check('/api/metrics 返回 counters 结构', metrics.status === 200 && !!metrics.body.counters && typeof metrics.body.counters.dispatchTotal === 'number');
  check('/api/metrics 记录了至少一次 dispatch', metrics.body.counters.dispatchTotal >= 1, 'dispatchTotal=' + metrics.body.counters?.dispatchTotal);
  check('/api/metrics 含配置快照', typeof metrics.body.config?.maxConcurrentDispatch === 'number' && typeof metrics.body.config?.authEnabled === 'boolean');
  check('/api/metrics 含数据文件体积', metrics.body.dataFileBytes && typeof metrics.body.dataFileBytes.memory === 'number');
  check('/api/metrics 记录自动止损次数(meetingsAutoStopped>=2)', metrics.body.counters.meetingsAutoStopped >= 2, 'meetingsAutoStopped=' + metrics.body.counters?.meetingsAutoStopped);
  check('/api/metrics config 含会议预算硬顶', typeof metrics.body.config?.maxMeetingTokens === 'number' && typeof metrics.body.config?.meetingMaxMs === 'number', JSON.stringify(metrics.body.config));
  check('/api/metrics 含全局库状态', typeof metrics.body.db?.available === 'boolean', JSON.stringify(metrics.body.db));

  // 13.5) 全局数据库:结果沉淀校验(测试专用库,与生产库隔离)
  section('全局数据库沉淀 /api/db/stats');
  const dbs = await req('GET', '/api/db/stats');
  check('全局库可用(node:sqlite)', dbs.body.available === true, JSON.stringify(dbs.body).slice(0, 200));
  check('dispatch 结果已沉淀入库', (dbs.body.dispatches?.n || 0) >= 3, 'dispatches.n=' + dbs.body.dispatches?.n);
  check('交叉评审已沉淀入库', (dbs.body.reviews?.n || 0) >= 1, 'reviews.n=' + dbs.body.reviews?.n);
  check('会议终态已沉淀入库(含止损+共识会议)', (dbs.body.meetings?.n || 0) >= 3, 'meetings.n=' + dbs.body.meetings?.n);
  check('异步任务已沉淀入库(done>=1)', (dbs.body.asyncTasks?.done || 0) >= 1, JSON.stringify(dbs.body.asyncTasks));

  // 13.7) 全局观测:telemetry 上报 / 代理透传 / 用量洞察
  section('全局观测:telemetry 上报 + 透传代理 + insights');
  // telemetry 批量上报入库(含密钥脱敏)
  const tel = await req('POST', '/api/telemetry', {
    source: 'e2e-external-tool',
    events: [
      { type: 'session', model: 'test-model-a', inputTokens: 100, outputTokens: 50, durationMs: 1200 },
      { type: 'tool_use', success: false, detail: '密钥 sk-abcdefgh12345678 不应入库明文' }
    ]
  });
  check('telemetry 批量上报成功(recorded=2)', tel.status === 200 && tel.body.recorded === 2, JSON.stringify(tel.body));
  const telBad = await req('POST', '/api/telemetry', { source: 'x', events: '不是数组' });
  check('telemetry 畸形入参被拒(400)', telBad.status === 400, 'status=' + telBad.status);
  // bridge-stdio 每次 sampling 后自动上报(前面 dispatch 已触发多次)
  const ins0 = await req('GET', '/api/insights');
  check('insights 返回 bySource 汇总', ins0.status === 200 && Array.isArray(ins0.body.summary?.bySource), JSON.stringify(ins0.body).slice(0, 150));
  check('bridge-stdio sampling 自动上报已入库', (ins0.body.summary?.bySource || []).some(r => r.source === CLIENT && r.channel === 'telemetry'), JSON.stringify(ins0.body.summary?.bySource || []).slice(0, 300));
  // 透传代理:登记路由 → 请求经代理直达迷你上游 → 用量解析入库
  const upstreamSrv = http.createServer((q, s) => {
    let b = '';
    q.on('data', c => b += c);
    q.on('end', () => {
      s.writeHead(200, { 'Content-Type': 'application/json' });
      s.end(JSON.stringify({ id: 'cmpl-e2e', echoPath: q.url, choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
    });
  });
  await new Promise(r => upstreamSrv.listen(9821, HOST, r));
  const routeAdd = await req('POST', '/api/observe/route', { source: 'e2e-proxytool', key: 'main', upstream: 'http://127.0.0.1:9821/v1' });
  check('手动登记代理路由成功', routeAdd.status === 200 && routeAdd.body.success === true, JSON.stringify(routeAdd.body));
  const viaProxy = await req('POST', '/proxy/e2e-proxytool/main/chat/completions', { model: 'proxy-test-model', messages: [] });
  check('代理透传响应原样返回(含上游路径拼接)', viaProxy.status === 200 && viaProxy.body.id === 'cmpl-e2e' && viaProxy.body.echoPath === '/v1/chat/completions', JSON.stringify(viaProxy.body).slice(0, 150));
  const noRoute = await req('POST', '/proxy/nobody/nowhere/x', {});
  check('未登记路由返回 404', noRoute.status === 404, 'status=' + noRoute.status);
  await sleep(300); // 用量入库在响应结束后同 tick 写入,留余量
  const ins1 = await req('GET', '/api/insights');
  const proxyRow = (ins1.body.summary?.bySource || []).find(r => r.source === 'e2e-proxytool' && r.channel === 'proxy');
  check('代理请求用量解析入库(11/7 tokens)', !!proxyRow && proxyRow.input_tokens === 11 && proxyRow.output_tokens === 7, JSON.stringify(proxyRow || ins1.body.summary?.bySource || []).slice(0, 200));
  check('recent 事件含模型名', (ins1.body.summary?.recent || []).some(e => e.model === 'proxy-test-model'), JSON.stringify((ins1.body.summary?.recent || []).slice(0, 3)));
  upstreamSrv.close();
  // 接管护栏:不支持/未知工具直接拒绝,不碰任何真实配置
  const tkUnsupported = await req('POST', '/api/observe/takeover', { tool: 'codex' });
  check('不支持的工具接管被拒(400)', tkUnsupported.status === 400 && /暂不支持/.test(tkUnsupported.body.error || ''), JSON.stringify(tkUnsupported.body));
  const tkUnknown = await req('POST', '/api/observe/takeover', { tool: 'not-a-tool' });
  check('未知工具接管被拒(400)', tkUnknown.status === 400, 'status=' + tkUnknown.status);
  const obsStatus = await req('GET', '/api/observe/status');
  check('observe/status 返回五工具注册表', obsStatus.status === 200 && Object.keys(obsStatus.body.tools || {}).length === 5, JSON.stringify(Object.keys(obsStatus.body.tools || {})));
  check('注册表登记了手动路由', !!obsStatus.body.routes?.['e2e-proxytool/main'], JSON.stringify(obsStatus.body.routes || {}).slice(0, 150));

  // 14) 健壮性:畸形/越界入参优雅拒绝(不 5xx 崩溃)
  section('健壮性:畸形入参拒绝');
  const emptyTask = await req('POST', '/api/dispatch', { task: '', tools: [CLIENT] });
  check('空任务被拒(返回 error)', !!emptyTask.body.error, JSON.stringify(emptyTask.body).slice(0, 120));
  const hugeTask = await req('POST', '/api/dispatch', { task: 'x'.repeat(60000), tools: [CLIENT] });
  check('超长任务被拒(>MAX_TASK_LENGTH)', /过长/.test(hugeTask.body.error || ''), JSON.stringify(hugeTask.body).slice(0, 120));
  // 防回归:非字符串 topic 必须 400 拒绝(修复前会落盘孤儿会议永久占用并发闸门)
  const badTopic = await req('POST', '/api/discuss', { topic: 12345 });
  check('非字符串 topic 被拒(400,不产生孤儿会议)', badTopic.status === 400 && !!badTopic.body.error, 'status=' + badTopic.status + ' ' + JSON.stringify(badTopic.body).slice(0, 100));
  // 畸形入参连环后,中枢必须仍存活(健壮性的核心承诺:不因单次请求崩溃)
  const aliveAfter = await req('GET', '/api/health');
  check('畸形入参后中枢仍存活(不崩溃)', aliveAfter.status === 200 && aliveAfter.body.status === 'ok', JSON.stringify(aliveAfter.body).slice(0, 120));

  // 15) 指挥链加固:结果过期分支(已注册客户端但无 pending 任务时上报结果)
  section('指挥链加固:结果过期分支 /api/result');
  const expired = await req('POST', '/api/result', { clientId: CLIENT, taskId: 'e2e-no-pending-task', content: '迟到的结果' });
  check('无 pending 时结果被拒(success=false)', expired.status === 200 && expired.body.success === false, JSON.stringify(expired.body).slice(0, 120));
  check('拒绝原因含“超时”', /超时/.test(expired.body.reason || ''), 'reason=' + expired.body.reason);
  const aliveExpired = await req('GET', '/api/health');
  check('过期结果上报后中枢仍存活', aliveExpired.status === 200 && aliveExpired.body.status === 'ok');

  // 16) 指挥链加固:RESULT_MAX_CHARS 默认截断(端到端:mock 客户端返回 5000 字符,中枢应截到 2000)
  //   说明:未注入 AI_BRIDGE_RESULT_MAX_CHARS 环境变量,故这里验证的是 CONFIG 默认值 2000 的真实截断行为
  section('指挥链加固:RESULT_MAX_CHARS 默认截断');
  const longDisp = await req('POST', '/api/dispatch', { task: '产出超长文本 LONGOUT_MARK', tools: [CLIENT] });
  check('长产出 dispatch 往返成功', longDisp.body.successCount === 1, JSON.stringify(longDisp.body).slice(0, 120));
  const longContent = longDisp.body.results?.[0]?.content || '';
  check('结果 content 截断到默认 RESULT_MAX_CHARS=2000', longContent.length === 2000, 'content.length=' + longContent.length);
}

async function cleanup () {
  try { if (bridgeProc) { bridgeProc.stdin.end(); bridgeProc.kill(); } } catch { /* ignore */ }
  try { if (reviewerProc) { reviewerProc.stdin.end(); reviewerProc.kill(); } } catch { /* ignore */ }
  try { if (conflictProc) { conflictProc.stdin.end(); conflictProc.kill(); } } catch { /* ignore */ }
  try { if (serverProc) serverProc.kill(); } catch { /* ignore */ }
  await sleep(500);
  // JSON/SQLite/观测数据全部位于测试运行目录，一次清理即可，不触碰任何生产文件。
  try { fs.rmSync(TEST_RUNTIME, { recursive: true, force: true }); } catch { /* ignore */ }
}

main()
  .catch(e => { failed++; failures.push('主流程异常'); process.stdout.write(`\n💥 主流程异常: ${e.message}\n`); if (serverErr) process.stdout.write(`server stderr:\n${serverErr.slice(0, 500)}\n`); })
  .finally(async () => {
    await cleanup();
    process.stdout.write('\n' + '='.repeat(40) + '\n');
    process.stdout.write(`总计: ${passed}/${passed + failed} 通过\n`);
    if (failed > 0) process.stdout.write(`失败用例: ${failures.join(', ')}\n`);
    process.stdout.write('测试运行目录已清理，生产数据未改写。\n');
    process.exit(failed > 0 ? 1 : 0);
  });
