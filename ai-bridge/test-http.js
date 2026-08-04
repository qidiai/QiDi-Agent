const { spawn } = require('child_process');
const child = spawn('node', ['ai-bridge/bridge-stdio.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, AI_BRIDGE_CLIENT: 'test-client' }
});

const commands = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_tools","arguments":{}}}',
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_switches","arguments":{}}}',
  '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"token_stats","arguments":{}}}',
  '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"toggle_tool","arguments":{"tool":"mimo-code","enabled":false}}}',
  '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"toggle_tool","arguments":{"tool":"mimo-code","enabled":true}}}'
];

let i = 0;
function next () {
  if (i < commands.length) { child.stdin.write(commands[i] + '\n'); i++; }
}

child.stdout.on('data', (data) => {
  const text = data.toString().trim();
  if (!text) return;
  try {
    const msg = JSON.parse(text);
    if (msg.result?.content?.[0]?.text) {
      console.log(`\n=== 请求 ${msg.id} ===`);
      console.log(msg.result.content[0].text.substring(0, 400));
      if (msg.id === 7) process.exit(0);
    } else if (msg.result?.tools) {
      console.log(`\n=== 请求 ${msg.id} ===`);
      console.log(`工具数: ${msg.result.tools.length}`);
      msg.result.tools.forEach(t => console.log(`  - ${t.name}`));
    }
  } catch (_) {}
  setTimeout(next, 500);
});

next();
setTimeout(() => process.exit(0), 30000);
