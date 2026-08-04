#!/usr/bin/env node
'use strict';

/**
 * AI Bridge Edge Agent
 *
 * 仅发起出站 HTTPS 请求，不监听公网端口。默认只允许安全健康探针；
 * 远程 dispatch 必须显式设置 EDGE_ALLOW_DISPATCH=true。
 */

const crypto = require('crypto');

function positiveInt(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function boolEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function loadConfig(env = process.env) {
  const cloudUrl = String(env.AI_BRIDGE_CLOUD_URL || '').replace(/\/+$/, '');
  const token = String(env.EDGE_AGENT_TOKEN || '');
  if (!cloudUrl) throw new Error('缺少 AI_BRIDGE_CLOUD_URL');
  if (!/^https:\/\//i.test(cloudUrl) && !boolEnv(env.EDGE_ALLOW_INSECURE_HTTP)) {
    throw new Error('云端地址必须使用 HTTPS；本地测试可显式设置 EDGE_ALLOW_INSECURE_HTTP=true');
  }
  if (!token) throw new Error('缺少 EDGE_AGENT_TOKEN');

  return {
    cloudUrl,
    token,
    agentId: String(env.EDGE_AGENT_ID || 'local-edge'),
    localUrl: String(env.AI_BRIDGE_LOCAL_URL || 'http://127.0.0.1:9800').replace(/\/+$/, ''),
    localToken: String(env.AI_BRIDGE_TOKEN || ''),
    allowDispatch: boolEnv(env.EDGE_ALLOW_DISPATCH),
    allowedTools: parseList(env.EDGE_ALLOWED_TOOLS),
    pollMs: positiveInt(env.EDGE_POLL_MS, 5000),
    heartbeatMs: positiveInt(env.EDGE_HEARTBEAT_MS, 30000),
    renewMs: positiveInt(env.EDGE_RENEW_MS, 30000),
    cloudTimeoutMs: positiveInt(env.EDGE_CLOUD_TIMEOUT_MS, 30000),
    localTimeoutMs: positiveInt(env.EDGE_LOCAL_TIMEOUT_MS, 15 * 60 * 1000),
    maxResultChars: positiveInt(env.EDGE_MAX_RESULT_CHARS, 100000)
  };
}

function capabilitiesFor(config) {
  return {
    'bridge:health': true,
    ...(config.allowDispatch ? { 'bridge:dispatch': true } : {})
  };
}

function sanitizeDispatch(payload, config) {
  if (!config.allowDispatch) throw new Error('本机未启用远程 dispatch');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('dispatch payload 必须是对象');
  }
  if (typeof payload.task !== 'string' || !payload.task.trim()) {
    throw new Error('dispatch payload.task 必须是非空字符串');
  }
  if (payload.task.length > 50000) throw new Error('dispatch task 超过 50000 字符');

  let tools;
  if (payload.tools !== undefined) {
    if (!Array.isArray(payload.tools) || payload.tools.some(tool => typeof tool !== 'string')) {
      throw new Error('dispatch payload.tools 必须是字符串数组');
    }
    if (!config.allowedTools.length) {
      throw new Error('远程任务指定了工具，但 EDGE_ALLOWED_TOOLS 为空');
    }
    const denied = payload.tools.filter(tool => !config.allowedTools.includes(tool));
    if (denied.length) throw new Error(`远程任务包含未授权工具: ${denied.join(', ')}`);
    tools = [...payload.tools];
  }

  return {
    task: payload.task,
    ...(typeof payload.context === 'string' ? { context: payload.context.slice(0, 50000) } : {}),
    ...(tools ? { tools } : {}),
    auto_fallback: payload.auto_fallback === true,
    review: payload.review === true,
    ...(typeof payload.reviewer === 'string' ? { reviewer: payload.reviewer } : {})
  };
}

function truncateResult(value, maxChars) {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return value;
  return {
    truncated: true,
    originalChars: text.length,
    preview: text.slice(0, maxChars)
  };
}

