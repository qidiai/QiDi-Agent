const BaseToolAdapter = require('./BaseToolAdapter');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

class TraeAdapter extends BaseToolAdapter {
  constructor(options = {}) {
    super({
      name: 'trae',
      displayName: 'Trae CN',
      description: 'Trae CN (字节跳动) - AI 编程助手（VS Code 架构）',
      command: '',
      ...options
    });
    this.execPath = null;
  }

  async detect() {
    this.detected = false;
    this.status = 'offline';

    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const possiblePaths = [
      path.join(localAppData, 'Programs', 'Trae CN', 'bin', 'trae-cn.cmd'),
      path.join(localAppData, 'Programs', 'Trae CN', 'Trae CN.exe'),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        this.execPath = p;
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
    return false;
  }

  async checkVersion() {
    try {
      // 使用 spawnSync 避免卡死：trae-cn.cmd --version 可能启动 GUI 进程
      // spawnSync 有硬性超时保证，不会出现 Promise 永不 resolve 的情况
      const result = spawnSync(this.execPath, ['--version'], {
        timeout: 8000,
        encoding: 'utf-8',
        shell: this.execPath.endsWith('.cmd') || process.platform === 'win32',
        windowsHide: true
      });
      if (result.status === 0 && result.stdout) {
        const v = result.stdout.match(/[\d.]+/);
        return v ? v[0] : 'unknown';
      }
    } catch (e) {}
    return null;
  }

  async connect(options = {}) {
    if (!this.detected) await this.detect();
    if (!this.detected) throw new Error('Trae CN 未安装');

    try {
      // 使用 spawnSync 避免卡死：trae-cn.cmd 可能启动 GUI 进程
      const result = spawnSync(this.execPath, ['--version'], {
        timeout: 10000,
        encoding: 'utf-8',
        shell: this.execPath.endsWith('.cmd') || process.platform === 'win32',
        windowsHide: true
      });
      if (result.status === 0) {
        this.status = 'online';
        return { success: true, message: 'Trae CN 连接成功' };
      }
      this.status = 'offline';
      return { success: false, message: 'Trae CN 不可用' };
    } catch (e) {
      this.status = 'error';
      return { success: false, message: e.message };
    }
  }

  async execute(task, options = {}) {
    const startTime = Date.now();
    
    if (!this.isAvailable()) {
      const result = this._normalizeResult({
        taskId: options.taskId || `task_${Date.now()}`,
        success: false,
        error: 'Trae CN 不可用',
        startTime,
        endTime: Date.now()
      });
      this.executionHistory.push(result);
      return result;
    }

    const taskId = options.taskId || `task_${Date.now()}`;
    const outputDir = options.outputDir || `./workspace/trae/${taskId}`;
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const taskFile = path.join(outputDir, 'prompt.txt');
    fs.writeFileSync(taskFile, task, 'utf-8');

    let result;
    let outputContent = '';
    let codeBlocks = [];
    let generatedFiles = [];

    try {
      result = await this._runCommand(this.execPath, [
        '--wait', 'chat', '-m', 'agent', '--', task
      ], {
        timeout: options.timeout || 300000,
        cwd: outputDir
      });

      outputContent = result.stdout || '';
      codeBlocks = this._extractCodeBlocks(outputContent);
    } catch (e) {
      result = { success: false, stdout: '', stderr: e.message, code: -1 };
    }

    try {
      const files = fs.readdirSync(outputDir);
      for (const f of files) {
        if (f !== 'prompt.txt' && f !== 'task.md') {
          const filePath = path.join(outputDir, f);
          const stat = fs.statSync(filePath);
          if (stat.isFile()) {
            const content = fs.readFileSync(filePath, 'utf-8');
            const ext = path.extname(f).slice(1);
            generatedFiles.push({
              path: f,
              content,
              size: stat.size,
              mtime: stat.mtime.getTime()
            });
            codeBlocks.push({ language: ext || 'text', code: content, filePath: f });
          }
        }
      }
    } catch (e) {}

    const isSuccess = outputContent || generatedFiles.length > 0;

    const unifiedResult = this._normalizeResult({
      taskId,
      tool: this.name,
      success: isSuccess,
      exitCode: isSuccess ? (result?.code || 0) : -1,
      startTime,
      endTime: Date.now(),
      content: outputContent,
      rawOutput: result?.stdout || '',
      stderr: isSuccess ? (result?.stderr || '') : 'Trae CN 未返回有效输出（可能需要在界面中确认）',
      error: isSuccess ? null : '未返回有效输出',
      outputDir,
      outputFile: null,
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

}

module.exports = TraeAdapter;
