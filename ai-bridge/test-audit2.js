const http = require('http');

const shortPrompt = `你是代码安全专家。快速审计这个 MCP 服务:HTTP 无鉴权,CORS 通配符,setInterval 长轮询可能泄漏,spawn shell:true 风险,并发 dispatch 无限制。指出最严重的 2 个问题并给修复建议。`;

const data = JSON.stringify({ task: shortPrompt, tools: ['openclaw', 'atom-code'], auto_fallback: true });

const req = http.request({
  hostname: '127.0.0.1', port: 9800, path: '/api/dispatch', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  timeout: 180000
}, res => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    const d = JSON.parse(body);
    console.log(`成功: ${d.successCount}/${d.total} | Token: ${d.totalTokens}\n`);
    (d.results || []).forEach(r => {
      if (r.success) {
        console.log(`=== ${r.displayName} (${r.duration}, ${r.tokens.total} tokens, ${r.codeBlocks.length} 块) ===`);
        if (r.codeBlocks.length > 0) r.codeBlocks.forEach(b => console.log(b.code));
        if (r.content) console.log(r.content.substring(0, 800));
      } else {
        console.log(`=== ${r.tool} 失败: ${r.reason} ===`);
      }
    });
    if (d.fallbackLog?.length) console.log('故障转移:', JSON.stringify(d.fallbackLog));
  });
});
req.on('error', e => console.log('错误:', e.message));
req.write(data);
req.end();