class EdgeAgent {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.stopping = false;
    this.lastHeartbeatAt = 0;
  }

  async request(baseUrl, path, { method = 'GET', token, body, timeoutMs } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs || 30000);
    try {
      const response = await this.fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
      if (!response.ok) {
        const message = data?.error || data?.raw || `HTTP ${response.status}`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  cloud(path, options = {}) {
    return this.request(this.config.cloudUrl, path, {
      ...options,
      token: this.config.token,
      timeoutMs: options.timeoutMs || this.config.cloudTimeoutMs
    });
  }

  local(path, options = {}) {
    return this.request(this.config.localUrl, path, {
      ...options,
      token: this.config.localToken || undefined,
      timeoutMs: options.timeoutMs || this.config.localTimeoutMs
    });
  }

  async heartbeat(force = false) {
    if (!force && Date.now() - this.lastHeartbeatAt < this.config.heartbeatMs) return;
    await this.cloud('/v1/agents/heartbeat', {
      method: 'POST',
      body: {
        agentId: this.config.agentId,
        capabilities: capabilitiesFor(this.config)
      }
    });
    this.lastHeartbeatAt = Date.now();
  }

  async claim() {
    const response = await this.cloud('/v1/agent/tasks/claim', {
      method: 'POST',
      body: { agentId: this.config.agentId }
    });
    return response.task || null;
  }

  async renew(task) {
    return this.cloud(`/v1/tasks/${encodeURIComponent(task.id)}/renew`, {
      method: 'POST',
      body: { leaseId: task.leaseId }
    });
  }

  async execute(task) {
    if (task.taskType === 'bridge:health') {
      return this.local('/api/health', { timeoutMs: 10000 });
    }
    if (task.taskType === 'bridge:dispatch') {
      const payload = sanitizeDispatch(task.payload, this.config);
      return this.local('/api/dispatch', {
        method: 'POST',
        body: payload,
        timeoutMs: this.config.localTimeoutMs
      });
    }
    throw new Error(`不允许的远程任务类型: ${task.taskType}`);
  }

  async submit(task, success, result, error) {
    const resultKey = `${task.id}:${task.leaseId}`;
    return this.cloud(`/v1/tasks/${encodeURIComponent(task.id)}/result`, {
      method: 'POST',
      body: {
        leaseId: task.leaseId,
        resultKey,
        success,
        result: truncateResult(result ?? null, this.config.maxResultChars),
        ...(success ? {} : { error: String(error || '执行失败').slice(0, 4000) })
      }
    });
  }

  async processTask(task) {
    let renewalError = null;
    const renewal = setInterval(() => {
      this.renew(task).catch(error => { renewalError = error; });
    }, this.config.renewMs);
    renewal.unref?.();

    try {
      const result = await this.execute(task);
      if (renewalError) throw new Error(`租约续期失败，拒绝提交可能过期的结果: ${renewalError.message}`);
      return await this.submit(task, true, result, null);
    } catch (error) {
      try {
        return await this.submit(task, false, null, error.message);
      } catch (submitError) {
        submitError.cause = error;
        throw submitError;
      }
    } finally {
      clearInterval(renewal);
    }
  }

  async tick() {
    await this.heartbeat();
    const task = await this.claim();
    if (!task) return false;
    await this.processTask(task);
    return true;
  }

  async run() {
    await this.heartbeat(true);
    process.stdout.write(`[edge] 已连接云端，Agent=${this.config.agentId}，dispatch=${this.config.allowDispatch ? '启用' : '禁用'}\n`);
    while (!this.stopping) {
      try {
        const processed = await this.tick();
        if (!processed) await new Promise(resolve => setTimeout(resolve, this.config.pollMs));
      } catch (error) {
        process.stderr.write(`[edge] ${new Date().toISOString()} ${error.message}\n`);
        await new Promise(resolve => setTimeout(resolve, this.config.pollMs));
      }
    }
  }

  stop() {
    this.stopping = true;
  }
}

async function main() {
  const agent = new EdgeAgent(loadConfig());
  process.once('SIGINT', () => agent.stop());
  process.once('SIGTERM', () => agent.stop());
  await agent.run();
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`[edge] 启动失败: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EdgeAgent,
  loadConfig,
  capabilitiesFor,
  sanitizeDispatch,
  truncateResult
};
