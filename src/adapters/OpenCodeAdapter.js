const BaseToolAdapter = require('./BaseToolAdapter');
const path = require('path');
const fs = require('fs');

class OpenCodeAdapter extends BaseToolAdapter {
  constructor (options = {}) {
    super({
      name: 'open-code',
      displayName: 'Open Code',
      description: 'Open Code AI - 开源代码助手',
      command: 'opencode',
      ...options
    });
  }

  async detect () {
    this.detected = false;
    this.status = 'offline';

    try {
      const cmdPath = await this._findCommandInPath('opencode');
      if (cmdPath) {
        this.installPath = cmdPath;
        this.detected = true;

        const versionResult = await this.checkVersion();
        if (versionResult) {
          this.version = versionResult;
          this.status = 'online';
        }
        return true;
      }

      const localAppData = process.env.LOCALAPPDATA || '';
      const possiblePaths = [
        path.join(localAppData, 'Programs', 'Open Code', 'opencode.exe'),
        path.join(localAppData, 'Open Code', 'opencode.exe'),
        path.join(process.env.APPDATA || '', 'Open Code', 'opencode.exe'),
        path.join('C:', 'Program Files', 'Open Code', 'opencode.exe'),
        path.join('C:', 'Program Files (x86)', 'Open Code', 'opencode.exe'),
        path.join(process.env.HOME || '', '.opencode', 'bin', 'opencode'),
        path.join('/usr', 'local', 'bin', 'opencode')
      ];

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          this.installPath = p;
          this.command = p;
          this.detected = true;

          const versionResult = await this.checkVersion();
          if (versionResult) {
            this.version = versionResult;
            this.status = 'online';
          }
          return true;
        }
      }
    } catch (e) {
    }

    return false;
  }

  async checkVersion () {
    try {
      const result = await this._runCommand(this.command, ['--version'], { timeout: 10000 });
      if (result.success) {
        return this._parseVersion(result.stdout) || 'unknown';
      }
    } catch (e) {
    }
    return null;
  }

  async connect (options = {}) {
    if (!this.detected) {
      await this.detect();
    }

    if (!this.detected) {
      throw new Error('Open Code 未安装或未找到');
    }

    try {
      const result = await this._runCommand(this.command, ['--help'], { timeout: 10000 });
      if (result.success) {
        this.status = 'online';
        return { success: true, message: 'Open Code 连接成功' };
      }
      this.status = 'offline';
      return { success: false, message: 'Open Code 不可用' };
    } catch (e) {
      this.status = 'error';
      return { success: false, message: e.message };
    }
  }

  async execute (task, options = {}) {
    const startTime = Date.now();

    if (!this.isAvailable()) {
      const result = this._normalizeResult({
        taskId: options.taskId || `task_${Date.now()}`,
        success: false,
        error: 'Open Code 不可用',
        startTime,
        endTime: Date.now()
      });
      this.executionHistory.push(result);
      return result;
    }

    const taskId = options.taskId || `task_${Date.now()}`;
    const outputDir = options.outputDir || `./workspace/open-code/${taskId}`;

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const taskFile = path.join(outputDir, 'task.md');
    fs.writeFileSync(taskFile, task, 'utf-8');

    const outputFile = path.join(outputDir, 'output.md');

    const args = [
      'run',
      '--task', task,
      '--output', outputFile,
      '--workspace', outputDir
    ];

    if (options.model) {
      args.push('--model', options.model);
    }

    const result = await this._runCommand(this.command, args, {
      timeout: options.timeout || 300000,
      cwd: outputDir
    });

    let outputContent = '';
    let codeBlocks = [];

    if (fs.existsSync(outputFile)) {
      outputContent = fs.readFileSync(outputFile, 'utf-8');
      codeBlocks = this._extractCodeBlocks(outputContent);
    } else if (result.stdout) {
      outputContent = result.stdout;
      codeBlocks = this._extractCodeBlocks(result.stdout);
    }

    const generatedFiles = [];
    try {
      const files = fs.readdirSync(outputDir);
      for (const f of files) {
        const filePath = path.join(outputDir, f);
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          generatedFiles.push({
            path: f,
            content: fs.readFileSync(filePath, 'utf-8'),
            size: stat.size,
            mtime: stat.mtime.getTime()
          });
        }
      }
    } catch (e) {}

    const unifiedResult = this._normalizeResult({
      taskId,
      tool: this.name,
      success: result.success,
      exitCode: result.code,
      startTime,
      endTime: Date.now(),
      content: outputContent,
      rawOutput: result.stdout,
      stderr: result.stderr,
      error: null,
      outputDir,
      outputFile: fs.existsSync(outputFile) ? outputFile : null,
      generatedFiles,
      codeBlocks,
      metadata: {
        version: this.version || 'unknown',
        command: this.command || '',
        options: { ...options }
      }
    });

    this.executionHistory.push(unifiedResult);
    return unifiedResult;
  }

  async collectOutput (taskId) {
    const outputDir = `./workspace/open-code/${taskId}`;
    const outputFile = path.join(outputDir, 'output.md');

    if (fs.existsSync(outputFile)) {
      const content = fs.readFileSync(outputFile, 'utf-8');
      return {
        content,
        codeBlocks: this._extractCodeBlocks(content),
        files: fs.readdirSync(outputDir).map(f => path.join(outputDir, f))
      };
    }

    return null;
  }
}

module.exports = OpenCodeAdapter;
