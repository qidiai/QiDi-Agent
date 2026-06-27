const BaseToolAdapter = require('./BaseToolAdapter');
const path = require('path');
const fs = require('fs');

class OpenClawAdapter extends BaseToolAdapter {
  constructor(options = {}) {
    super({
      name: 'openclaw',
      displayName: 'OpenClaw',
      description: 'OpenClaw AI Agent - 多功能智能体',
      command: 'openclaw',
      ...options
    });
  }

  async detect() {
    this.detected = false;
    this.status = 'offline';

    try {
      const cmdPath = await this._findCommandInPath('openclaw');
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
        path.join(localAppData, 'Programs', 'OpenClaw', 'openclaw.exe'),
        path.join(localAppData, 'OpenClaw', 'openclaw.exe'),
        path.join(process.env.APPDATA || '', 'OpenClaw', 'openclaw.exe'),
        path.join('C:', 'Program Files', 'OpenClaw', 'openclaw.exe'),
        path.join('C:', 'Program Files (x86)', 'OpenClaw', 'openclaw.exe'),
        path.join(process.env.HOME || '', 'openclaw', 'bin', 'openclaw'),
        path.join('/usr', 'local', 'bin', 'openclaw'),
        path.join('E:', 'AI', 'tools', 'openclaw.cmd'),
        path.join('E:', 'AI', 'openclaw', 'openclaw.cmd')
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

  async checkVersion() {
    try {
      const result = await this._runCommand(this.command, ['--version'], { timeout: 10000 });
      if (result.success) {
        return this._parseVersion(result.stdout) || 'unknown';
      }
    } catch (e) {
    }
    return null;
  }

  async connect(options = {}) {
    if (!this.detected) {
      await this.detect();
    }
    
    if (!this.detected) {
      throw new Error('OpenClaw 未安装或未找到');
    }

    try {
      const result = await this._runCommand(this.command, ['--help'], { timeout: 10000 });
      if (result.success) {
        this.status = 'online';
        return { success: true, message: 'OpenClaw 连接成功' };
      }
      this.status = 'offline';
      return { success: false, message: 'OpenClaw 不可用' };
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
        error: 'OpenClaw 不可用',
        startTime,
        endTime: Date.now()
      });
      this.executionHistory.push(result);
      return result;
    }

    const taskId = options.taskId || `task_${Date.now()}`;
    const outputDir = options.outputDir || `./workspace/openclaw/${taskId}`;
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const taskFile = path.join(outputDir, 'task.md');
    fs.writeFileSync(taskFile, task, 'utf-8');

    const result = await this._runCommand(this.command, ['agent', '-m', task], {
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
    const outputDir = `./workspace/openclaw/${taskId}`;
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

module.exports = OpenClawAdapter;