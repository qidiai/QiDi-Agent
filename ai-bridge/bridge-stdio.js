#!/usr/bin/env node
'use strict';

/**
 * AI Bridge MCP stdio 桥接器 v1.1
 *
 * 修复:启动重连/extractBlocks 复用/from undefined/死变量清理/日志统一
 */

const readline = require('readline');
const http = require('http');
const { extractCodeBlocks } = require('./tool-registry');

const BRIDGE_PORT = parseInt(process.env.AI_BRIDGE_PORT) || 9800;
const BRIDGE_HOST = process.env.AI_BRIDGE_HOST || '127.0.0.1';
const BRIDGE_TOKEN = process.env.AI_BRIDGE_TOKEN || '';
const CLIENT_NAME = process.env.AI_BRIDGE_CLIENT || 'unknown';
// 服务端会在客户端名与内置 CLI 重名时分配 client- 前缀 ID。
// 后续 poll/result/unregister 必须使用服务端返回的 ID，否则会陷入“未注册→重注册”死循环。
let registeredClientId = CLIENT_NAME;
let hostSupportsSampling = false;
let hasRegistered = false;

const MCP_TOOLS = [
  {
    name: 'dispatch',
    description: '把任务分发给已开启的工具(可多个并行)。工具限额/断开时自动转给其他工具接力。返回代码产出和 token 用量。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '任务描述' },
        context: { type: 'string', description: '任务上下文(背景/现有代码/约束等),会前置注入给子工具' },
        tools: { type: 'array', items: { type: 'string' }, description: '工具名列表,留空用所有已开启的' },
        auto_fallback: { type: 'boolean', description: '工具限额/失败时自动转给其他工具接力(默认 true)', default: true }
      },
      required: ['task']
    }
  },
  {
    name: 'list_tools',
    description: '列出所有工具:检测状态 + 开关状态 + 累计 token',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'toggle_tool',
    description: '打开/关闭工具开关',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '工具名' },
        enabled: { type: 'boolean', description: 'true开 false关' }
      },
      required: ['tool', 'enabled']
    }
  },
  {
    name: 'list_switches',
    description: '查看所有工具开关状态',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'token_stats',
    description: '查看累计 token 用量统计',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'handoff',
    description: '接力:把已有代码传给另一个工具接着干',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '未完成的任务描述' },
        existing_code: { type: 'string', description: '已有的代码' },
        from: { type: 'string', description: '来源工具名' },
        to: { type: 'string', description: '目标工具名' }
      },
      required: ['task', 'existing_code', 'to']
    }
  },
  {
    name: 'memory_search',
    description: '搜索历史任务记录和经验记忆(之前调过什么工具、结果怎么样)',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_recent',
    description: '查看最近的 dispatch 任务记录',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数,默认10' }
      }
    }
  },
  {
    name: 'logs',
    description: '查看服务运行日志(调试用)',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', description: '过滤级别: info/warn/error/debug' },
        limit: { type: 'number', description: '返回条数,默认50' }
      }
    }
  },
  {
    name: 'discuss',
    description: '召开 AI 讨论会:指定话题和参与者,各工具先独立发表观点,再看到其他人的观点后补充。返回完整讨论记录。',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '讨论话题,如"这个模块用队列还是数组"' },
        participants: {
          type: 'array',
          items: { type: 'string' },
          description: '参与者工具名列表,如 ["openclaw","atom-code"]。留空用所有已开启的工具。'
        },
        round2: { type: 'boolean', description: '是否进行第二轮(看到其他人的观点后补充),默认 true', default: true },
        implement: { type: 'boolean', description: '讨论完后自动派发写代码任务(用讨论结论作为任务描述)', default: false },
        guidance: { type: 'string', description: '主持人引导信息(注入讨论方向/约束/纠正)' },
        round2_guidance: { type: 'string', description: '第二轮的额外引导(看到第一轮结果后补充方向)' }
      },
      required: ['topic']
    }
  },
  {
    name: 'discuss_status',
    description: '查看讨论会状态和实时发言内容',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: '会议ID' }
      },
      required: ['meetingId']
    }
  },
  {
    name: 'discuss_interrupt',
    description: '中断正在进行的讨论会(防止无休止循环或方向偏移)',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: '会议ID' },
        reason: { type: 'string', description: '中断原因' }
      },
      required: ['meetingId']
    }
  },
  {
    name: 'discuss_inject',
    description: '向正在进行的讨论会注入主持人消息(纠正方向/补充信息/指出错误)',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: '会议ID' },
        message: { type: 'string', description: '注入的消息内容(如"你们讨论的方向偏了,应该考虑XXX"或"这个方案有安全问题")' }
      },
      required: ['meetingId', 'message']
    }
  },
  {
    name: 'list_clients',
    description: '查看接入共享中枢的客户端:已连接 / 待审批 / 黑名单',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'approve_client',
    description: '批准某个待审批客户端加入共享中枢(移入白名单)',
    inputSchema: {
      type: 'object',
      properties: { clientId: { type: 'string', description: '客户端ID(见 list_clients)' } },
      required: ['clientId']
    }
  },
  {
    name: 'deny_client',
    description: '拒绝并拉黑某个客户端,禁止其加入(移入黑名单,若在线则踢出)',
    inputSchema: {
      type: 'object',
      properties: { clientId: { type: 'string', description: '客户端ID' } },
      required: ['clientId']
    }
  },
  {
    name: 'kick_client',
    description: '把已加入的客户端踢出中枢;block=true 时同时拉黑',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: '客户端ID' },
        block: { type: 'boolean', description: '是否同时拉黑,默认 false' }
      },
      required: ['clientId']
    }
  }
];

