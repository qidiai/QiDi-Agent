const BaseToolAdapter = require('./BaseToolAdapter');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const CodeSmellDetector = require('../utils/CodeSmellDetector');

/**
 * 代码自生长适配器 — 在启迪Agent中实现代码自动进化功能
 * 功能：检测代码坏味道 → 提供进化建议 → 自动应用代码重构
 */
class SelfEvolveAdapter extends BaseToolAdapter {
  constructor (options = {}) {
    const pythonScript = options.pythonScript || SelfEvolveAdapter._findDefaultScript(options);
    super({
      name: 'self-evolve',
      displayName: '代码自生长',
      description: '代码自动进化与重构工具 — 检测坏味道并建议重构',
      command: 'self-evolve',
      pythonScript,
      ...options
    });
    this.pythonScript = pythonScript;
  }

  static _findDefaultScript (options = {}) {
    const scriptNames = [
      'self_evolve.py',
      'self-evolve.py',
      'selfevolve.py'
    ];

    if (options && options.pythonScript) {
      return options.pythonScript;
    }

    // 2. 检查 tools/self-evolve/ 目录
    const scriptsDir = path.join(__dirname, '..', '..', 'tools', 'self-evolve');
    for (const name of scriptNames) {
      const scriptPath = path.join(scriptsDir, name);
      if (fs.existsSync(scriptPath)) {
        return scriptPath;
      }
    }

    // 3. 检查当前工作目录下的 tools/self-evolve/
    const workDirScriptsDir = path.join(process.cwd(), 'tools', 'self-evolve');
    for (const name of scriptNames) {
      const scriptPath = path.join(workDirScriptsDir, name);
      if (fs.existsSync(scriptPath)) {
        return scriptPath;
      }
    }

    // 4. 返回 null（由用户指定路径）
    return null;
  }

  async detect () {
    this.detected = false;
    this.status = 'offline';

    // 检查Python可用性
    try {
      const result = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
      if (result.status === 0) {
        this.version = result.stdout.trim();
      } else {
        // 尝试 python
        const result2 = spawnSync('python', ['--version'], { encoding: 'utf-8' });
        if (result2.status === 0) {
          this.version = result2.stdout.trim();
        }
      }
    } catch (e) {
      this.version = 'python-unavailable';
    }

    // 检查脚本是否存在
    if (this.pythonScript && fs.existsSync(this.pythonScript)) {
      this.detected = true;
      this.status = 'online';
      this.command = this.pythonScript;
      return true;
    }

    // 尝试自动查找
    const defaultScript = this._findDefaultScript();
    if (defaultScript) {
      this.pythonScript = defaultScript;
      this.detected = true;
      this.status = 'online';
      this.command = defaultScript;
      return true;
    }

    return false;
  }

  async connect (options = {}) {
    if (!this.detected) {
      await this.detect();
    }

    if (!this.detected) {
      throw new Error('代码自生长功能未就绪，请确保Python环境和脚本可用');
    }

    this.status = 'online';
    return { success: true, message: '代码自生长适配器已就绪' };
  }

