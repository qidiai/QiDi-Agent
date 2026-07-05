const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const Logger = require('../utils/Logger').Logger;
const logger = new Logger({ name: 'BaseToolAdapter' });

// NativeAPI 组件 — 所有适配器共享
let _nativeAPI;
try {
  _nativeAPI = require('../utils/NativeAPIAdapter');
} catch (_) {
  _nativeAPI = null;
}

/**
 * 安全：路径转义函数
 * 所有命令统一使用 shell: false 执行，路径参数仍需转义以防特殊字符问题
 */
function escapeShellArg (arg) {
  if (process.platform === 'win32') {
    // Windows: 用双引号包裹并转义内部的双引号
    return `"${String(arg).replace(/"/g, '\\"')}"`;
  } else {
    // Unix: 用单引号包裹并转义内部的单引号
    return `'${String(arg).replace(/'/g, '\'\\\'\'')}'`;
  }
}

class BaseToolAdapter {
  constructor (options = {}) {
    this.options = options;
    this.name = options.name || 'unknown';
    this.displayName = options.displayName || 'Unknown Tool';
    this.description = options.description || '';
    this.command = options.command || '';
    this.installPath = null;
    this.detected = false;
    this.version = null;
    this.status = 'unknown';
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.executionHistory = [];

    this.circuitBreaker = {
      consecutiveFailures: 0,
      maxFailures: 5,
      cooldownPeriod: 60000,
      lastFailureTime: 0,
      state: 'closed'
    };

    this.retryPolicy = {
      maxRetries: options.maxRetries || 2,
      initialDelay: options.initialDelay || 1000,
      backoffFactor: options.backoffFactor || 2
    };

    // NativeAPI 组件（所有适配器自动启用）
    this.enableNativeAPI = options.enableNativeAPI !== false && _nativeAPI;
    this._structuredParser = this.enableNativeAPI ? _nativeAPI.StructuredOutputParser : null;
    this._contextInjector = this.enableNativeAPI ? new _nativeAPI.ContextInjector() : null;
    this._incrementalCollector = this.enableNativeAPI ? new _nativeAPI.IncrementalCollector() : null;
    this._capabilityProbe = this.enableNativeAPI ? _nativeAPI.CapabilityProbe : null;
  }

  async detect () {
    throw new Error('detect() must be implemented');
  }

  async connect (options = {}) {
    throw new Error('connect() must be implemented');
  }

  async execute (task, options = {}) {
    const startTime = Date.now();
    const taskId = options.taskId || `task_${Date.now()}`;
    const workspaceDir = options.workspaceDir || this.workspaceDir;

    const startFiles = this._scanWorkspace(workspaceDir);

    const result = {
      taskId,
      tool: this.name,
      success: false,
      exitCode: -1,
      startTime,
      endTime: null,
      duration: null,
      content: '',
      rawOutput: '',
      stderr: '',
      error: null,
      outputDir: workspaceDir,
      outputFile: null,
      generatedFiles: [],
      codeBlocks: [],
      metadata: {
        version: this.version || 'unknown',
        command: this.command || '',
        options: { ...options },
        retries: 0
      },
      logs: [],
      circuitBreakerState: this.circuitBreaker.state
    };

    try {
      this._log(result, `开始执行任务: ${task.substring(0, 50)}...`);

      if (!this.isAvailable()) {
        if (this.circuitBreaker.state === 'open') {
          throw new Error(`${this.displayName} 已触发熔断，请稍后重试`);
        }
        throw new Error(`${this.displayName} 不可用，请先连接`);
      }

      const cmdResult = await this._executeWithRetry(
        () => this._runToolCommand(task, options),
        { maxRetries: options.maxRetries }
      );

      this._recordSuccess();

      result.rawOutput = cmdResult.stdout || '';
      result.stderr = cmdResult.stderr || '';
      result.exitCode = cmdResult.code;
      result.success = cmdResult.success;
      result.content = cmdResult.content || cmdResult.stdout || '';

      // 使用 NativeAPI StructuredOutputParser 解析输出
      if (this.enableNativeAPI && this._structuredParser && result.content) {
        const parsed = this._structuredParser.parse(result.content);
        if (parsed.codeBlocks && parsed.codeBlocks.length > 0 && !cmdResult.codeBlocks) {
          result.codeBlocks = parsed.codeBlocks.map(b => ({
            filePath: b.filePath || `block_${Date.now()}`,
            language: b.language || 'text',
            code: b.code || ''
          }));
        }
        if (parsed.fileChanges && parsed.fileChanges.length > 0 && !cmdResult.generatedFiles) {
          result.generatedFiles = parsed.fileChanges.map(f => ({
            path: f.path || f.file || 'unknown',
            size: f.size || 0,
            status: f.status || 'modified'
          }));
        }
        if (parsed.errors && parsed.errors.length > 0) {
          result.metadata.parsedErrors = parsed.errors;
        }
      }

      if (cmdResult.codeBlocks) {
        result.codeBlocks = cmdResult.codeBlocks;
      }

      if (cmdResult.generatedFiles) {
        result.generatedFiles = cmdResult.generatedFiles;
      }

      if (cmdResult.outputFile) {
        result.outputFile = cmdResult.outputFile;
      }

      if (!cmdResult.success) {
        this._recordFailure();
        this._log(result, `命令执行失败 (exit code: ${cmdResult.code})`);
        if (cmdResult.stderr) {
          this._log(result, `错误信息: ${cmdResult.stderr.substring(0, 200)}`);
        }
      } else {
        this._log(result, '命令执行成功');
      }
    } catch (e) {
      this._recordFailure();
      result.error = e.message;
      result.success = false;
      this._log(result, `执行异常: ${e.message}`);
    }

    result.endTime = Date.now();
    result.duration = result.endTime - startTime;

    if (result.generatedFiles.length === 0) {
      // 使用 IncrementalCollector 增量采集
      if (this.enableNativeAPI && this._incrementalCollector) {
        try {
          const changes = this._incrementalCollector.collectChanges(workspaceDir);
          result.generatedFiles = this._incrementalCollector.readChanges(workspaceDir, changes);
        } catch (e) {
          const endFiles = this._scanWorkspace(workspaceDir);
          result.generatedFiles = this._diffFiles(startFiles, endFiles);
        }
      } else {
        const endFiles = this._scanWorkspace(workspaceDir);
        result.generatedFiles = this._diffFiles(startFiles, endFiles);
      }
    }

    this._log(result, `生成文件数: ${result.generatedFiles.length}`);
    for (const f of result.generatedFiles) {
      this._log(result, `  - ${f.path} (${f.size} bytes)`);
    }

    this.executionHistory.push(result);
    return result;
  }

