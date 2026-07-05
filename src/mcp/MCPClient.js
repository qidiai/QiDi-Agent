/**
 * @module MCPClient
 *
 * MCP 客户端 — 让 Qidi Agent 能连接并消费外部 MCP 服务。
 *
 * 支持的传输方式：
 * - stdio: 通过子进程标准输入/输出通信
 * - sse: 通过 HTTP Server-Sent Events 通信
 *
 * 核心能力：
 * 1. 连接多个 MCP Server
 * 2. 动态发现可用工具
 * 3. 调用 MCP 工具
 * 4. 读取 MCP 资源
 * 5. 将 MCP 工具纳入 TaskRouter 路由池
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const readline = require('readline');
const logger = require('../utils/Logger')('MCPClient');
const { safeJsonParse } = require('../utils/SafeParser');

const PROTOCOL_VERSION = '2024-11-05';

// ── Stdio 传输 ──

class StdioTransport {
  constructor (command, args = [], options = {}) {
    this.command = command;
    this.args = args;
    this.options = options;
    this.process = null;
    this.rl = null;
    this._pendingRequests = new Map();
    this._requestId = 0;
  }

  async connect () {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...this.options.env },
          cwd: this.options.cwd || process.cwd(),
          shell: process.platform === 'win32'
        });

        this.rl = readline.createInterface({
          input: this.process.stdout,
          crlfDelay: Infinity
        });

        this.rl.on('line', (line) => this._handleMessage(line));

        this.process.stderr.on('data', (data) => {
          const msg = data.toString().trim();
          if (msg) logger.debug(`[MCP-Stdio] stderr: ${msg}`);
        });

        this.process.on('error', (err) => {
          logger.error(`[MCP-Stdio] 进程错误: ${err.message}`);
          reject(err);
        });

        this.process.on('exit', (code) => {
          logger.info(`[MCP-Stdio] 进程退出: code=${code}`);
          this._rejectAll(new Error(`MCP Server 进程退出: ${code}`));
        });

        this._send('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'qidi-agent', version: '2.0.0' }
        }).then((result) => {
          this._notify('notifications/initialized', {});
          resolve(result);
        }).catch(reject);

        setTimeout(() => reject(new Error('MCP Server 连接超时')), 15000);
      } catch (e) {
        reject(e);
      }
    });
  }

  _handleMessage (line) {
    try {
      const message = safeJsonParse(line, null);
      if (!message) return;
      if (message.id !== undefined && this._pendingRequests.has(message.id)) {
        const { resolve, reject } = this._pendingRequests.get(message.id);
        this._pendingRequests.delete(message.id);
        if (message.error) {
          reject(new Error(message.error.message || JSON.stringify(message.error)));
        } else {
          resolve(message.result);
        }
      }
    } catch (e) {
      logger.warn(`[MCP-Stdio] 消息解析失败: ${e.message}`);
    }
  }

  _send (method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      const request = { jsonrpc: '2.0', id, method, params };
      this._pendingRequests.set(id, { resolve, reject });
      try {
        this.process.stdin.write(JSON.stringify(request) + '\n');
      } catch (e) {
        this._pendingRequests.delete(id);
        reject(new Error(`发送失败: ${e.message}`));
      }
      setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          reject(new Error(`MCP 请求超时: ${method}`));
        }
      }, 30000);
    });
  }

  _notify (method, params) {
    const notification = { jsonrpc: '2.0', method, params };
    try {
      this.process.stdin.write(JSON.stringify(notification) + '\n');
    } catch (e) {
      logger.warn(`[MCP-Stdio] 通知发送失败: ${e.message}`);
    }
  }

  async callTool (name, args) {
    return this._send('tools/call', { name, arguments: args });
  }

  async listTools () {
    return this._send('tools/list', {});
  }

  async listResources () {
    return this._send('resources/list', {});
  }

  async readResource (uri) {
    return this._send('resources/read', { uri });
  }

  async listPrompts () {
    return this._send('prompts/list', {});
  }

  async getPrompt (name, args) {
    return this._send('prompts/get', { name, arguments: args });
  }

  _rejectAll (error) {
    for (const { reject } of this._pendingRequests.values()) reject(error);
    this._pendingRequests.clear();
  }

  async disconnect () {
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch (_) {}
    }
  }
}

// ── SSE 传输 ──

class SSETransport {
  constructor (url, options = {}) {
    this.url = url;
    this.options = options;
    this._requestId = 0;
    this._pendingRequests = new Map();
    this._res = null;
  }

  async connect () {
    const initResult = await this._post('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'qidi-agent', version: '2.0.0' }
    });
    await this._post('notifications/initialized', {});
    return initResult;
  }

  _post (method, params) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.url);
      const postData = JSON.stringify({ jsonrpc: '2.0', id: ++this._requestId, method, params });
      const protocol = url.protocol === 'https:' ? https : http;

      const req = protocol.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      }, (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          try {
            const msg = JSON.parse(body);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => reject(new Error('SSE 请求超时')));
      req.write(postData);
      req.end();
    });
  }

  async callTool (name, args) {
    return this._post('tools/call', { name, arguments: args });
  }

  async listTools () {
    return this._post('tools/list', {});
  }

  async listResources () {
    return this._post('resources/list', {});
  }

  async readResource (uri) {
    return this._post('resources/read', { uri });
  }

  async disconnect () {}
}

// ── MCPClient 主类 ──

class MCPClient {
  constructor (options = {}) {
    this.servers = new Map(); // name -> { transport, tools, resources, info }
    this.configPath = options.configPath || path.join(process.cwd(), 'config', 'mcp_servers.json');
    this._adapterWrappers = new Map();
  }

  /**
   * 从配置文件加载所有 MCP Server
   */
  async loadFromConfig () {
    if (!fs.existsSync(this.configPath)) {
      logger.info('[MCPClient] 未找到 MCP 配置文件，跳过加载');
      return [];
    }

    const config = safeJsonParse(fs.readFileSync(this.configPath, 'utf-8'), { servers: {} });
    const connected = [];

    for (const [name, serverConfig] of Object.entries(config.servers || {})) {
      if (!serverConfig.enabled) continue;
      try {
        await this.connectServer(name, serverConfig);
        connected.push(name);
      } catch (e) {
        logger.warn(`[MCPClient] 连接 ${name} 失败: ${e.message}`);
      }
    }

    return connected;
  }

  /**
   * 连接一个 MCP Server
   */
  async connectServer (name, config) {
    let transport;

    if (config.transport === 'sse' || config.url) {
      transport = new SSETransport(config.url, config.options || {});
    } else {
      // stdio (默认)
      const command = config.command || 'npx';
      const args = config.args || [];
      transport = new StdioTransport(command, args, config.options || {});
    }

    await transport.connect();

    // 发现工具和资源
    let tools = [];
    let resources = [];
    try {
      tools = (await transport.listTools())?.tools || [];
    } catch (_) {}
    try {
      resources = (await transport.listResources())?.resources || [];
    } catch (_) {}

    this.servers.set(name, {
      transport,
      tools,
      resources,
      info: { name, ...config }
    });

    logger.info(`[MCPClient] 已连接 ${name}: ${tools.length} 个工具, ${resources.length} 个资源`);

    return { name, tools, resources };
  }

  /**
   * 断开某个 Server
   */
  async disconnectServer (name) {
    const server = this.servers.get(name);
    if (server) {
      await server.transport.disconnect();
      this.servers.delete(name);
      logger.info(`[MCPClient] 已断开 ${name}`);
    }
  }

  /**
   * 断开所有 Server
   */
  async disconnectAll () {
    const names = Array.from(this.servers.keys());
    for (const name of names) {
      await this.disconnectServer(name);
    }
  }

  /**
   * 获取所有可用工具（跨所有已连接 Server）
   */
  getAllTools () {
    const allTools = [];
    for (const [serverName, server] of this.servers) {
      for (const tool of server.tools) {
        allTools.push({
          ...tool,
          serverName,
          qualifiedName: `${serverName}.${tool.name}`
        });
      }
    }
    return allTools;
  }

  /**
   * 调用 MCP 工具
   */
  async callTool (serverName, toolName, args = {}) {
    const server = this.servers.get(serverName);
    if (!server) throw new Error(`未连接的 MCP Server: ${serverName}`);
    return server.transport.callTool(toolName, args);
  }

  /**
   * 通过限定名调用工具（serverName.toolName）
   */
  async callToolByName (qualifiedName, args = {}) {
    const [serverName, toolName] = qualifiedName.split('.');
    return this.callTool(serverName, toolName, args);
  }

  /**
   * 读取 MCP 资源
   */
  async readResource (serverName, uri) {
    const server = this.servers.get(serverName);
    if (!server) throw new Error(`未连接的 MCP Server: ${serverName}`);
    return server.transport.readResource(uri);
  }

  /**
   * 获取所有资源
   */
  getAllResources () {
    const all = [];
    for (const [serverName, server] of this.servers) {
      for (const resource of server.resources) {
        all.push({ ...resource, serverName });
      }
    }
    return all;
  }

  /**
   * 将 MCP 工具包装为 ToolAdapter 兼容接口
   * 使其可以被纳入 TaskRouter 路由池
   */
  getToolAdapters () {
    const adapters = [];
    for (const [serverName, server] of this.servers) {
      for (const tool of server.tools) {
        const adapter = this._wrapAsAdapter(serverName, tool, server.transport);
        adapters.push(adapter);
        this._adapterWrappers.set(`${serverName}.${tool.name}`, adapter);
      }
    }
    return adapters;
  }

  _wrapAsAdapter (serverName, tool, transport) {
    return {
      name: `mcp.${serverName}.${tool.name}`,
      displayName: `[MCP] ${tool.name}`,
      description: tool.description || '',
      command: 'mcp',
      isAvailable: () => true,
      isInstalled: () => true,
      async detect () {
        return true;
      },
      async connect () {
        return true;
      },
      async execute (task, options = {}) {
        try {
          const args = this._parseToolArgs(task, tool);
          const result = await transport.callTool(tool.name, args);
          return {
            success: !result.isError,
            content: result.content?.map(c => c.text || '').join('\n') || '',
            tool: `mcp.${serverName}.${tool.name}`,
            exitCode: result.isError ? 1 : 0,
            startTime: Date.now(),
            endTime: Date.now(),
            duration: 0,
            generatedFiles: [],
            codeBlocks: [],
            error: result.isError ? result.content?.map(c => c.text || '').join('\n') : null
          };
        } catch (e) {
          return {
            success: false,
            content: '',
            error: e.message,
            tool: `mcp.${serverName}.${tool.name}`,
            exitCode: -1,
            startTime: Date.now(),
            endTime: Date.now(),
            duration: 0,
            generatedFiles: [],
            codeBlocks: []
          };
        }
      },
      _parseToolArgs (task, toolDef) {
        // 尝试从任务中提取参数
        const args = {};
        if (toolDef.inputSchema?.properties) {
          for (const [key, schema] of Object.entries(toolDef.inputSchema.properties)) {
            if (task[key] !== undefined) {
              args[key] = task[key];
            } else if (task.context && task.context[key] !== undefined) {
              args[key] = task.context[key];
            } else if (schema.default !== undefined) {
              args[key] = schema.default;
            } else if (key === 'path' || key === 'filePath' || key === 'file') {
              args[key] = task.workspaceDir || task.path || task.filePath || '.';
            } else if (key === 'command' || key === 'query' || key === 'content' || key === 'input') {
              args[key] = task.description || task.title || task.content || '';
            }
          }
        }
        return args;
      },
      getInfo () {
        return {
          name: `mcp.${serverName}.${tool.name}`,
          displayName: `[MCP] ${tool.name}`,
          description: tool.description || '',
          installed: true,
          version: '1.0.0'
        };
      }
    };
  }

  /**
   * 获取服务器状态
   */
  getStatus () {
    const status = [];
    for (const [name, server] of this.servers) {
      status.push({
        name,
        toolCount: server.tools.length,
        resourceCount: server.resources.length,
        command: server.info.command,
        args: server.info.args
      });
    }
    return status;
  }

  /**
   * 创建默认配置文件
   */
  createDefaultConfig (extraServers = {}) {
    const defaultConfig = {
      servers: {
        filesystem: {
          enabled: false,
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', './workspace'],
          options: {}
        },
        git: {
          enabled: false,
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-git'],
          options: {}
        },
        fetch: {
          enabled: false,
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-fetch'],
          options: {}
        },
        memory: {
          enabled: false,
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          options: {}
        },
        sqlite: {
          enabled: false,
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-sqlite', './data/qidi.db'],
          options: {}
        },
        ...extraServers
      }
    };

    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
    logger.info(`[MCPClient] 已创建默认配置: ${this.configPath}`);
    return defaultConfig;
  }
}

module.exports = MCPClient;
