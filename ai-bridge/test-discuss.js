const http = require('http');

const data = JSON.stringify({
  topic: '一个 Web 爬虫项目,应该用 asyncio + aiohttp 还是 requests + 多线程?各有什么优缺点?',
  participants: ['openclaw', 'atom-code'],
  round2: true
});

console.log('🗣️ 发起 AI 讨论会...');
console.log('话题: asyncio vs 多线程 for 爬虫\n');

const req = http.request({
  hostname: '127.0.0.1', port: 9800, path: '/api/discuss', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  timeout: 300000
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
      console.log(`💬 发言: ${d.messageCount} 条 | Token: ${d.totalTokens}`);
      console.log(`🆔 会议ID: ${d.meetingId}`);
      console.log(`════════════════════════════════════════\n`);

      (d.messages || []).forEach((msg, i) => {
        const time = msg.ts?.substring(11, 19) || '';
        console.log(`── ${msg.speaker} (${time}) ──────────────`);
        console.log(msg.content || '(无内容)');
        console.log('');
      });

      console.log(`════════════════════════════════════════`);
      console.log(`✅ 讨论结束,记录已保存到 memory`);
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
