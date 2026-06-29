const BaseToolAdapter = require('./BaseToolAdapter');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

class QoderAdapter extends BaseToolAdapter {
  constructor(options = {}) {
    super({
      name: 'qoder',
      displayName: 'Qoder',
      description: 'Qoder - AI 编程助手',
      command: 'qoder',
      ...options
    });
  }

  async detect() {
    this.detected = false;
    this.status = 'offline';

    try {
      const cmdPath = await this._findCommandInPath('qoder');
      if (cmdPath) {
        this.installPath = cmdPath;
        this.detected = true;
        this.version = this._getFileVersion(cmdPath);
        this.status = 'online';
        return true;
      }

      const localAppData = process.env.LOCALAPPDATA || '';
      const appData = process.env.APPDATA || '';
      const possiblePaths = [
        path.join(localAppData, 'Programs', 'Qoder', 'qoder.exe'),
        path.join(localAppData, 'Qoder', 'qoder.exe'),
        path.join(appData, 'Qoder', 'qoder.exe'),
        path.join('C:', 'Program Files', 'Qoder', 'qoder.exe'),
        path.join('C:', 'Program Files (x86)', 'Qoder', 'qoder.exe'),
        path.join(localAppData, 'Programs', 'Qoder', 'Qoder.exe'),
        path.join(localAppData, 'Qoder', 'Qoder.exe'),
        path.join('C:', 'Program Files', 'Qoder', 'Qoder.exe')
      ];

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          this.installPath = p;
          this.command = p;
          this.detected = true;
          this.version = this._getFileVersion(p);
          this.status = 'online';
          return true;
        }
      }

      const registryResult = await this._checkWindowsRegistry(
        'HKCU\\Software\\Qoder'
      );
      if (registryResult) {
        const installPathMatch = registryResult.match(/InstallPath\s+REG_SZ\s+(.+)/);
        if (installPathMatch) {
          const exePath = path.join(installPathMatch[1].trim(), 'qoder.exe');
          if (fs.existsSync(exePath)) {
            this.installPath = exePath;
            this.command = exePath;
            this.detected = true;
            this.version = this._getFileVersion(exePath);
            this.status = 'online';
            return true;
          }
        }
      }
    } catch (e) {
    }

    return false;
  }

  _getFileVersion(filePath) {
    try {
      if (process.platform === 'win32') {
        const result = spawnSync(
          'powershell.exe',
          ['-NoProfile', '-Command', `(Get-Item '${filePath.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
          { timeout: 5000, encoding: 'utf-8', windowsHide: true }
        );
        if (result.status === 0 && result.stdout) {
          const version = result.stdout.trim();
          if (version) return version;
        }
      }
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        return stat.mtime ? `installed-${stat.mtime.getTime().toString().slice(-8)}` : 'unknown';
      }
    } catch (e) {
    }
    return 'unknown';
  }

  async checkVersion() {
    if (this.installPath && fs.existsSync(this.installPath)) {
      return this._getFileVersion(this.installPath);
    }
    return null;
  }

  async connect(options = {}) {
    if (!this.detected) {
      await this.detect();
    }
    
    if (!this.detected) {
      throw new Error('Qoder 未安装或未找到');
    }

    if (this.installPath && fs.existsSync(this.installPath)) {
      this.status = 'online';
      return { success: true, message: 'Qoder 连接成功' };
    }

    this.status = 'offline';
    return { success: false, message: 'Qoder 不可用' };
  }

  async execute(task, options = {}) {
    const startTime = Date.now();
    
    if (!this.isAvailable()) {
      const result = this._normalizeResult({
        taskId: options.taskId || `task_${Date.now()}`,
        success: false,
        error: 'Qoder 不可用',
        startTime,
        endTime: Date.now()
      });
      this.executionHistory.push(result);
      return result;
    }

    const taskId = options.taskId || `task_${Date.now()}`;
    const outputDir = options.outputDir || `./workspace/qoder/${taskId}`;
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const taskFile = path.join(outputDir, 'task.md');
    fs.writeFileSync(taskFile, task, 'utf-8');

    const outputFile = path.join(outputDir, 'output.md');

    const args = [
      'chat',
      '--input', taskFile,
      '--output', outputFile
    ];

    if (options.model) {
      args.push('--model', options.model);
    }

    const result = await this._runCommand(this.command, args, {
      timeout: options.timeout || 300000,
      cwd: outputDir,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' }
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
      success: result.success || codeBlocks.length > 0,
      exitCode: result.code,
      startTime,
      endTime: Date.now(),
      content: outputContent,
      rawOutput: result.stdout,
      stderr: result.stderr,
      error: result.error || null,
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

  async collectOutput(taskId) {
    const outputDir = `./workspace/qoder/${taskId}`;
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

module.exports = QoderAdapter;