  _normalizeResult (result) {
    const defaultResult = {
      taskId: result.taskId || `task_${Date.now()}`,
      tool: result.tool || this.name,
      success: result.success || false,
      exitCode: result.exitCode || -1,
      startTime: result.startTime || Date.now(),
      endTime: result.endTime || Date.now(),
      duration: result.duration || 0,
      content: result.content || result.stdout || result.rawOutput || '',
      rawOutput: result.rawOutput || result.stdout || '',
      stderr: result.stderr || '',
      error: result.error || null,
      outputDir: result.outputDir || this.workspaceDir,
      outputFile: result.outputFile || null,
      generatedFiles: result.generatedFiles || [],
      codeBlocks: result.codeBlocks || [],
      metadata: {
        version: this.version || 'unknown',
        command: this.command || '',
        options: result.options || {}
      },
      logs: result.logs || []
    };

    defaultResult.duration = defaultResult.endTime - defaultResult.startTime;

    return defaultResult;
  }

  async _runToolCommand (task, options) {
    throw new Error('_runToolCommand() must be implemented');
  }

  async collectOutput (taskId) {
    const history = this.executionHistory.find(h => h.taskId === taskId);
    if (!history) return null;

    const output = {
      taskId: history.taskId,
      tool: history.tool,
      success: history.success,
      stdout: history.stdout,
      stderr: history.stderr,
      generatedFiles: []
    };

    for (const fileInfo of history.generatedFiles) {
      const filePath = path.join(this.workspaceDir, fileInfo.path);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        output.generatedFiles.push({
          ...fileInfo,
          content
        });
      } catch (e) {
        output.generatedFiles.push(fileInfo);
      }
    }

