const BaseToolAdapter = require('./BaseToolAdapter');
const path = require('path');
const fs = require('fs');
const { StructuredOutputParser, ContextInjector, IncrementalCollector, CapabilityProbe } = require('../utils/NativeAPIAdapter');

class ClaudeCodeAdapter extends BaseToolAdapter {
  constructor (options = {}) {
    super({
      name: 'claude-code',
      displayName: 'Claude Code',
      description: 'Anthropic Claude Code - AI 编程助手',
      command: 'claude',
      ...options
    });
  }

  async detect () {
    this.detected = false;
    this.status = 'offline';

    try {
      const cmdPath = await this._findCommandInPath('claude');
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
        path.join(localAppData, 'Programs', 'Claude Code', 'claude.exe'),
        path.join(localAppData, 'Claude Code', 'claude.exe'),
        path.join(process.env.APPDATA || '', 'Claude Code', 'claude.exe'),
        path.join('C:', 'Program Files', 'Claude Code', 'claude.exe'),
        path.join('C:', 'Program Files (x86)', 'Claude Code', 'claude.exe')
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
        'HKCU\\Software\\Anthropic\\Claude Code'
      );
      if (registryResult) {
        const installPathMatch = registryResult.match(/InstallPath\s+REG_SZ\s+(.+)/);
        if (installPathMatch) {
          const exePath = path.join(installPathMatch[1].trim(), 'claude.exe');
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
      throw new Error('Claude Code 未安装或未找到');
    }

    try {
      const result = await this._runCommand(this.command, ['--help'], { timeout: 10000 });
      if (result.success) {
        this.status = 'online';
        return { success: true, message: 'Claude Code 连接成功' };
      }
      this.status = 'offline';
      return { success: false, message: 'Claude Code 不可用' };
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
        error: 'Claude Code 不可用',
        startTime,
        endTime: Date.now()
      });
      this.executionHistory.push(result);
      return result;
    }

    const taskId = options.taskId || `task_${Date.now()}`;
    const outputDir = options.outputDir || `./workspace/claude-code/${taskId}`;

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 使用增量采集器记录基线
    const collector = new IncrementalCollector();
    collector.snapshot(outputDir);

    // 使用上下文注入器增强任务提示
    const enhancedTask = options.context
      ? ContextInjector.buildEnhancedPrompt(task, options.context)
      : task;

    const taskFile = path.join(outputDir, 'task.md');
    fs.writeFileSync(taskFile, enhancedTask, 'utf-8');

    const args = ['-p', enhancedTask];

    const result = await this._runCommand(this.command, args, {
      timeout: options.timeout || 300000,
      cwd: outputDir,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' }
    });

    let outputContent = result.stdout || '';

    // 使用结构化输出解析器
    const parsed = StructuredOutputParser.parse(outputContent);
    let codeBlocks = parsed.codeBlocks;

    const outputFile = path.join(outputDir, 'output.md');
    if (fs.existsSync(outputFile)) {
      outputContent = fs.readFileSync(outputFile, 'utf-8');
      const parsedFile = StructuredOutputParser.parse(outputContent);
      codeBlocks = parsedFile.codeBlocks;
    }

    // 使用增量采集器收集变更
    let generatedFiles = [];
    const changes = collector.collectChanges(outputDir);
    generatedFiles = collector.readChanges(outputDir, changes).map(c => ({
      path: c.path,
      content: c.content,
      size: c.size,
      mtime: c.mtime,
      action: c.action
    }));

    // 如果增量采集无结果，回退到全量扫描
    if (generatedFiles.length === 0) {
      try {
        const files = fs.readdirSync(outputDir);
        for (const f of files) {
          const filePath = path.join(outputDir, f);
          const stat = fs.statSync(filePath);
          if (stat.isFile() && f !== 'task.md') {
            generatedFiles.push({
              path: f,
              content: fs.readFileSync(filePath, 'utf-8'),
              size: stat.size,
              mtime: stat.mtime.getTime()
            });
          }
        }
      } catch (e) {}
    }

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
        options: { ...options },
        structuredOutput: {
          jsonBlocks: parsed.jsonBlocks.length,
          fileChanges: parsed.fileChanges.length,
          references: parsed.references.length,
          errors: parsed.errors.length
        }
      }
    });

    this.executionHistory.push(unifiedResult);
    return unifiedResult;
  }

  /**
   * 探测工具能力
   */
  async probeCapabilities () {
    return await CapabilityProbe.probe(this);
  }

  async collectOutput (taskId) {
    const outputDir = `./workspace/claude-code/${taskId}`;
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

module.exports = ClaudeCodeAdapter;
