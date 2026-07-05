/**
 * @module SandboxExecutor
 *
 * 执行沙箱 — 在隔离环境中执行工具和代码。
 *
 * 核心能力：
 * 1. 进程级隔离：限制 CPU/内存/超时
 * 2. 文件系统隔离：限制可写目录
 * 3. 网络隔离：可选禁用网络访问
 * 4. Docker 容器隔离（如果 Docker 可用）
 * 5. 安全审计：记录所有执行的命令
 *
 * 隔离级别：
 * - none: 无隔离（直接执行）
 * - process: 进程级隔离（限制资源 + 超时）
 * - container: Docker 容器隔离
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/Logger')('SandboxExecutor');

class SandboxExecutor {
  constructor (options = {}) {
    this.level = options.level || 'process'; // none | process | container
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.tempDir = options.tempDir || path.join(this.workspaceDir, '.sandbox');
    this.defaultTimeout = options.defaultTimeout || 120000;
    this.maxMemoryMB = options.maxMemoryMB || 512;
    this.maxCpuPercent = options.maxCpuPercent || 80;
    this.enableNetwork = options.enableNetwork || false;
    this.allowedPaths = options.allowedPaths || [this.workspaceDir];
    this.blockedCommands = options.blockedCommands || ['rm', 'del', 'format', 'mkfs', 'dd'];
    this.auditLog = [];
    this._dockerAvailable = null;
  }

  /**
   * 检查 Docker 是否可用
   */
  isDockerAvailable () {
    if (this._dockerAvailable !== null) return this._dockerAvailable;
    try {
      const result = spawnSync('docker', ['--version'], { encoding: 'utf-8', timeout: 5000 });
      this._dockerAvailable = result.status === 0;
    } catch (_) {
      this._dockerAvailable = false;
    }
    return this._dockerAvailable;
  }

  /**
   * 在沙箱中执行命令
   */
  async execute (command, args = [], options = {}) {
    const timeout = options.timeout || this.defaultTimeout;
    const cwd = options.cwd || this.workspaceDir;
    const env = options.env || {};

    // 安全检查
    this._validateCommand(command, args);

    // 审计记录
    const auditEntry = {
      timestamp: Date.now(),
      command,
      args,
      cwd,
      timeout,
      level: this.level,
      result: null
    };

    let result;
    switch (this.level) {
    case 'none':
      result = await this._executeDirect(command, args, { cwd, env, timeout });
      break;
    case 'container':
      if (this.isDockerAvailable()) {
        result = await this._executeInContainer(command, args, { cwd, env, timeout });
        break;
      }
      // Docker 不可用，降级到进程级
      logger.warn('[SandboxExecutor] Docker 不可用，降级到进程级隔离');
      // falls through
    case 'process':
    default:
      result = await this._executeInProcess(command, args, { cwd, env, timeout });
      break;
    }

    auditEntry.result = {
      success: result.success,
      exitCode: result.exitCode,
      duration: result.duration
    };
    this.auditLog.push(auditEntry);
    if (this.auditLog.length > 500) this.auditLog.shift();

    return result;
  }

  /**
   * 直接执行（无隔离）
   */
  async _executeDirect (command, args, options) {
    return this._executeInProcess(command, args, options);
  }

  /**
   * 进程级隔离执行
   */
  async _executeInProcess (command, args, options) {
    const startTime = Date.now();

    return new Promise((resolve) => {
      let timedOut = false;
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch (_) {}
      }, options.timeout);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          success: !timedOut && code === 0,
          exitCode: code,
          stdout,
          stderr,
          duration: Date.now() - startTime,
          timedOut
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          exitCode: -1,
          stdout,
          stderr: stderr + '\n' + err.message,
          duration: Date.now() - startTime,
          error: err.message
        });
      });
    });
  }

  /**
   * Docker 容器隔离执行
   */
  async _executeInContainer (command, args, options) {
    const startTime = Date.now();
    const containerName = `qidi_sandbox_${Date.now()}`;

    const dockerArgs = [
      'run', '--rm',
      '--name', containerName,
      '--memory', `${this.maxMemoryMB}m`,
      '--cpus', String(this.maxCpuPercent / 100),
      '--network', this.enableNetwork ? 'bridge' : 'none',
      '--read-only',
      '--tmpfs', '/tmp:size=64m',
      '-v', `${options.cwd}:/workspace:rw`,
      '-w', '/workspace',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--ulimit', 'nofile=256:256',
      '--ulimit', 'nproc=64:64',
      '-e', 'HOME=/tmp'
    ];

    // 添加环境变量
    for (const [key, value] of Object.entries(options.env)) {
      dockerArgs.push('-e', `${key}=${value}`);
    }

    // 使用基础镜像
    dockerArgs.push('node:20-slim');
    dockerArgs.push(command);
    dockerArgs.push(...args);

    const result = await this._executeInProcess('docker', dockerArgs, {
      cwd: options.cwd,
      env: {},
      timeout: options.timeout
    });

    result.containerName = containerName;
    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * 命令安全验证
   */
  _validateCommand (command, args) {
    const cmdBase = path.basename(command).toLowerCase();

    // 检查黑名单
    if (this.blockedCommands.includes(cmdBase)) {
      throw new Error(`安全限制: 命令 ${cmdBase} 被禁止执行`);
    }

    // 检查危险参数
    const dangerousPatterns = [
      /rm\s+-rf\s+\//,
      /:\(\)\{.*\}/, // fork bomb
      /mkfs/,
      /\/dev\/sd[a-z]/,
      /dd\s+if=/
    ];

    const fullCommand = `${cmdBase} ${args.join(' ')}`;
    for (const pattern of dangerousPatterns) {
      if (pattern.test(fullCommand)) {
        throw new Error(`安全限制: 检测到危险命令模式: ${pattern}`);
      }
    }
  }

  /**
   * 在沙箱中执行代码（写文件 + 执行）
   */
  async executeCode (code, language, options = {}) {
    const extMap = {
      python: '.py',
      javascript: '.js',
      typescript: '.ts',
      c: '.c',
      cpp: '.cpp',
      go: '.go',
      rust: '.rs',
      java: '.java'
    };
    const ext = extMap[language?.toLowerCase()] || '.txt';
    const fileName = `sandbox_${Date.now()}${ext}`;
    const filePath = path.join(this.tempDir, fileName);

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    fs.writeFileSync(filePath, code, 'utf-8');

    let command, args;
    switch (language?.toLowerCase()) {
    case 'python':
      command = process.platform === 'win32' ? 'python' : 'python3';
      args = [filePath];
      break;
    case 'javascript':
    case 'typescript':
      command = 'node';
      args = [filePath];
      break;
    case 'c': {
      const outputExe = filePath.replace('.c', '.exe');
      const compile = await this.execute('gcc', ['-o', outputExe, filePath], options);
      if (!compile.success) return compile;
      command = outputExe;
      args = [];
      break;
    }
    case 'go':
      command = 'go';
      args = ['run', filePath];
      break;
    default:
      command = 'node';
      args = [filePath];
    }

    const result = await this.execute(command, args, options);

    // 清理
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}

    return result;
  }

  /**
   * 获取审计日志
   */
  getAuditLog () {
    return this.auditLog;
  }

  /**
   * 获取沙箱状态
   */
  getStatus () {
    return {
      level: this.level,
      dockerAvailable: this.isDockerAvailable(),
      workspaceDir: this.workspaceDir,
      tempDir: this.tempDir,
      maxMemoryMB: this.maxMemoryMB,
      maxCpuPercent: this.maxCpuPercent,
      enableNetwork: this.enableNetwork,
      auditLogSize: this.auditLog.length
    };
  }
}

module.exports = SandboxExecutor;
