const BaseToolAdapter = require('./BaseToolAdapter');
const path = require('path');
const fs = require('fs');

class HermesAgentAdapter extends BaseToolAdapter {
  constructor (options = {}) {
    super({
      name: 'hermes-agent',
      displayName: 'Hermes Agent',
      description: 'Hermes Agent - AI 编程代理',
      command: 'hermes',
      ...options
    });
  }

  async detect () {
    this.detected = false;
    this.status = 'offline';

    try {
      const cmdPath = await this._findCommandInPath('hermes');
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
      const appData = process.env.APPDATA || '';
      const possiblePaths = [
        path.join(localAppData, 'Programs', 'Hermes Agent', 'hermes.exe'),
        path.join(localAppData, 'Hermes Agent', 'hermes.exe'),
        path.join(appData, 'Hermes Agent', 'hermes.exe'),
        path.join('C:', 'Program Files', 'Hermes Agent', 'hermes.exe'),
        path.join('C:', 'Program Files (x86)', 'Hermes Agent', 'hermes.exe'),
        path.join(localAppData, 'Programs', 'Hermes', 'hermes.exe'),
        path.join(localAppData, 'Hermes', 'hermes.exe')
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

      const registryResult = await this._checkWindowsRegistry(
        'HKCU\\Software\\Hermes'
      );
      if (registryResult) {
        const installPathMatch = registryResult.match(/InstallPath\s+REG_SZ\s+(.+)/);
        if (installPathMatch) {
          const exePath = path.join(installPathMatch[1].trim(), 'hermes.exe');
          if (fs.existsSync(exePath)) {
            this.installPath = exePath;
            this.command = exePath;
            this.detected = true;
            this.status = 'online';
            return true;
          }
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
      throw new Error('Hermes Agent 未安装或未找到');
    }

    try {
      const result = await this._runCommand(this.command, ['--help'], { timeout: 10000 });
      if (result.success) {
        this.status = 'online';
        return { success: true, message: 'Hermes Agent 连接成功' };
      }
      this.status = 'offline';
      return { success: false, message: 'Hermes Agent 不可用' };
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
        error: 'Hermes Agent 不可用',
        startTime,
        endTime: Date.now()
      });
      this.executionHistory.push(result);
      return result;
    }

    const taskId = options.taskId || `task_${Date.now()}`;
    const outputDir = options.outputDir || `./workspace/hermes-agent/${taskId}`;

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
    const outputDir = `./workspace/hermes-agent/${taskId}`;
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

module.exports = HermesAgentAdapter;
