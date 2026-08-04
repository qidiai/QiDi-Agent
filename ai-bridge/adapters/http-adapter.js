'use strict';

/**
 * HttpAdapter — HTTP 传输适配器
 *
 * 通过 HTTP POST 调用有 API 端点的 AI 工具。
 *
 * 配置字段:
 *   endpoint:       API URL (如 "http://localhost:8500/generate")
 *   healthEndpoint: 健康检查 URL (如 "/health")，拼接在 endpoint 的 origin 后
 *   parse.textPath: 从 JSON 响应提取文本的 JSONPath
 *   parse.usagePath: 从 JSON 响应提取 usage 的 JSONPath
 *   headers:        自定义请求头 (如 {"Authorization": "Bearer xxx"})
 *   timeout:        超时毫秒数
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { BaseAdapter } = require('./base');

class HttpAdapter extends BaseAdapter {
  constructor (config) {
    super(config);
    this.endpoint = config.endpoint;
    this.healthPath = config.healthPath || '/health';
    this.parseConfig = config.parse || {};
    this.headers = config.headers || {};
    this.timeout = config.timeout || 120000;
  }

  async detect () {
    if (!this.endpoint) return false;
    try {
      const url = new URL(this.endpoint);
      const healthUrl = `${url.protocol}//${url.host}${this.healthPath}`;
      await this._request('GET', healthUrl, null, 5000);
      return true;
    } catch (_) {
      return false;
    }
  }

  async execute (task, opts = {}) {
    if (!this.endpoint) throw new Error(`${this.name}: 缺少 endpoint 配置`);

    const body = {
      task,
      context: opts.context || '',
      taskId: opts.taskId || `${this.name}_${Date.now()}`
    };

    const response = await this._request('POST', this.endpoint, body, opts.timeout || this.timeout);

    // 用 parsePath 提取文本
    const text = this.parseConfig.textPath
      ? this.parsePath(response, this.parseConfig.textPath)
      : (response.text || response.content || response.reply || JSON.stringify(response));

    // 用 parsePath 提取 usage
    let usage = null;
    if (this.parseConfig.usagePath) {
      const rawUsage = this.parsePath(response, this.parseConfig.usagePath);
      if (rawUsage) {
        usage = {
          input: rawUsage.input || rawUsage.inputTokens || 0,
          output: rawUsage.output || rawUsage.outputTokens || 0,
          estimated: false
        };
        usage.total = usage.input + usage.output;
      }
    }

    return this.buildResult(text, usage);
  }

  _request (method, urlStr, body, timeout) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const lib = url.protocol === 'https:' ? https : http;
      const data = body ? JSON.stringify(body) : null;

      const headers = { ...this.headers };
      if (data) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }

      const req = lib.request(url, { method, headers, timeout: timeout || 30000 }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(d)); } catch (_) { resolve(d); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${d.substring(0, 200)}`));
          }
        });
      });

      req.on('error', e => reject(new Error(`HTTP request failed: ${e.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP request timeout')); });
      if (data) req.write(data);
      req.end();
    });
  }
}

module.exports = { HttpAdapter };
