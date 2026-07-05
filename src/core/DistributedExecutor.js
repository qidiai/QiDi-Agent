/**
 * @module DistributedExecutor
 *
 * 分布式执行支持 — 在多台机器上并行执行子任务。
 *
 * 架构：
 * - Master: 负责任务拆分、调度、合并
 * - Worker: 执行具体子任务，汇报结果
 * - 通信: HTTP REST API（Worker 注册 + 心跳 + 任务拉取/推送）
 *
 * 核心能力：
 * 1. Worker 注册与发现
 * 2. 任务分发与负载均衡
 * 3. 心跳监控与故障转移
 * 4. 结果汇总
 * 5. 本地多进程模式（无需多机器）
 */

const http = require('http');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/Logger')('DistributedExecutor');
const { safeJsonParse } = require('../utils/SafeParser');

class DistributedExecutor extends EventEmitter {
  constructor (options = {}) {
    super();
    this.mode = options.mode || 'local'; // local | distributed
    this.masterPort = options.masterPort || 9721;
    this.masterHost = options.masterHost || 'localhost';
    this.workerId = options.workerId || `worker_${require('os').hostname()}_${process.pid}`;
    this.maxWorkers = options.maxWorkers || 4;
    this.heartbeatInterval = options.heartbeatInterval || 15000;
    this.taskTimeout = options.taskTimeout || 300000;

    // Master 状态
    this.workers = new Map(); // workerId -> { info, lastHeartbeat, currentTask, status }
    this.taskQueue = [];
    this.completedTasks = new Map();
    this.server = null;

    // Worker 状态
    this.isWorker = false;
    this.masterUrl = null;
    this._heartbeatTimer = null;

    // 本地多进程
    this.localWorkers = [];
  }

  // ═══════════════════════════════════════════
  // Master 模式
  // ═══════════════════════════════════════════

  /**
   * 启动 Master 服务
   */
  async startMaster () {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handleMasterRequest(req, res));

