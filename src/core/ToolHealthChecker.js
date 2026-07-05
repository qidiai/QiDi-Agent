const EventEmitter = require('events');
const logger = require('../utils/Logger')('ToolHealthChecker');

class ToolHealthChecker extends EventEmitter {
  constructor (options = {}) {
    super();
    this.interval = options.interval || 60000;
    this.timeout = options.timeout || 10000;
    this.enabled = options.enabled !== false;
    this.adapters = [];
    this.healthHistory = new Map();
    this.timer = null;
    this.status = 'idle';
  }

  registerAdapters (adapters) {
    this.adapters = adapters;
    adapters.forEach(adapter => {
      this.healthHistory.set(adapter.name, {
        status: 'unknown',
        lastCheck: null,
        responseTime: null,
        error: null,
        history: []
      });
    });
    return this;
  }

  async check (adapter) {
    const startTime = Date.now();
    const result = {
      name: adapter.name,
      displayName: adapter.displayName,
      status: 'checking',
      responseTime: null,
      error: null,
      timestamp: new Date().toISOString()
    };

    try {
      if (adapter.headlessSupported !== false) {
        const checkResult = await Promise.race([
          this._performCheck(adapter),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), this.timeout))
        ]);

        result.status = checkResult.success ? 'healthy' : 'unhealthy';
        result.error = checkResult.error || null;
      } else {
        result.status = 'healthy';
        result.message = 'GUI工具跳过检查';
      }
    } catch (error) {
      result.status = 'unhealthy';
      result.error = error.message;
    }

    result.responseTime = Date.now() - startTime;

    const history = this.healthHistory.get(adapter.name) || {};
    history.status = result.status;
    history.lastCheck = result.timestamp;
    history.responseTime = result.responseTime;
    history.error = result.error;
    history.history = history.history || [];
    history.history.push({
      status: result.status,
      responseTime: result.responseTime,
      timestamp: result.timestamp
    });
    if (history.history.length > 20) {
      history.history.shift();
    }
    this.healthHistory.set(adapter.name, history);

    this.emit('healthCheck', result);

    if (result.status === 'unhealthy') {
      this.emit('toolUnhealthy', result);
    }

    return result;
  }

  async _performCheck (adapter) {
    try {
      if (typeof adapter.isAvailable === 'function' && !adapter.isAvailable()) {
        return { success: false, error: '工具未检测到' };
      }

      if (typeof adapter.checkVersion === 'function') {
        const version = await adapter.checkVersion();
        if (version) {
          return { success: true, version };
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async checkAll () {
    this.status = 'checking';
    this.emit('checking');

    const results = await Promise.all(
      this.adapters.map(adapter => this.check(adapter))
    );

    this.status = 'idle';
    this.emit('checkComplete', results);

    return results;
  }

  start () {
    if (!this.enabled || this.timer) return;

    logger.info('工具健康检查器已启动');

    this.checkAll().catch(error => {
      logger.error('健康检查失败', error.message);
    });

    this.timer = setInterval(() => {
      this.checkAll().catch(error => {
        logger.error('定时健康检查失败', error.message);
      });
    }, this.interval);

    this.status = 'running';
    return this;
  }

  stop () {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.status = 'idle';
    logger.info('工具健康检查器已停止');
    return this;
  }

  getStatus () {
    const status = {};
    this.healthHistory.forEach((value, key) => {
      status[key] = {
        status: value.status,
        lastCheck: value.lastCheck,
        responseTime: value.responseTime,
        error: value.error
      };
    });
    return status;
  }

  getHealthReport () {
    const report = {
      status: this.status,
      timestamp: new Date().toISOString(),
      tools: [],
      summary: {
        total: this.adapters.length,
        healthy: 0,
        unhealthy: 0,
        unknown: 0
      }
    };

    this.healthHistory.forEach((value, key) => {
      const adapter = this.adapters.find(a => a.name === key);
      const entry = {
        name: key,
        displayName: adapter ? adapter.displayName : key,
        status: value.status,
        lastCheck: value.lastCheck,
        responseTime: value.responseTime,
        error: value.error,
        history: value.history || []
      };
      report.tools.push(entry);

      if (value.status === 'healthy') report.summary.healthy++;
      else if (value.status === 'unhealthy') report.summary.unhealthy++;
      else report.summary.unknown++;
    });

    return report;
  }

  getUnhealthyTools () {
    const unhealthy = [];
    this.healthHistory.forEach((value, key) => {
      if (value.status === 'unhealthy') {
        const adapter = this.adapters.find(a => a.name === key);
        unhealthy.push({
          name: key,
          displayName: adapter ? adapter.displayName : key,
          error: value.error,
          lastCheck: value.lastCheck
        });
      }
    });
    return unhealthy;
  }

  isHealthy (toolName) {
    const history = this.healthHistory.get(toolName);
    return history && history.status === 'healthy';
  }
}

module.exports = ToolHealthChecker;
