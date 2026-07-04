#!/usr/bin/env node

/**
 * Qidi Agent MCP Server 入口
 *
 * 启动方式：
 *   node src/mcp/index.js
 *   npx qidi mcp
 *
 * 在 MCP 客户端（如 Claude Desktop）中配置：
 *   {
 *     "mcpServers": {
 *       "qidi-agent": {
 *         "command": "node",
 *         "args": ["path/to/ai-orchestrator/src/mcp/index.js"],
 *         "env": {
 *           "MODEL_PROVIDER": "ollama",
 *           "OLLAMA_MODEL": "qwen2.5:7b"
 *         }
 *       }
 *     }
 *   }
 */

require('dotenv').config();

const path = require('path');
const MCPServer = require('./MCPServer');
const MCPClient = require('./MCPClient');

module.exports = { MCPServer, MCPClient };

// 如果直接执行（非 require），则启动 MCP Server
if (require.main === module) {
  const server = new MCPServer({
    workspaceDir: process.env.MCP_WORKSPACE || path.join(process.cwd(), 'workspace'),
    configDir: process.env.MCP_CONFIG_DIR || path.join(__dirname, '../../config'),
    reportDir: process.env.MCP_REPORT_DIR || path.join(process.cwd(), 'reports'),
    defaultProvider: process.env.MODEL_PROVIDER || 'ollama',
    defaultMode: process.env.MCP_DEFAULT_MODE || 'privacy'
  });

  server.start().catch((err) => {
    process.stderr.write(`[MCP] 启动失败: ${err.message}\n`);
    process.exit(1);
  });
}