// ── HTTP 请求 ──

function httpPost (path, body, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (BRIDGE_TOKEN) headers['Authorization'] = 'Bearer ' + BRIDGE_TOKEN;
    const req = http.request({
      hostname: BRIDGE_HOST, port: BRIDGE_PORT, path, method: 'POST',
      headers,
      timeout: timeoutMs
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { reject(new Error('服务返回格式错误')); } });
    });
    req.on('error', e => reject(new Error(`无法连接 AI Bridge 服务(${BRIDGE_HOST}:${BRIDGE_PORT})。请先启动: node server.js\n错误: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(data); req.end();
  });
}

function httpGet (path) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (BRIDGE_TOKEN) headers['Authorization'] = 'Bearer ' + BRIDGE_TOKEN;
    http.get({ hostname: BRIDGE_HOST, port: BRIDGE_PORT, path, timeout: 30000, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { reject(new Error('格式错误')); } });
    }).on('error', e => reject(new Error(`无法连接服务: ${e.message}`)));
  });
}

// ── MCP 工具调用 → HTTP API ──

async function callTool (name, args) {
  switch (name) {
  case 'dispatch': {
    const r = await httpPost('/api/dispatch', args);
    if (r.error) return { content: [{ type: 'text', text: r.error }], isError: true };
    const lines = [];
    (r.results || []).forEach(res => {
      if (res.success) {
        const tl = res.tokens.estimated ? `~${res.tokens.total} tokens(估算)` : `${res.tokens.total} tokens`;
        const fb = res.fallback ? ` ⚡接力自${res.fallbackFrom}` : '';
        lines.push(`## ${res.displayName} ✅ (${res.duration}, ${tl})${fb}`);
        if (res.codeBlocks && res.codeBlocks.length > 0) {
          res.codeBlocks.forEach(b => lines.push(`\`\`\`${b.language}\n${b.code}\n\`\`\``));
        } else { lines.push(`(无代码块)\n${(res.content || '').substring(0, 300)}`); }
      } else {
        lines.push(`## ${res.tool} ❌ ${res.reason || '失败'}`);
      }
    });
    if (r.fallbackLog && r.fallbackLog.length > 0) {
      lines.push('\n---\n⚡ 故障转移:');
      r.fallbackLog.forEach(f => lines.push(`  ${f.from}→${f.to} ${f.success ? '✅' : '❌'}${f.skipped ? '(' + f.skipped + ')' : ''}`));
    }
    lines.push(`\n📊 ${r.totalTokens} tokens | ${r.successCount}/${r.total} 成功`);
    if (r.skipped && r.skipped.length > 0) lines.push(`⚠️ 跳过(关闭): ${r.skipped.join(', ')}`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  case 'list_tools': {
    const d = await httpGet('/api/tools');
    const lines = ['# 本机 AI 编程工具\n', '| 工具 | 检测 | 开关 | tokens | 次数 |', '|------|------|------|--------|------|'];
    d.tools.forEach(t => lines.push(`| ${t.displayName} (${t.name}) | ${t.available ? '✅' : '❌'} | ${t.enabled ? '🟢' : '🔴'} | ${(t.tokens || 0).toLocaleString()} | ${t.calls || 0} |`));
    lines.push(`\n**总计: ${(d.total.total || 0).toLocaleString()} tokens, ${d.total.calls || 0} 次**`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  case 'toggle_tool': {
    await httpPost('/api/toggle', args);
    return { content: [{ type: 'text', text: `✅ ${args.tool} 已${args.enabled ? '打开' : '关闭'}` }] };
  }
  case 'list_switches': {
    const d = await httpGet('/api/tools');
    const lines = ['# 工具开关状态\n'];
    d.tools.forEach(t => lines.push(`- ${t.enabled ? '🟢' : '🔴'} **${t.displayName}** (${t.name}) — ${t.enabled ? '开' : '关'}`));
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  case 'token_stats': {
    const d = await httpGet('/api/stats');
    if (!d.tools || Object.keys(d.tools).length === 0) return { content: [{ type: 'text', text: '暂无 token 记录' }] };
    const lines = ['# 📊 Token 统计\n', '| 工具 | 输入 | 输出 | 总计 | 次数 |', '|------|------|------|------|------|'];
    for (const [n, s] of Object.entries(d.tools)) lines.push(`| ${n} | ${(s.input || 0).toLocaleString()} | ${(s.output || 0).toLocaleString()} | ${(s.total || 0).toLocaleString()} | ${s.calls || 0} |`);
    lines.push(`\n**总计: ${(d.total?.total || 0).toLocaleString()} tokens, ${d.total?.calls || 0} 次**`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  case 'handoff': {
    const r = await httpPost('/api/handoff', args);
    if (!r.success) return { content: [{ type: 'text', text: `接力失败: ${r.error}` }], isError: true };
    // from undefined 防御
    const fromLabel = r.from && r.from !== 'unknown' ? `${r.from} → ` : '';
    const lines = [`# 接力: ${fromLabel}${r.displayName} ✅ (${r.duration})`];
    if (r.codeBlocks && r.codeBlocks.length > 0) {
      r.codeBlocks.forEach(b => lines.push(`\`\`\`${b.language}\n${b.code}\n\`\`\``));
    } else { lines.push(r.content?.substring(0, 500) || '(无输出)'); }
    lines.push(`\n📊 ${r.tokens.total} tokens`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  case 'memory_search': {
    const r = await httpPost('/api/memory/search', args);
    const lines = ['# 🔍 记忆搜索\n'];
    if (r.tasks?.length > 0) {
      lines.push('## 任务历史');
      r.tasks.forEach(t => lines.push(`- [${t.ts}] "${t.task}" → ${t.successCount}/${t.results?.length || 0} 成功, ${t.totalTokens} tokens`));
    }
    if (r.experiences?.length > 0) {
      lines.push('\n## 经验记录');
      r.experiences.forEach(e => lines.push(`- [${e.category}] ${e.content.substring(0, 100)}`));
    }
    if (!r.tasks?.length && !r.experiences?.length) lines.push('未找到匹配记录');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  case 'memory_recent': {
    const limit = args.limit || 10;
    const r = await httpGet('/api/memory/recent?limit=' + limit);
    const lines = ['# 📋 最近任务\n'];
    (r.tasks || []).forEach(t => {
      lines.push(`[${t.ts}] "${t.task}"`);
      lines.push(`  工具: ${(t.tools || []).join(', ')} | ${t.successCount}/${t.results?.length || 0} 成功 | ${t.totalTokens} tokens`);
      if (t.fallbackLog?.length) lines.push(`  ⚡ ${t.fallbackLog.map(f => `${f.from}→${f.to}`).join(', ')}`);
      lines.push('');
    });
    if (!r.tasks?.length) lines.push('暂无任务记录');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  case 'logs': {
    const params = new URLSearchParams();
    if (args.level) params.set('level', args.level);
    params.set('limit', args.limit || 50);
    const r = await httpGet('/api/logs?' + params.toString());
    const lines = ['# 📝 服务日志\n'];
    (r.logs || []).forEach(l => {
      const time = l.ts?.substring(11, 19) || '';
      lines.push(`[${time}] ${l.level?.toUpperCase() || '?'} ${l.msg}`);
    });
    if (!r.logs?.length) lines.push('暂无日志');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  case 'discuss': {
    const r = await httpPost('/api/discuss', args);
    if (r.error || !r.meetingId) return { content: [{ type: 'text', text: r.error || '讨论失败' }], isError: true };
    // 异步模式:立即返回会议ID,告诉用户怎么查进度
    return { content: [{ type: 'text', text: `🗣️ 讨论已启动!\n\n话题: ${r.topic}\n参与者: ${(r.participants || []).join(', ')}\n会议ID: ${r.meetingId}\n状态: ${r.status}\n\n用 discuss_status 查看进度\n用 discuss_inject 注入引导信息\n用 discuss_interrupt 中断讨论` }] };
  }
  case 'discuss_status': {
    const meetingId = args.meetingId || args.meeting_id;
    if (!meetingId) return { content: [{ type: 'text', text: '缺少 meetingId' }], isError: true };
    const r = await httpGet('/api/discuss/status/' + meetingId);
    const lines = [`# 📋 讨论状态\n`, `话题: ${r.topic}`, `状态: ${r.status}`, `轮次: ${r.round}`, `发言: ${r.messageCount} 条, ${r.totalTokens} tokens`];
    if (r.interrupted) lines.push(`⚠️ 已中断: ${r.interruptReason}`);
    if (r.summary) lines.push(`摘要: ${r.summary}`);
    lines.push('');
    (r.messages || []).forEach(msg => {
      const time = msg.ts?.substring(11, 19) || '';
      const tag = msg.injected ? ' [注入]' : '';
      lines.push(`### ${msg.speaker}${tag} (${time})`);
      lines.push((msg.content || '(无内容)').substring(0, 500));
      lines.push('');
    });
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  case 'discuss_interrupt': {
    const r = await httpPost('/api/discuss/interrupt', args);
    if (r.error) return { content: [{ type: 'text', text: r.error }], isError: true };
    return { content: [{ type: 'text', text: `🛑 会议 ${r.meetingId} 已中断: ${r.reason}` }] };
  }
  case 'discuss_inject': {
    const r = await httpPost('/api/discuss/inject', args);
    if (r.error) return { content: [{ type: 'text', text: r.error }], isError: true };
    return { content: [{ type: 'text', text: `✅ 已向会议 ${r.meetingId} 注入主持人消息` }] };
  }
  case 'list_clients': {
    const d = await httpGet('/api/clients');
    const lines = ['# 🔌 接入共享中枢的客户端\n', '## 已连接'];
    if ((d.clients || []).length) d.clients.forEach(c => lines.push(`- 🟢 ${c.name} (${c.id})${c.busy ? ' [忙]' : ''} — 自 ${c.connectedAt || '?'}`));
    else lines.push('(无)');
    lines.push('\n## 待审批');
    if ((d.pending || []).length) d.pending.forEach(pd => lines.push(`- ⏳ ${pd.name} (${pd.clientId}) — 请求于 ${pd.requestedAt || '?'}`));
    else lines.push('(无)');
    lines.push('\n## 黑名单');
    lines.push((d.blocklist || []).length ? d.blocklist.map(x => `- ⛔ ${x}`).join('\n') : '(无)');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  case 'approve_client': {
    const r = await httpPost('/api/clients/approve', args);
    if (!r.success) return { content: [{ type: 'text', text: r.error || '批准失败' }], isError: true };
    return { content: [{ type: 'text', text: `✅ 已批准客户端 ${r.clientId} 加入共享中枢` }] };
  }
  case 'deny_client': {
    const r = await httpPost('/api/clients/deny', args);
    if (!r.success) return { content: [{ type: 'text', text: r.error || '拒绝失败' }], isError: true };
    return { content: [{ type: 'text', text: `⛔ 已拒绝并拉黑客户端 ${r.clientId}` }] };
  }
  case 'kick_client': {
    const r = await httpPost('/api/clients/kick', args);
    if (!r.success) return { content: [{ type: 'text', text: r.error || '踢出失败' }], isError: true };
    return { content: [{ type: 'text', text: `👢 已踢出客户端 ${r.clientId}${r.blocked ? '(并拉黑)' : ''}` }] };
  }
  default:
    return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true };
  }
}

// ── MCP 协议 ──

function sendResult (id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError (id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handleMessage (msg) {
  const { method, params, id } = msg;
  if (id === undefined || id === null) return;
  let result;
  switch (method) {
  case 'initialize':
    // MCP 客户端只有显式声明 sampling capability，才可承接中枢的 server→client 反向任务。
    hostSupportsSampling = !!params?.capabilities?.sampling;
    if (hasRegistered) {
      // 初始化通常晚于进程启动注册；能力一旦明确，立即幂等刷新到中枢。
      httpPost('/api/client/register', { name: CLIENT_NAME, capabilities: { sampling: hostSupportsSampling } })
        .catch(() => {});
    }
    result = { protocolVersion: '2024-11-05', capabilities: { tools: {}, sampling: {} }, serverInfo: { name: 'ai-bridge', version: '1.1.0' } };
    break;
  case 'initialized': return;
  case 'tools/list': result = { tools: MCP_TOOLS }; break;
  case 'tools/call':
    result = await callTool(params.name, params.arguments || {});
    break;
  case 'ping': result = {}; break;
  default: sendError(id, -32601, `未知方法: ${method}`); return;
  }
  sendResult(id, result);
}

// ── 反向调用:长轮询 + MCP sampling ──

let msgIdCounter = 1000;
const pendingRequests = new Map();

function sendMCPRequest (method, params) {
  const id = ++msgIdCounter;
  return new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('客户端响应超时'));
    }, parseInt(process.env.AI_BRIDGE_SAMPLING_TIMEOUT) || 900000); // 防泄漏兜底,节奏由服务端 EXECUTE_TIMEOUT 管控;慢宿主需要更长窗口
    pendingRequests.set(id, { resolve, reject, timeout });
  });
}

// ── 启动 ──

process.stderr.write('[ai-bridge] 桥接器启动,连接常驻服务...\n');

let shuttingDown = false;
async function shutdown (signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await httpPost('/api/client/unregister', { clientId: registeredClientId }, 1500);
  } catch (_) {
    // 中枢可能已停止；关闭流程不能因此卡住宿主。
  } finally {
    process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 0);
  }
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false, crlfDelay: Infinity });

rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  try {
    const msg = JSON.parse(t);
    if (msg.id !== undefined && pendingRequests.has(msg.id)) {
      const { resolve, reject, timeout } = pendingRequests.get(msg.id);
      clearTimeout(timeout);
      pendingRequests.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || '客户端错误'));
      else resolve(msg.result);
      return;
    }
    handleMessage(msg).catch(e => sendError(msg.id, -32603, e.message));
  } catch (e) {
    process.stderr.write(`[ai-bridge] 忽略非 JSON 输入: ${t.substring(0, 80)}\n`);
  }
});

