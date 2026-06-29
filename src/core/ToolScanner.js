const fs = require('fs');
const path = require('path');
const ConfirmPrompt = require('../utils/ConfirmPrompt');
const logger = require('../utils/Logger')('ToolScanner');

class ToolScanner {
  constructor (options = {}) {
    this.options = options;
    this.adapters = [];
    this.scanResults = [];
    this.registeredTools = new Map();
    this.prompt = new ConfirmPrompt({
      silent: options.silentScan || false,
      autoConfirm: options.autoConfirm || false
    });
  }

  registerAdapter (adapter) {
    this.adapters.push(adapter);
    return this;
  }

  registerAdapters (adapters) {
    adapters.forEach(adapter => this.registerAdapter(adapter));
    return this;
  }

  async scan (options = {}) {
    const forceSilent = options.silent || this.options.silentScan;
    const forceAutoConfirm = options.autoConfirm || this.options.autoConfirm;

    this.scanResults = [];

    logger.info('正在扫描本机 AI 编程工具...');

    const scanPromises = this.adapters.map(async (adapter) => {
      const startTime = Date.now();
      try {
        const detected = await adapter.detect();
        const duration = Date.now() - startTime;

        const result = {
          ...adapter.getInfo(),
          scanTime: duration,
          scannedAt: Date.now(),
          detected,
          enabled: false // 默认不启用，等待用户确认
        };

        this.scanResults.push(result);

        if (detected) {
          logger.info(`${adapter.displayName} - ${adapter.installPath || 'PATH中找到'}`);
          if (adapter.version) {
            logger.info(`     版本: ${adapter.version} | 状态: 待启用`);
          }
        } else {
          logger.info(`${adapter.displayName} - 未找到`);
        }
      } catch (e) {
        this.scanResults.push({
          name: adapter.name,
          displayName: adapter.displayName,
          detected: false,
          status: 'error',
          error: e.message
        });
        logger.warn(`扫描失败: ${adapter.displayName}`, e.message);
        logger.error(`${adapter.displayName} - 扫描失败: ${e.message}`);
      }
    });

    await Promise.all(scanPromises);

    // 用户确认阶段
    const detectedTools = this.scanResults.filter(r => r.detected);

    if (detectedTools.length === 0) {
      logger.info('未发现任何 AI 编程工具');
      return { tools: [], enabled: [] };
    }

    // 使用 ConfirmPrompt 进行确认
    const prompt = new ConfirmPrompt({
      silent: forceSilent,
      autoConfirm: forceAutoConfirm
    });

    const confirmResult = await prompt.confirmScanResults(detectedTools);

    // 更新 enabled 状态
    const enabledTools = confirmResult.enabled;
    detectedTools.forEach(tool => {
      tool.enabled = enabledTools.some(t => t.name === tool.name);
    });

    return {
      tools: this.scanResults,
      enabled: enabledTools,
      confirmed: confirmResult.confirmed
    };
  }

  async connectAll () {
    const results = {};

    logger.info('正在连接所有已发现的工具...');

    for (const adapter of this.adapters) {
      if (adapter.detected) {
        try {
          const result = await adapter.connect();
          results[adapter.name] = {
            ...result,
            displayName: adapter.displayName
          };

          if (result.success) {
            logger.info(`${adapter.displayName} - 连接成功`);
            this.registeredTools.set(adapter.name, adapter);
          } else {
            logger.warn(`连接失败: ${adapter.displayName}`, result.message);
            logger.error(`${adapter.displayName} - 连接失败: ${result.message}`);
          }
        } catch (e) {
          results[adapter.name] = {
            success: false,
            message: e.message,
            displayName: adapter.displayName
          };
          logger.error(`${adapter.displayName} - 连接失败: ${e.message}`);
          logger.warn(`连接失败: ${adapter.displayName}`, e.message);
        }
      }
    }

    logger.info(`连接完成，共 ${Object.keys(results).length} 个工具`);
    return results;
  }

