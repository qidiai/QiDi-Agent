const Service = require('node-windows').Service;

const svc = new Service({
  name: 'AI Bridge Hub',
  description: 'AI Bridge 共享中枢(HTTP 常驻服务)',
  // 统一接入:服务运行共享中枢 server.js(非已弃用的 mcp-server.js)
  script: require('path').join(__dirname, 'server.js'),
  workingDirectory: __dirname,
  env: [
    { name: 'AI_BRIDGE_PORT', value: '9800' },
    { name: 'AI_BRIDGE_HOST', value: '127.0.0.1' }
  ],
  nodeOptions: []
});

svc.on('install', function() {
  console.log('Service installed successfully');
  svc.start();
});

svc.on('start', function() {
  console.log('Service started successfully');
  console.log('Port: 9800');
  console.log('Web UI: http://127.0.0.1:9800');
  console.log('Token: 若需鉴权请设环境变量 AI_BRIDGE_TOKEN');
});

svc.on('error', function(err) {
  console.error('Service error:', err);
});

svc.install();