rl.on('close', () => { shutdown('stdio-close'); });

// 注册客户端(带重连 + 准入等待:未启动/待审批/被拒时按不同节奏重试)
async function registerWithRetry () {
  let retryDelay = 1000;
  let retryCount = 0;
  const MAX_RETRIES = 100;
  while (retryCount < MAX_RETRIES) {
    try {
      const r = await httpPost('/api/client/register', { name: CLIENT_NAME, capabilities: { sampling: hostSupportsSampling } });
      if (r && r.status === 'approved') {
        registeredClientId = r.clientId || CLIENT_NAME;
        hasRegistered = true;
        process.stderr.write(`[ai-bridge] 已加入共享中枢(已批准, ID=${registeredClientId}, sampling=${hostSupportsSampling})\n`);
        return true;
      }
      if (r && r.status === 'denied') {
        process.stderr.write('[ai-bridge] 已被管理员拒绝,30 秒后重试...\n');
        await new Promise(res => setTimeout(res, 30000));
        continue;
      }
      process.stderr.write('[ai-bridge] 已进入待审批队列,等待批准(5 秒后重试)...\n');
      await new Promise(res => setTimeout(res, 5000));
    } catch (e) {
      retryCount++;
      process.stderr.write(`[ai-bridge] 连接失败(${retryCount}/${MAX_RETRIES}),${Math.round(retryDelay/1000)}秒后重试: ${e.message.substring(0, 80)}\n`);
      await new Promise(res => setTimeout(res, retryDelay));
      retryDelay = Math.min(retryDelay * 1.5, 30000);
    }
  }
  // 重试耗尽不再静默退出,明确告知已放弃注册
  process.stderr.write(`[ai-bridge] 注册重试已耗尽(${MAX_RETRIES} 次),放弃连接中枢,请检查中枢是否存活后重启客户端\n`);
  return false;
}

