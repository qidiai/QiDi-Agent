const http = require('http');

const data = JSON.stringify({
  topic: '写一个 Python LRU 缓存类,需要线程安全,支持过期时间',
  participants: ['openclaw', 'atom-code'],
  round2: true,
  implement: true
});

console.log('🗣️ 发起 AI 讨论会 + 自动实现...');
console.log('话题: Python LRU 缓存(线程安全+过期时间)\n');

const req = http.request({
  hostname: '127.0.0.1', port: 9800, path: '/api/discuss', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  timeout: 600000
}, res => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    try {
      const d = JSON.parse(body);
      if (d.error) { console.log('错误:', d.error); process.exit(1); }

      console.log(`\n════════════════════════════════════════`);
      console.log(`📋 讨论会: ${d.topic}`);
      console.log(`👥 参与者: ${d.participants.join(', ')}`);
      console.log(`💬 发言: ${d.messageCount} 条 | 讨论Token: ${d.totalTokens}`);
      console.log(`════════════════════════════════════════\n`);

      (d.messages || []).forEach(msg => {
        const time = msg.ts?.substring(11, 19) || '';
        console.log(`── ${msg.speaker} (${time}) ──────────────`);
        console.log((msg.content || '(无内容)').substring(0, 600));
        console.log('');
      });

      if (d.implement) {
        console.log(`════════════════════════════════════════`);
        console.log(`🚀 自动实现: ${d.implement.successCount}/${d.implement.total} 成功, ${d.implement.totalTokens} tokens`);
        console.log(`════════════════════════════════════════\n`);

        (d.implement.results || []).forEach(r => {
          if (r.success) {
            console.log(`✅ ${r.displayName} (${r.duration}, ${r.tokens.total} tokens)`);
            if (r.codeBlocks && r.codeBlocks.length) {
              r.codeBlocks.forEach(b => {
                console.log(`\`\`\`${b.language}`);
                console.log(b.code);
                console.log('```');
              });
            }
          } else {
            console.log(`❌ ${r.tool}: ${r.reason}`);
          }
          console.log('');
        });
      }

      console.log(`会议ID: ${d.meetingId}`);
    } catch (e) {
      console.log('解析失败:', e.message);
      console.log('原始响应:', body.substring(0, 500));
    }
  });
});
req.on('error', e => console.log('错误:', e.message));
req.on('timeout', () => { console.log('超时'); req.destroy(); });
req.write(data);
req.end();