  async connect (toolName) {
    const adapter = this.adapters.find(a => a.name === toolName);

    if (!adapter) {
      throw new Error(`工具 ${toolName} 未注册`);
    }

    if (!adapter.detected) {
      await adapter.detect();
    }

    const result = await adapter.connect();

    if (result.success) {
      this.registeredTools.set(toolName, adapter);
    }

    return result;
  }

  getRegisteredTools () {
    return Array.from(this.registeredTools.entries()).map(([name, adapter]) => ({
      name,
      ...adapter.getInfo()
    }));
  }

  getAvailableTools () {
    return this.scanResults.filter(r => r.detected && r.status === 'online');
  }

  getTool (name) {
    return this.registeredTools.get(name);
  }

  async execute (task, options = {}) {
    const toolName = options.tool;
    const adapter = this.getTool(toolName);

    if (!adapter) {
      throw new Error(`工具 ${toolName} 未注册或不可用`);
    }

    return await adapter.execute(task, options);
  }

  async executeAll (task, options = {}) {
    const results = {};

    for (const [name, adapter] of this.registeredTools.entries()) {
      try {
        logger.info(`分派任务给 ${adapter.displayName}...`);
        const result = await adapter.execute(task, {
          ...options,
          taskId: `${name}_${Date.now()}`
        });
        results[name] = {
          ...result,
          displayName: adapter.displayName
        };

        if (result.success) {
          logger.info(`${adapter.displayName} - 任务完成`);
        } else {
          logger.warn(`${adapter.displayName} - 任务失败`);
        }
      } catch (e) {
        logger.error(`分发任务失败: ${adapter.displayName}`, e);
        results[name] = {
          success: false,
          message: e.message,
          displayName: adapter.displayName
        };
        logger.error(`${adapter.displayName} - 任务失败: ${e.message}`);
      }
    }

    return results;
  }

  saveResults (outputDir = './config') {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const config = {
      scannedAt: Date.now(),
      tools: this.scanResults.map(r => ({
        name: r.name,
        displayName: r.displayName,
        detected: r.detected,
        status: r.status,
        version: r.version,
        installPath: r.installPath,
        command: r.command
      })),
      registered: Array.from(this.registeredTools.keys())
    };

    const filePath = path.join(outputDir, 'tools.json');
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');

    return filePath;
  }

  loadResults (inputDir = './config') {
    const filePath = path.join(inputDir, 'tools.json');

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    for (const tool of config.tools) {
      const adapter = this.adapters.find(a => a.name === tool.name);
      if (adapter) {
        adapter.detected = tool.detected;
        adapter.status = tool.status;
        adapter.version = tool.version;
        adapter.installPath = tool.installPath;
        adapter.command = tool.command;

        if (tool.detected && tool.status === 'online') {
          this.registeredTools.set(tool.name, adapter);
        }
      }
    }

    return config;
  }

  getScanReport () {
    const available = this.scanResults.filter(r => r.detected && r.status === 'online');
    const detected = this.scanResults.filter(r => r.detected);
    const offline = this.scanResults.filter(r => r.detected && r.status !== 'online');

    let report = '';

    report += '📊 扫描报告\n';
    report += '═══════════════════════════════════════════\n';
    report += `扫描时间: ${new Date().toLocaleString()}\n`;
    report += `总工具数: ${this.scanResults.length}\n`;
    report += `已发现: ${detected.length}\n`;
    report += `可用: ${available.length}\n`;
    report += `离线: ${offline.length}\n`;
    report += '═══════════════════════════════════════════\n\n';

    for (const tool of this.scanResults) {
      const icon = tool.detected && tool.status === 'online' ? '✅' : tool.detected ? '⚠️' : '❌';
      report += `${icon} ${tool.displayName}\n`;
      if (tool.detected) {
        report += `   状态: ${tool.status}\n`;
        if (tool.version) {
          report += `   版本: ${tool.version}\n`;
        }
        if (tool.installPath) {
          report += `   路径: ${tool.installPath}\n`;
        }
      }
      report += '\n';
    }

    return report;
  }
}

module.exports = ToolScanner;