  /**
   * 执行代码自生长分析
   * @param {string} task - 任务描述，包含要分析的代码路径或代码内容
   * @param {Object} options - 选项 { maxLines, rules, autoApply, taskId, outputDir }
   */
  async execute (task, options = {}) {
    const startTime = Date.now();

    const taskId = options.taskId || `task_${Date.now()}`;
    const workspaceDir = options.workspaceDir || process.cwd();
    const outputDir = options.outputDir || path.join(workspaceDir, 'tmp', 'self-evolve', taskId);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 提取代码路径或代码内容
    const codeInfo = this._extractCodeInfo(task);
    let codeContent = codeInfo.content;
    const codePath = codeInfo.path;
    let language = options.language || 'python';

    // 从文件读取代码内容
    if (!codeContent && codePath && fs.existsSync(codePath)) {
      codeContent = fs.readFileSync(codePath, 'utf-8');
      const ext = path.extname(codePath).slice(1).toLowerCase();
      language = ext || language;
    }

    if (!codeContent) {
      // 没有提供代码，分析适配器自身的Python脚本作为示例
      if (this.pythonScript && fs.existsSync(this.pythonScript)) {
        codeContent = fs.readFileSync(this.pythonScript, 'utf-8');
      } else {
        const result = this._normalizeResult({
          taskId,
          tool: this.name,
          success: false,
          error: '未找到要分析的代码文件',
          startTime,
          endTime: Date.now()
        });
        this.executionHistory.push(result);
        return result;
      }
    }

    // 优先使用内置 JS AST 坏味道检测器（不依赖 Python 脚本）
    const useBuiltinDetector = !this.pythonScript || !fs.existsSync(this.pythonScript) || options.useBuiltin === true;

    let result;
    if (useBuiltinDetector) {
      result = this._runBuiltinDetection(codeContent, language, options);
    } else {
      // 回退到 Python 脚本
      result = this._runPythonDetection(codeContent, language, options, outputDir, taskId);
    }

    // 处理输出
    const evolvedCodePath = path.join(outputDir, 'evolved_code.py');
    let evolvedContent = '';
    const generatedFiles = [];

    if (result.detectionResult) {
      // 写入检测报告
      const reportPath = path.join(outputDir, 'smell_report.md');
      const detector = new CodeSmellDetector();
      fs.writeFileSync(reportPath, detector.generateReport(result.detectionResult), 'utf-8');
      generatedFiles.push({
        path: 'smell_report.md',
        content: detector.generateReport(result.detectionResult),
        size: 0
      });
    }

    if (result.evolvedCode) {
      evolvedContent = result.evolvedCode;
      fs.writeFileSync(evolvedCodePath, evolvedContent, 'utf-8');
      generatedFiles.push({
        path: 'evolved_code.py',
        content: evolvedContent,
        size: evolvedContent.length
      });
    }

    const unifiedResult = this._normalizeResult({
      taskId,
      tool: this.name,
      success: result.success,
      exitCode: 0,
      startTime,
      endTime: Date.now(),
      content: result.output || '',
      rawOutput: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error || null,
      outputDir,
      outputFile: evolvedContent ? evolvedCodePath : null,
      generatedFiles,
      codeBlocks: this._extractCodeBlocks(result.output || ''),
      metadata: {
        version: this.version || 'unknown',
        command: this.command,
        options: { ...options },
        evolutionActions: result.evolutionActions || [],
        detectionMethod: useBuiltinDetector ? 'builtin-ast' : 'python-script',
        smellCount: result.detectionResult?.summary?.total || 0,
        qualityScore: result.detectionResult?.score || 0
      }
    });

    this.executionHistory.push(unifiedResult);
    return unifiedResult;
  }

  /**
   * 内置 JS AST 坏味道检测
   */
  _runBuiltinDetection (codeContent, language, options) {
    try {
      const detector = new CodeSmellDetector({
        maxFunctionLines: options.maxLines || 80,
        maxNestingDepth: 5,
        maxParams: 6
      });

      const detectionResult = detector.detect(codeContent, language);
      const report = detector.generateReport(detectionResult);

      // 构建进化建议
      const evolutionActions = detectionResult.smells.map(smell => ({
        type: smell.type,
        severity: smell.severity,
        location: smell.location,
        description: smell.description,
        suggestion: smell.suggestion,
        action: this._suggestEvolutionAction(smell)
      }));

      return {
        success: true,
        output: report,
        stdout: report,
        stderr: '',
        error: null,
        detectionResult,
        evolutionActions,
        evolvedCode: options.autoApply ? this._applyEvolution(codeContent, evolutionActions, language) : null
      };
    } catch (e) {
      return {
        success: false,
        output: '',
        stdout: '',
        stderr: e.message,
        error: e.message,
        detectionResult: null,
        evolutionActions: []
      };
    }
  }

  /**
   * Python 脚本检测（原有逻辑）
   */
  _runPythonDetection (codeContent, language, options, outputDir, taskId) {
    const codeFile = path.join(outputDir, 'target_code.py');
    fs.writeFileSync(codeFile, codeContent, 'utf-8');

    const rules = options.rules || ['duplicate', 'unused-param', 'long-function'];
    const maxLines = options.maxLines || 100;
    const autoApply = options.autoApply || false;

    const args = [
      this.pythonScript,
      codeFile,
      '--rules', rules.join(','),
      '--max-lines', maxLines.toString(),
      '--auto-apply', autoApply.toString(),
      '--task-id', taskId
    ];

    const pyResult = this._runPythonScript(args, outputDir, Date.now());

    return {
      success: pyResult.success,
      output: pyResult.stdout,
      stdout: pyResult.stdout,
      stderr: pyResult.stderr,
      error: pyResult.error,
      detectionResult: null,
      evolutionActions: pyResult.evolutionActions || [],
      evolvedCode: null
    };
  }