      this.server.listen(this.masterPort, (err) => {
        if (err) reject(err);
        else {
          logger.info(`[DistributedExecutor] Master 启动: http://${this.masterHost}:${this.masterPort}`);
          this._startHealthCheck();
          resolve();
        }
      });
    });
  }

  _handleMasterRequest (req, res) {
    res.setHeader('Content-Type', 'application/json');

    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const data = safeJsonParse(body, {});
      const url = new URL(req.url, `http://${req.headers.host}`);

      try {
        switch (url.pathname) {
        case '/register':
          this._registerWorker(data, res);
          break;
        case '/heartbeat':
          this._handleHeartbeat(data, res);
          break;
        case '/request-task':
          this._assignTask(data, res);
          break;
        case '/submit-result':
          this._receiveResult(data, res);
          break;
        case '/status':
          res.end(JSON.stringify(this.getClusterStatus()));
          break;
        default:
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  _registerWorker (data, res) {
    const workerId = data.workerId || `worker_${Date.now()}`;
    this.workers.set(workerId, {
      id: workerId,
      info: { host: data.host, port: data.port, capabilities: data.capabilities || {} },
      lastHeartbeat: Date.now(),
      currentTask: null,
      status: 'idle',
      tasksCompleted: 0
    });
    logger.info(`[DistributedExecutor] Worker 注册: ${workerId}`);
    this.emit('worker:registered', { workerId });
    res.end(JSON.stringify({ success: true, workerId, message: 'Registered' }));
  }

  _handleHeartbeat (data, res) {
    const worker = this.workers.get(data.workerId);
    if (worker) {
      worker.lastHeartbeat = Date.now();
      worker.status = data.status || worker.status;
      worker.currentTask = data.currentTask || null;
      res.end(JSON.stringify({ success: true }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, error: 'Unknown worker' }));
    }
  }

  _assignTask (data, res) {
    const worker = this.workers.get(data.workerId);
    if (!worker) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Unknown worker' }));
      return;
    }

    if (this.taskQueue.length > 0) {
      const task = this.taskQueue.shift();
      worker.currentTask = task.id;
      worker.status = 'busy';
      logger.info(`[DistributedExecutor] 分配任务 ${task.id} -> ${data.workerId}`);
      this.emit('task:assigned', { taskId: task.id, workerId: data.workerId });
      res.end(JSON.stringify({ task }));
    } else {
      res.end(JSON.stringify({ task: null }));
    }
  }

  _receiveResult (data, res) {
    const { taskId, result, workerId } = data;
    this.completedTasks.set(taskId, { result, workerId, completedAt: Date.now() });

    const worker = this.workers.get(workerId);
    if (worker) {
      worker.currentTask = null;
      worker.status = 'idle';
      worker.tasksCompleted++;
    }

    logger.info(`[DistributedExecutor] 收到结果: ${taskId}`);
    this.emit('task:completed', { taskId, result, workerId });
    res.end(JSON.stringify({ success: true }));
  }

  /**
   * 分发任务到集群
   */
  async distributeTasks (tasks) {
    if (this.mode === 'local') {
      return this._executeLocalParallel(tasks);
    }

    // 将任务加入队列，等待 Worker 拉取
    for (const task of tasks) {
      this.taskQueue.push(task);
    }

    // 等待所有任务完成
    return new Promise((resolve) => {
      const checkComplete = () => {
        if (this.completedTasks.size >= tasks.length) {
          const results = tasks.map(t => this.completedTasks.get(t.id)).filter(Boolean);
          resolve(results);
        } else {
          setTimeout(checkComplete, 1000);
        }
      };
      checkComplete();
    });
  }

  /**
   * 本地多进程并行执行
   */
  async _executeLocalParallel (tasks) {
    const results = [];
    const chunks = this._chunk(tasks, this.maxWorkers);

    const promises = chunks.map((chunk, workerIdx) => {
      return this._runLocalWorker(chunk, workerIdx);
    });

    const workerResults = await Promise.allSettled(promises);
    for (const result of workerResults) {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        results.push(...result.value);
      }
    }

    return results;
  }

  _runLocalWorker (tasks, workerIdx) {
    return new Promise((resolve) => {
      // 在子进程中执行任务
      const workerScript = path.join(__dirname, 'DistributedWorker.js');
      const child = spawn('node', [workerScript], {
        env: { ...process.env, WORKER_ID: `local_${workerIdx}`, TASKS: JSON.stringify(tasks) },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let output = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
      });
      child.stderr.on('data', (data) => {
        logger.warn(`[DistributedExecutor] Worker ${workerIdx} stderr: ${data.toString().trim()}`);
      });

      child.on('close', () => {
        try {
          const results = safeJsonParse(output, []);
          resolve(results);
        } catch (_) {
          resolve([]);
        }
      });

      child.on('error', () => resolve([]));
    });
  }

  _chunk (arr, n) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += n) {
      chunks.push(arr.slice(i, i + n));
    }
    return chunks;
  }

  _startHealthCheck () {
    setInterval(() => {
      const now = Date.now();
      for (const [id, worker] of this.workers) {
        if (now - worker.lastHeartbeat > this.heartbeatInterval * 3) {
          logger.warn(`[DistributedExecutor] Worker 失联: ${id}`);
          worker.status = 'disconnected';
          // 重新排队任务
          if (worker.currentTask) {
            const task = this.taskQueue.find(t => t.id === worker.currentTask) || { id: worker.currentTask };
            this.taskQueue.push(task);
            worker.currentTask = null;
          }
          this.emit('worker:disconnected', { workerId: id });
        }
      }
    }, this.heartbeatInterval);
  }

  /**
   * 获取集群状态
   */
  getClusterStatus () {
    return {
      mode: this.mode,
      workers: Array.from(this.workers.values()).map(w => ({
        id: w.id,
        status: w.status,
        tasksCompleted: w.tasksCompleted,
        currentTask: w.currentTask,
        lastHeartbeat: w.lastHeartbeat
      })),
      taskQueue: this.taskQueue.length,
      completedTasks: this.completedTasks.size,
      uptime: process.uptime()
    };
  }

  /**
   * 停止 Master
   */
  stopMaster () {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // ═══════════════════════════════════════════
  // Worker 模式
  // ═══════════════════════════════════════════

  /**
   * 作为 Worker 注册到 Master
   */
  async registerAsWorker (masterUrl) {
    this.isWorker = true;
    this.masterUrl = masterUrl;

    return this._post('/register', {
      workerId: this.workerId,
      host: require('os').hostname(),
      port: 0,
      capabilities: { maxConcurrent: 1 }
    });
  }

  /**
   * Worker 主循环：拉取任务 → 执行 → 提交结果
   */
  async workerLoop (taskExecutor) {
    this._heartbeatTimer = setInterval(() => {
      this._post('/heartbeat', {
        workerId: this.workerId,
        status: 'idle',
        currentTask: null
      }).catch(() => {});
    }, this.heartbeatInterval);

    while (this.isWorker) {
      try {
        const response = await this._post('/request-task', { workerId: this.workerId });
        if (!response.task) {
          await this._sleep(3000);
          continue;
        }

        // 执行任务
        const result = await taskExecutor(response.task);

        // 提交结果
        await this._post('/submit-result', {
          taskId: response.task.id,
          workerId: this.workerId,
          result
        });
      } catch (e) {
        logger.error(`[DistributedExecutor] Worker 循环错误: ${e.message}`);
        await this._sleep(5000);
      }
    }
  }

  stopWorker () {
    this.isWorker = false;
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
  }

  _post (pathname, data) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(data);
      const url = new URL(pathname, this.masterUrl);

      const req = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 10000
      }, (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          try {
            resolve(safeJsonParse(body, {}));
          } catch (_) {
            resolve({});
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(); reject(new Error('Request timeout'));
      });
      req.write(postData);
      req.end();
    });
  }

  _sleep (ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = DistributedExecutor;