    return output;
  }

  async checkVersion () {
    throw new Error('checkVersion() must be implemented');
  }

  isAvailable () {
    if (!this.detected || this.status !== 'online') {
      return false;
    }

    if (this.circuitBreaker.state === 'open') {
      const elapsed = Date.now() - this.circuitBreaker.lastFailureTime;
      if (elapsed >= this.circuitBreaker.cooldownPeriod) {
        this.circuitBreaker.state = 'half-open';
        this.circuitBreaker.consecutiveFailures = 0;
      } else {
        return false;
      }
    }

    return true;
  }

  _recordSuccess () {
    this.circuitBreaker.consecutiveFailures = 0;
    this.circuitBreaker.state = 'closed';
  }

  _recordFailure () {
    this.circuitBreaker.consecutiveFailures++;
    this.circuitBreaker.lastFailureTime = Date.now();

    if (this.circuitBreaker.consecutiveFailures >= this.circuitBreaker.maxFailures) {
      this.circuitBreaker.state = 'open';
      logger.warn(`${this.displayName} 触发熔断，冷却时间 ${this.circuitBreaker.cooldownPeriod}ms`);
    }
  }

  async _executeWithRetry (fn, options = {}) {
    const { maxRetries, initialDelay, backoffFactor } = {
      ...this.retryPolicy,
      ...options
    };

    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (attempt >= maxRetries) {
          break;
        }

        const delay = initialDelay * Math.pow(backoffFactor, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  getInfo () {
    return {
      name: this.name,
      displayName: this.displayName,
      description: this.description,
      command: this.command,
      installPath: this.installPath,
      version: this.version,
      detected: this.detected,
      status: this.status,
      executionCount: this.executionHistory.length
    };
  }

  async _runCommand (cmd, args = [], options = {}) {
    const safeArgs = args.map(arg => {
      if (typeof arg === 'string' && (arg.includes(' ') || arg.includes('"'))) {
        return escapeShellArg(arg);
      }
      return arg;
    });

    const timeout = options.timeout || 600000;
    const spawnOptions = { ...options };
    if (spawnOptions.shell !== true) {
      spawnOptions.shell = false;
    }
    delete spawnOptions.timeout;

    return new Promise((resolve) => {
      let proc;
      let timedOut = false;
      let timer = null;

      try {
        proc = spawn(cmd, safeArgs, spawnOptions);
      } catch (err) {
        resolve({
          success: false,
          stdout: '',
          stderr: err.message,
          code: -1,
          error: err.message
        });
        return;
      }

      timer = setTimeout(() => {
        timedOut = true;
        try {
          // Windows: taskkill /T 杀整个进程树（含子进程），/F 强制终止
          // 这确保 Electron 等会 spawn 子进程的 GUI 工具也能被杀掉
          if (process.platform === 'win32' && proc.pid) {
            spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
              windowsHide: true,
              timeout: 3000
            });
          } else {
            proc.kill('SIGTERM');
          }
        } catch (e) {}
        // 安全网：即使 kill 成功但 close 事件 2 秒后仍未触发，强制 resolve
        setTimeout(() => {
          resolve({
            success: false,
            stdout: stdout.trim(),
            stderr: (stderr + '\n执行超时').trim(),
            code: -1,
            error: 'timeout'
          });
        }, 2000);
      }, timeout);

      let stdout = '';
      let stderr = '';

      if (proc.stdout) {
        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });
      }

      if (proc.stderr) {
        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      }

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (timedOut) {
          resolve({
            success: false,
            stdout: stdout.trim(),
            stderr: (stderr + '\n执行超时').trim(),
            code: -1,
            error: 'timeout'
          });
        } else {
          resolve({
            success: code === 0,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            code
          });
        }
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({
          success: false,
          stdout: stdout.trim(),
          stderr: err.message,
          code: -1,
          error: err.message
        });
      });
    });
  }

  async _findCommandInPath (command) {
    const paths = process.env.PATH.split(path.delimiter);

    for (const p of paths) {
      const cmdPath = path.join(p, command);
      const cmdPathExe = `${cmdPath}.exe`;
      const cmdPathCmd = `${cmdPath}.cmd`;
      const cmdPathPs1 = `${cmdPath}.ps1`;

      try {
        if (fs.existsSync(cmdPathExe)) {
          return cmdPathExe;
        }
        if (fs.existsSync(cmdPathCmd)) {
          return cmdPathCmd;
        }
        if (fs.existsSync(cmdPathPs1)) {
          return cmdPathPs1;
        }
        if (fs.existsSync(cmdPath)) {
          return cmdPath;
        }
      } catch (e) {
      }
    }

    return null;
  }

  async _checkWindowsRegistry (keyPath) {
    try {
      const result = await this._runCommand('reg', ['query', keyPath]);
      if (result.success) {
        return result.stdout;
      }
    } catch (e) {
    }
    return null;
  }

  _parseVersion (output) {
    const versionMatch = output.match(/version\s*[:=]\s*([\d.]+)/i);
    if (versionMatch) {
      return versionMatch[1];
    }
    return null;
  }

  _scanWorkspace (dir) {
    const files = new Map();
    try {
      const items = fs.readdirSync(dir, { recursive: true });
      for (const item of items) {
        const fullPath = path.join(dir, item);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            files.set(item, {
              path: item,
              size: stat.size,
              mtime: stat.mtime.getTime()
            });
          }
        } catch (e) {}
      }
    } catch (e) {}
    return files;
  }

  _diffFiles (before, after) {
    const newFiles = [];
    for (const [key, value] of after) {
      const beforeValue = before.get(key);
      if (!beforeValue) {
        newFiles.push(value);
      } else if (value.mtime > beforeValue.mtime || value.size !== beforeValue.size) {
        newFiles.push(value);
      }
    }
    return newFiles;
  }

  _log (result, message) {
    const timestamp = new Date().toISOString();
    result.logs.push({ timestamp, message });
  }

  async runShellCommand (cmd, options = {}) {
    return this._runCommand(cmd, [], options);
  }

  async runScript (scriptContent, options = {}) {
    const tempFile = path.join(this.workspaceDir, `script_${Date.now()}.sh`);
    try {
      fs.writeFileSync(tempFile, scriptContent, 'utf-8');
      fs.chmodSync(tempFile, 0o755);

      const result = await this._runCommand(tempFile, [], options);
      return result;
    } finally {
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {}
    }
  }

  /**
   * 从文本中提取代码块（通用实现，子类可覆写）
   */
  _extractCodeBlocks (text) {
    const blocks = [];
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      blocks.push({
        language: match[1] || 'text',
        code: match[2].trim()
      });
    }
    return blocks;
  }
}

module.exports = BaseToolAdapter;
module.exports.escapeShellArg = escapeShellArg;
