#!/usr/bin/env node
/**
 * MCP 服务器快速测试脚本
 * 通过 stdio 发送 JSON-RPC 消息测试 MCP 服务器
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
  console.log('=== MCP Server Test Results ===\n');
  console.log('Exit code:', code);
  console.log('\n--- stdout (JSON-RPC responses) ---');
  console.log(stdoutData || '(empty)');
  console.log('\n--- stderr (logs) ---');
  console.log(stderrData || '(empty)');

  // 验证 initialize 响应
  try {
    const lines = stdoutData.trim().split('\n');
    for (const line of lines) {
      const msg = JSON.parse(line);
      if (msg.result && msg.result.serverInfo) {
        console.log('\n✅ Initialize 握手成功!');
        console.log('   Server:', msg.result.serverInfo.name, 'v' + msg.result.serverInfo.version);
        console.log('   Protocol:', msg.result.protocolVersion);
        console.log('   Capabilities:', JSON.stringify(msg.result.capabilities));
      }
      if (msg.result && msg.result.tools) {
        console.log('\n✅ tools/list 响应成功!');
        console.log('   工具数量:', msg.result.tools.length);
        msg.result.tools.forEach(t => {
          console.log(`   - ${t.name}: ${t.description.substring(0, 60)}...`);
        });
      }
    }
  } catch (e) {
    console.log('\n❌ 解析响应失败:', e.message);
  }
});

// 发送 initialize 请求
const initMsg = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  }
});

proc.stdin.write(initMsg + '\n');

// 等待一下再发送 tools/list
setTimeout(() => {
  const toolsListMsg = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  });
  proc.stdin.write(toolsListMsg + '\n');
}, 500);

// 再等待后关闭
setTimeout(() => {
  proc.stdin.end();
}, 1500);