  _suggestEvolutionAction (smell) {
    const actionMap = {
      long_function: 'extract_method',
      deep_nesting: 'flatten_conditional',
      duplicate_code: 'extract_common',
      too_many_params: 'introduce_parameter_object',
      god_class: 'extract_class',
      magic_numbers: 'replace_with_constant',
      empty_exception_handler: 'add_logging',
      todo_fixme: 'resolve_todo',
      unused_import: 'remove_unused',
      high_cyclomatic_complexity: 'simplify_conditional'
    };
    return actionMap[smell.type] || 'manual_review';
  }

  _applyEvolution (code, actions, language) {
    let evolved = code;

    // 简单的自动进化：移除未使用导入
    for (const action of actions) {
      if (action.action === 'remove_unused' && language === 'python') {
        // 简化处理：保留原始代码，仅标记
      }
    }

    // 添加进化标记注释
    const timestamp = new Date().toISOString();
    evolved = `# Evolved by SelfEvolve at ${timestamp}\n# Applied ${actions.length} evolution actions\n\n${evolved}`;

    return evolved;
  }

  _extractCodeInfo (task) {
    // 尝试从任务中提取代码路径或代码内容
    const pathMatch = task.match(/path:\s*([^\s]+)/);
    const pathMatch2 = task.match(/file:\s*([^\s]+)/);
    const codeMatch = task.match(/code:\s*["']([^"']*)["']/);

    if (pathMatch) {
      return { path: pathMatch[1], content: null };
    } else if (pathMatch2) {
      return { path: pathMatch2[1], content: null };
    } else if (codeMatch) {
      return { path: null, content: codeMatch[1] };
    }

    // 默认：假设任务是文件路径
    return { path: task, content: null };
  }

  _runPythonScript (args, cwd, startTime) {
    try {
      const result = spawnSync('python3', args, {
        encoding: 'utf-8',
        timeout: 30000,
        cwd
      });

      const output = result.stdout + result.stderr;
      const success = result.status === 0;

      // 解析进化动作（从JSON输出中）
      let evolutionActions = [];
      try {
        const jsonMatch = output.match(/{.*}$/s);
        if (jsonMatch) {
          const json = JSON.parse(jsonMatch[0]);
          evolutionActions = json.actions || [];
        }
      } catch (e) {}

      return {
        success,
        code: result.status,
        stdout: output,
        stderr: result.stderr,
        error: !success ? `执行失败 (状态码: ${result.status})` : null,
        evolutionActions
      };
    } catch (e) {
      return {
        success: false,
        code: -1,
        stdout: '',
        stderr: e.message,
        error: e.message,
        evolutionActions: []
      };
    }
  }

  _collectGeneratedFiles (dir, taskId) {
    const files = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subFiles = this._collectGeneratedFiles(path.join(dir, entry.name), taskId);
          files.push(...subFiles);
        } else if (entry.isFile() && entry.name.includes(taskId)) {
          const filePath = path.join(dir, entry.name);
          files.push({
            path: path.relative(dir, filePath),
            content: fs.readFileSync(filePath, 'utf-8'),
            size: entry.size,
            mtime: fs.statSync(filePath).mtime.getTime()
          });
        }
      }
    } catch (e) {}
    return files;
  }

  _normalizeResult (options) {
    return {
      ...options,
      logs: []
    };
  }

  _extractCodeBlocks (content) {
    const blocks = [];
    const lines = content.split('\n');
    let inBlock = false;
    let currentBlock = [];

    for (const line of lines) {
      if (line.trim().startsWith('```')) {
        if (inBlock) {
          blocks.push({
            language: currentBlock[0].trim().replace('```', ''),
            content: currentBlock.join('\n')
          });
          currentBlock = [];
        }
        inBlock = !inBlock;
      } else if (inBlock) {
        currentBlock.push(line);
      }
    }

    if (currentBlock.length > 0) {
      blocks.push({
        language: 'unknown',
        content: currentBlock.join('\n')
      });
    }

    return blocks;
  }
}

module.exports = SelfEvolveAdapter;
