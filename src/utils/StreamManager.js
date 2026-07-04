/**
 * @module StreamManager
 *
 * 全链路流式输出管理器。
 *
 * 职责：
 * 1. 在 Provider 层启用流式响应
 * 2. 在 Agent 层提供 streamGenerate 方法
 * 3. 在 TaskExecutor 层捕获工具 stdout 实时流
 * 4. 在 CLI/WebUI 层通过 SSE 实时展示
 *
 * 使用方式：
 *   const stream = new StreamManager();
 *   stream.on('chunk', (data) => console.log(data.text));
 *   stream.on('done', (result) => console.log('完成'));
 *   agent.streamGenerate(task, context, stream);
 */

const EventEmitter = require('events');
const logger = require('../utils/Logger')('StreamManager');

class StreamManager extends EventEmitter {
  constructor (options = {}) {
    super();
    this.options = options;
    this.chunks = [];
    this.startTime = null;
    this.endTime = null;
    this.totalTokens = 0;
    this.active = false;
  }

  /**
   * 开始流式会话
   */
  start () {
    this.active = true;
    this.startTime = Date.now();
    this.chunks = [];
    this.emit('start', { timestamp: this.startTime });
  }

  /**
   * 接收一个数据块
   */
  push (chunk) {
    if (!this.active) return;

    const data = {
      text: chunk.text || chunk.content || '',
      type: chunk.type || 'text',
      agent: chunk.agent || 'unknown',
      timestamp: Date.now(),
      tokenCount: chunk.tokenCount || 0
    };

    this.chunks.push(data);
    this.totalTokens += data.tokenCount;
    this.emit('chunk', data);
  }

  /**
   * 发送状态更新
   */
  status (status, metadata = {}) {
    this.emit('status', { status, ...metadata, timestamp: Date.now() });
  }

  /**
   * 发送进度
   */
  progress (current, total, message = '') {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    this.emit('progress', { current, total, percent, message, timestamp: Date.now() });
  }

  /**
   * 结束流式会话
   */
  done (result = {}) {
    this.active = false;
    this.endTime = Date.now();
    const summary = {
      duration: this.endTime - this.startTime,
      chunkCount: this.chunks.length,
      totalTokens: this.totalTokens,
      result,
      timestamp: this.endTime
    };
    this.emit('done', summary);
    return summary;
  }

  /**
   * 错误
   */
  error (err) {
    this.active = false;
    this.emit('error', { message: err.message || String(err), timestamp: Date.now() });
  }

  /**
   * 获取完整文本
   */
  getFullText () {
    return this.chunks.map(c => c.text).join('');
  }

  /**
   * 将流转换为 SSE 格式（用于 WebUI）
   */
  toSSE () {
    return (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      const onChunk = (data) => {
        res.write(`data: ${JSON.stringify({ type: 'chunk', ...data })}\n\n`);
      };
      const onStatus = (data) => {
        res.write(`data: ${JSON.stringify({ type: 'status', ...data })}\n\n`);
      };
      const onProgress = (data) => {
        res.write(`data: ${JSON.stringify({ type: 'progress', ...data })}\n\n`);
      };
      const onDone = (data) => {
        res.write(`data: ${JSON.stringify({ type: 'done', ...data })}\n\n`);
        res.end();
        this.removeListener('chunk', onChunk);
        this.removeListener('status', onStatus);
        this.removeListener('progress', onProgress);
        this.removeListener('done', onDone);
      };
      const onError = (data) => {
        res.write(`data: ${JSON.stringify({ type: 'error', ...data })}\n\n`);
        res.end();
        this.removeListener('chunk', onChunk);
        this.removeListener('status', onStatus);
        this.removeListener('progress', onProgress);
        this.removeListener('error', onError);
      };

      this.on('chunk', onChunk);
      this.on('status', onStatus);
      this.on('progress', onProgress);
      this.on('done', onDone);
      this.on('error', onError);

      req.on('close', () => {
        this.active = false;
        this.removeListener('chunk', onChunk);
        this.removeListener('status', onStatus);
        this.removeListener('progress', onProgress);
        this.removeListener('done', onDone);
        this.removeListener('error', onError);
      });
    };
  }

  /**
   * 管道：将一个 StreamManager 的输出转发到另一个
   */
  pipe (target) {
    this.on('chunk', (data) => target.push(data));
    this.on('status', (data) => target.status(data.status, data));
    this.on('progress', (data) => target.progress(data.current, data.total, data.message));
    this.on('done', (data) => target.done(data.result));
    this.on('error', (data) => target.error(new Error(data.message)));
    return target;
  }

  /**
   * 从 Provider 的 chatStream 消费流式响应
   * 桥接 Provider 流式接口与 StreamManager 事件体系
   * @param {Object} provider - Provider 实例（需有 chatStream 方法）
   * @param {Array} messages - 消息数组
   * @param {Object} options - 选项
   * @returns {Promise<Object>} done 摘要
   */
  async streamFromProvider (provider, messages, options = {}) {
    if (!provider || typeof provider.chatStream !== 'function') {
      throw new Error('Provider 不支持 chatStream');
    }

    this.start();
    this.status('streaming', { provider: provider.constructor.name });

    try {
      await provider.chatStream(messages, options, (chunk) => {
        let text = '';
        if (typeof chunk === 'string') {
          text = chunk;
        } else if (chunk.delta && chunk.delta.content) {
          text = chunk.delta.content;
        } else if (chunk.content) {
          text = chunk.content;
        } else if (chunk.text) {
          text = chunk.text;
        } else if (chunk.message && chunk.message.content) {
          text = chunk.message.content;
        }

        if (text) {
          this.push({
            text,
            type: 'text',
            agent: provider.constructor.name,
            tokenCount: Math.max(1, Math.ceil(text.length / 4))
          });
        }
      });

      return this.done({ provider: provider.constructor.name });
    } catch (err) {
      logger.error('Provider 流式失败: ' + err.message);
      this.error(err);
      throw err;
    }
  }

  /**
   * 静态方法：快速创建流式会话并消费 Provider 输出
   */
  static async fromProvider (provider, messages, options = {}) {
    const stream = new StreamManager(options);
    await stream.streamFromProvider(provider, messages, options);
    return stream;
  }
}

module.exports = StreamManager;
