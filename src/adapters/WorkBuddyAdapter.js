const BaseToolAdapter = require('./BaseToolAdapter');
const path = require('path');
const fs = require('fs');

class WorkBuddyAdapter extends BaseToolAdapter {
  constructor (options = {}) {
    super({
      name: 'workbuddy',
      displayName: 'WorkBuddy',
      description: 'WorkBuddy AI Agent - 智能编程助手',
      command: 'workbuddy',
      ...options
    });
  }

  async detect () {
    this.detected = false;
    this.status = 'offline';

    try {
      const cmdPath = await this._findCommandInPath('workbuddy');
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
        path.join(localAppData, 'Programs', 'WorkBuddy', 'workbuddy.exe'),
        path.join(localAppData, 'WorkBuddy', 'workbuddy.exe'),
        path.join(process.env.APPDATA || '', 'WorkBuddy', 'workbuddy.exe'),
        path.join('C:', 'Program Files', 'WorkBuddy', 'workbuddy.exe'),
        path.join('C:', 'Program Files (x86)', 'WorkBuddy', 'workbuddy.exe'),
        path.join(process.env.HOME || '', 'workbuddy', 'bin', 'workbuddy'),
        path.join('/usr', 'local', 'bin', 'workbuddy')
      ];

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          this.installPath = p;
          this.command = p;
          this.detected = true;

          const versionResult = await this.checkVersion();
          if (versionResult) {
            this.version = versionResult;
          }
          this.status = 'online';
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

    try {
      if (process.platform === 'win32') {
        const result = this._getFileVersion(this.installPath);
        if (result) return result;
      }
    } catch (e) {
    }

    return null;
  }

  _getFileVersion (filePath) {
    try {
      const { spawnSync } = require('child_process');
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-Item '${filePath.replace(/'/g, '\'\'')}').VersionInfo.ProductVersion`],
        { timeout: 5000, encoding: 'utf-8', windowsHide: true }
      );
      if (result.status === 0 && result.stdout) {
        const version = result.stdout.trim();
        if (version) return version;
      }
    } catch (e) {}
    return null;
  }

  async connect (_options = {}) {
    if (!this.detected) {
      await this.detect();
    }

    if (!this.detected) {
      throw new Error('WorkBuddy 未安装或未找到');
    }

    try {
      const result = await this._runCommand(this.command, ['--help'], { timeout: 10000 });
      if (result.success) {
        this.status = 'online';
        return { success: true, message: 'WorkBuddy 连接成功' };
      }
      this.status = 'offline';
      return { success: false, message: 'WorkBuddy 不可用' };
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
        error: 'WorkBuddy 不可用',
        startTime,
        endTime: Date.now()
      });
      this.executionHistory.push(result);
      return result;
    }

    const taskId = options.taskId || `task_${Date.now()}`;
    const outputDir = options.outputDir || `./workspace/workbuddy/${taskId}`;

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const taskFile = path.join(outputDir, 'task.md');
    fs.writeFileSync(taskFile, task, 'utf-8');

    const result = await this._runCommand(this.command, ['run', '-t', task], {
      timeout: options.timeout || 300000,
      cwd: outputDir,
      windowsHide: true
    });

    let outputContent = result.stdout || '';
    let codeBlocks = this._extractCodeBlocks(outputContent);

    const outputFile = path.join(outputDir, 'output.md');
    if (fs.existsSync(outputFile)) {
      outputContent = fs.readFileSync(outputFile, 'utf-8');
      codeBlocks = this._extractCodeBlocks(outputContent);
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
            size: stat.size
          });
        }
      }
    } catch (e) {
    }

    const endTime = Date.now();

    return this._normalizeResult({
      taskId,
      tool: 'workbuddy',
      success: result.success,
      exitCode: result.code,
      startTime,
      endTime,
      duration: endTime - startTime,
      content: outputContent,
      rawOutput: result.stdout || '',
      stderr: result.stderr || '',
      error: result.success ? null : result.stderr || '执行失败',
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
  }

  isAvailable () {
    return this.detected && this.status === 'online';
  }

  getInfo () {
    return {
      name: this.name,
      displayName: this.displayName,
      description: this.description,
      version: this.version || 'unknown',
      status: this.status,
      installPath: this.installPath,
      detected: this.detected
    };
  }
}

module.exports = WorkBuddyAdapter;
