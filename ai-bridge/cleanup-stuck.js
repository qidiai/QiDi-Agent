const http = require('http');

const ids = [
  'meeting_1784727494244',
  'meeting_1784727378174',
  'meeting_1784727296267',
  'meeting_1784726822096',
  'meeting_1784726775814',
  'meeting_1784726743000'
];

let done = 0;
ids.forEach(id => {
  const data = JSON.stringify({ meetingId: id, reason: '清理卡住的讨论' });
  const req = http.request({
    hostname: '127.0.0.1', port: 9800, path: '/api/discuss/interrupt', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  }, res => {
    let b = '';
    res.on('data', c => b += c);
    res.on('end', () => {
      console.log(`中断 ${id}: ${b}`);
      done++;
      if (done === ids.length) process.exit(0);
    });
  });
  req.write(data);
  req.end();
});
