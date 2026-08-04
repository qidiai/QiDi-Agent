const Service = require('node-windows').Service;

const svc = new Service({
  name: 'AI Bridge Hub',
  // 必须与 install-service-nodewin.js 的 script 一致(node-windows 靠 name+script 定位服务)
  script: require('path').join(__dirname, 'server.js')
});

svc.on('uninstall', function() {
  console.log('Service uninstalled successfully');
});

svc.uninstall();