#!/usr/bin/env node
/**
 * MCP 服务器完整测试 — 测试 resources 和 prompts
 */
const { spawn } = require('child_process');
const path = require('path');

const serverPath = path.join(__dirname, 'index.js');
const proc = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MODEL_PROVIDER: 'ollama' }
});

let stdoutData = '';
let stderrData = '';

proc.stdout.on('data', (data) => {
  stdoutData += data.toString();
});

proc.stderr.on('data', (data) => {
  stderrData += data.toString();
});

proc.on('close', (code) => {
  console.log('=== MCP Full Test ===\n');
  const lines = stdoutData.trim().split('\n');
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === 3 && msg.result) {
        console.log('✅ resources/list 成功!');
        msg.result.resources.forEach(r => {
          console.log(`   - ${r.uri}: ${r.name}`);
        });
      }
      if (msg.id === 4 && msg.result) {
        console.log('✅ prompts/list 成功!');
        msg.result.prompts.forEach(p => {
          console.log(`   - ${p.name}: ${p.description}`);
        });
      }
      if (msg.id === 5 && msg.result) {
        console.log('✅ prompts/get (task_split) 成功!');
        console.log('   消息数量:', msg.result.messages.length);
      }
      if (msg.id === 6 && msg.result) {
        console.log('✅ resources/read (qidi://modes) 成功!');
        const content = JSON.parse(msg.result.contents[0].text);
        console.log('   模式数量:', Object.keys(content).length);
      }
    } catch (e) {}
  }
  if (stderrData) {
    console.log('\n--- stderr ---');
    console.log(stderrData.trim());
  }
});

function send (id, method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
  proc.stdin.write(msg + '\n');
}

send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } });

setTimeout(() => send(3, 'resources/list', {}), 300);
setTimeout(() => send(4, 'prompts/list', {}), 600);
setTimeout(() => send(5, 'prompts/get', { name: 'task_split', arguments: { task: '写一个Web服务器' } }), 900);
setTimeout(() => send(6, 'resources/read', { uri: 'qidi://modes' }), 1200);
setTimeout(() => proc.stdin.end(), 2000);
