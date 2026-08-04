const { spawn } = require('child_process');
const path = require('path');

const serviceName = 'AIBridgeHub';
const serviceDir = path.resolve(__dirname);
const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
// 统一接入:服务运行共享中枢 server.js(非已弃用的 mcp-server.js),默认端口 9800
const scriptPath = path.join(serviceDir, 'server.js');

// 正确的 binPath 格式：sc 需要嵌套引号
// binPath= "\"C:\Program Files\nodejs\node.exe\" \"C:\path\to\script.js\""
const binPath = `"${nodePath}" "${scriptPath}"`;

console.log('Node.js 路径:', nodePath);
console.log('脚本路径:', scriptPath);
console.log('binPath:', binPath);

function runCmd(cmd, args, callback) {
    const child = spawn(cmd, args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => {
        if (code !== 0) {
            console.error(`${cmd} ${args.join(' ')} 失败 (${code}):`, stderr || stdout);
            callback(new Error(stderr || stdout));
        } else {
            console.log(`${cmd} ${args.join(' ')} 成功`);
            callback(null, stdout);
        }
    });
}

let step = 0;
const steps = [
    (cb) => runCmd('sc', ['stop', serviceName], () => cb(null)),
    (cb) => runCmd('sc', ['delete', serviceName], () => cb(null)),
    (cb) => {
        // 使用 cmd /c 来正确处理引号
        const createCmd = `sc create ${serviceName} binPath= "${binPath}" start= auto DisplayName= "AI Bridge Hub (ai-bridge)"`;
        console.log('创建命令:', createCmd);
        runCmd('cmd', ['/c', createCmd], cb);
    },
    (cb) => runCmd('sc', ['description', serviceName, '本机 AI 编程工具共享中枢(HTTP server.js,默认 9800,可用 AI_BRIDGE_PORT 覆盖)'], cb),
    (cb) => runCmd('sc', ['failure', serviceName, 'reset=', '86400', 'actions=', 'restart/5000'], cb),
    (cb) => runCmd('sc', ['start', serviceName], cb),
];

function runNext() {
    if (step >= steps.length) {
        console.log('\n服务安装完成！');
        return;
    }
    const current = steps[step];
    step++;
    current((err, result) => {
        if (err) {
            console.error(`步骤 ${step} 失败:`, err.message);
            process.exit(1);
        }
        setTimeout(runNext, 1000);
    });
}

runNext();