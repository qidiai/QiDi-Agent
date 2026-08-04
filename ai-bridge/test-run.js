const http = require('http');

const data = JSON.stringify({
  task: '写一个 Python 函数,输入一个列表,返回其中最大的3个数',
  tools: ['openclaw', 'atom-code'],
  auto_fallback: true
});

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
    (d.results || []).forEach(r => {
      if (r.success) {
        console.log(`✅ ${r.displayName} (${r.duration}, ${r.tokens.total} tokens, ${r.codeBlocks.length} 块)`);
        if (r.codeBlocks.length > 0) {
          console.log('```' + r.codeBlocks[0].language);
          console.log(r.codeBlocks[0].code);
          console.log('```');
        }
      } else {
        console.log(`❌ ${r.tool}: ${r.reason}`);
      }
    });
    if (d.fallbackLog && d.fallbackLog.length > 0) {
      console.log('\n⚡ 故障转移:');
      d.fallbackLog.forEach(f => console.log(`  ${f.from} -> ${f.to} ${f.success ? '✅' : '❌'}`));
    }
  });
});
req.on('error', e => console.log('错误:', e.message));
req.on('timeout', () => { console.log('超时'); req.destroy(); });
req.write(data);
req.end();