// 长轮询循环
let lastPollErrorLogAt = 0; // 限频日志:同类轮询错误每 60 秒最多打 1 条,避免中枢离线时刷屏
async function pollLoop () {
  while (true) {
    try {
      const res = await httpPost('/api/poll', { clientId: registeredClientId });
      if (res && res.error === '未注册') {
        process.stderr.write('[ai-bridge] 已被服务端移除,重新申请加入...\n');
        const ok = await registerWithRetry();
        if (!ok) {
          process.stderr.write('[ai-bridge] 重新注册失败,停止轮询\n');
          return;
        }
        continue;
      }
      if (res.task) {
        process.stderr.write('[ai-bridge] 收到反向调用任务,请求客户端处理...\n');
        const startedAt = Date.now();
        try {
          const result = await sendMCPRequest('sampling/createMessage', {
            messages: [{ role: 'user', content: res.task.task }],
            maxTokens: parseInt(process.env.AI_BRIDGE_SAMPLING_MAX_TOKENS) || 16384,
            includeContext: 'none'
          });
          const content = result?.content?.text || result?.content || JSON.stringify(result || '');
          await httpPost('/api/result', {
            clientId: registeredClientId,
            content,
            codeBlocks: extractCodeBlocks(content),
            usage: result?.usage ? {
              input: result.usage.inputTokens || 0,
              output: result.usage.outputTokens || 0,
              total: (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0)
            } : null
          });
          process.stderr.write('[ai-bridge] 反向调用完成\n');
          // 观测上报(火后不理,失败不影响主链路)
          httpPost('/api/telemetry', {
            source: CLIENT_NAME,
            events: [{
              type: 'sampling', durationMs: Date.now() - startedAt, success: true,
              inputTokens: result?.usage?.inputTokens || 0, outputTokens: result?.usage?.outputTokens || 0
            }]
          }).catch(() => {});
        } catch (e) {
          // 标记为失败而非成功内容,使服务端 isToolFailed 能识别
          await httpPost('/api/result', { clientId: registeredClientId, content: '(调用失败: ' + e.message + ')', codeBlocks: [], usage: null, failed: true });
          process.stderr.write(`[ai-bridge] 反向调用失败: ${e.message}\n`);
          httpPost('/api/telemetry', {
            source: CLIENT_NAME,
            events: [{ type: 'sampling', durationMs: Date.now() - startedAt, success: false, detail: String(e.message).substring(0, 200) }]
          }).catch(() => {});
        }
      }
    } catch (e) {
      // 服务端不可用,等 5 秒重试(不自愈问题已修复);错误日志限频 60 秒 1 条
      const now = Date.now();
      if (now - lastPollErrorLogAt >= 60000) {
        lastPollErrorLogAt = now;
        process.stderr.write(`[ai-bridge] 轮询失败(60 秒内同类错误不再重复打印): ${String(e.message || e).substring(0, 80)}\n`);
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// 启动:先注册(带重试),成功后启动长轮询;注册失败则不轮询,MCP stdio 服务照常提供
registerWithRetry().then((ok) => {
  if (!ok) {
    process.stderr.write('[ai-bridge] 未连接中枢,仅本地 MCP 功能可用\n');
    return;
  }
  pollLoop();
  process.stderr.write('[ai-bridge] 就绪\n');
});
