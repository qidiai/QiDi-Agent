const http = require('http');

const auditPrompt = `你是资深代码审计专家。请审计以下 MCP 服务的核心代码，找出安全漏洞、健壮性问题、资源泄漏。

=== server.js 核心逻辑 ===
1. HTTP 路由:无鉴权,listen 127.0.0.1:9800
2. executeClient:用 Promise+setTimeout 实现反向调用,120s 超时
3. doDispatch:Promise.allSettled 并行执行,autoFallback 故障转移
4. /api/poll:长轮询 30s,setInterval 每秒检查
5. /api/result:提交结果,直接调用 pendingResolve
6. recordTokens:JSON 文件读写 token 统计

=== bridge-stdio.js ===
1. MCP stdio 桥接,JSON-RPC 2.0 协议
2. 长轮询取任务,收到后通过 MCP sampling/createMessage 反向调用客户端
3. 注册客户端:POST /api/client/register,5s 重试
4. 行拦截:先检查 pendingRequests 再 handleMessage

=== tool-registry.js ===
1. runCommand:spawn 执行命令,Windows 下 shell:true 风险
2. 6 个工具定义:OpenClaw/Claude Code/AtomCode/Qoder/Mimo Code/WorkBuddy
3. 每个工具的 execute 函数:参数格式不统一

请输出:
1. 最严重的 3 个问题(按严重程度排序)
2. 每个问题给:文件位置、复现条件、修复建议
3. 整体评分(1-10)`;

const data = JSON.stringify({ task: auditPrompt, tools: ['openclaw', 'atom-code'], auto_fallback: true });

const req = http.request({
  hostname: '127.0.0.1', port: 9800, path: '/api/dispatch', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  timeout: 180000
}, res => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    const d = JSON.parse(body);
    console.log(`\n成功: ${d.successCount}/${d.total} | Token: ${d.totalTokens}\n`);
    console.log('══════════════════ OpenClaw 审计意见 ══════════════════');
    const oc = (d.results || []).find(r => r.tool === 'openclaw');
    if (oc && oc.success) {
      console.log(oc.content || '(无文本)');
      oc.codeBlocks?.forEach(b => console.log(`\`\`\`${b.language}\n${b.code}\n\`\`\``));
    }
    console.log('\n══════════════════ AtomCode 审计意见 ══════════════════');
    const ac = (d.results || []).find(r => r.tool === 'atom-code');
    if (ac && ac.success) {
      console.log(ac.content || '(无文本)');
      ac.codeBlocks?.forEach(b => console.log(`\`\`\`${b.language}\n${b.code}\n\`\`\``));
    }
    console.log('\n══════════════════ 我的汇总(居中指挥) ══════════════════');
    console.log('两个 AI 交叉验证后的综合结论:');
    if (d.fallbackLog?.length) { console.log('故障转移:', JSON.stringify(d.fallbackLog)); }
  });
});
req.on('error', e => console.log('错误:', e.message));
req.write(data);
req.end();