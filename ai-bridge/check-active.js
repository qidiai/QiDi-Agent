const http = require('http');
http.get({ hostname: '127.0.0.1', port: 9800, path: '/api/discuss/active' }, res => {
  let b = '';
  res.on('data', c => b += c);
  res.on('end', () => {
    const d = JSON.parse(b);
    console.log('活跃讨论数:', d.count);
    (d.meetings || []).forEach(m => {
      console.log('  ID:', m.id, '话题:', (m.topic || '').substring(0, 50), '参与者:', (m.participants || []).join(','), '发言:', (m.messages || []).length);
    });
  });
});
