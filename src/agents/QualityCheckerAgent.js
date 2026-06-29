const BaseAgent = require('./BaseAgent');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const QUALITY_PROMPT = `你是一位资深质量保障负责人，负责审核代码质量和系统一致性。

你的职责：
1. 评估代码的正确性、一致性、完整性、可读性、安全性、可维护性
2. 检查是否符合全局约束（语言、技术栈、平台等）
3. 检测语言漂移（如从C变成C++或Python）
4. 分析代码结构和设计模式
5. 识别潜在的运行时问题和性能瓶颈

审核维度（满分100分）：
- 正确性 (30分)：逻辑是否正确
- 一致性 (20分)：是否符合约束和前置风格
- 完整性 (20分)：是否覆盖所有需求
- 可读性 (15分)：代码是否清晰易懂
- 安全性 (10分)：安全隐患和最佳实践
- 可维护性 (5分)：扩展性和维护性

输出格式（严格 JSON）：
{
  "taskId": "任务ID",
  "qualityScore": 0-100,
  "status": "completed|needs_revision|failed",
  "strengths": ["优点"],
  "weaknesses": ["不足"],
  "nextSteps": ["下一步"],
  "revisionSuggestions": "具体修改建议",
  "canProceed": true|false,
  "constraintViolations": [],
  "securityIssues": [],
  "codeMetrics": { "linesOfCode": 0, "commentRatio": 0, "functionCount": 0 },
  "toolResults": { "compile": "", "lint": "", "test": "" }
}

注意：只输出 JSON，不要其他文字。`;

class ToolRunner {
  constructor () {
    this.toolCache = new Map();
  }

  hasTool (name) {
    if (this.toolCache.has(name)) return this.toolCache.get(name);
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf-8', shell: false });
    const available = result.status === 0 && result.stdout.trim().length > 0;
    this.toolCache.set(name, available);
    return available;
  }

  run (cmd, args, options = {}) {
    try {
      const result = spawnSync(cmd, args, {
        encoding: 'utf-8',
        timeout: options.timeout || 30000,
        cwd: options.cwd || process.cwd(),
        ...options
      });
      return {
        exitCode: result.status ?? -1,
        stdout: result.stdout || '',
        stderr: result.stderr || ''
      };
    } catch (e) {
      return { exitCode: -1, stdout: '', stderr: e.message };
    }
  }

  compileCode (code, language, options = {}) {
    const tempDir = options.tempDir || path.join(process.cwd(), 'tmp_compile');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const extMap = { c: '.c', cpp: '.cpp', 'c++': '.cpp', java: '.java', go: '.go', rust: '.rs' };
    const ext = extMap[language?.toLowerCase()] || '.txt';
    const fileName = `test_${Date.now()}${ext}`;
    const filePath = path.join(tempDir, fileName);
    fs.writeFileSync(filePath, code, 'utf-8');

    let result = { compiled: false, errors: '', warnings: '', executable: null };

    if (language === 'c') {
      if (this.hasTool('gcc')) {
        const exec = this.run('gcc', ['-Wall', '-Wextra', '-fsyntax-only', filePath], { cwd: tempDir });
        result = { compiled: exec.exitCode === 0, errors: exec.stderr, warnings: exec.stdout, executable: exec.exitCode === 0 ? filePath.replace(ext, '') : null };
      } else if (this.hasTool('tcc')) {
        const exec = this.run('tcc', ['-fsyntax-only', filePath], { cwd: tempDir });
        result = { compiled: exec.exitCode === 0, errors: exec.stderr, warnings: exec.stdout, executable: null };
      } else {
        result = { compiled: false, errors: '未找到gcc或tcc编译器', warnings: '', executable: null };
      }
    } else if (language === 'cpp' || language === 'c++') {
      if (this.hasTool('g++')) {
        const exec = this.run('g++', ['-std=c++17', '-Wall', '-Wextra', '-fsyntax-only', filePath], { cwd: tempDir });
        result = { compiled: exec.exitCode === 0, errors: exec.stderr, warnings: exec.stdout, executable: null };
      } else {
        result = { compiled: false, errors: '未找到g++编译器', warnings: '', executable: null };
      }
    } else if (language === 'python') {
      if (this.hasTool('python')) {
        const exec = this.run('python', ['-m', 'py_compile', filePath], { cwd: tempDir });
        result = { compiled: exec.exitCode === 0, errors: exec.stderr, warnings: '', executable: null };
      } else if (this.hasTool('python3')) {
        const exec = this.run('python3', ['-m', 'py_compile', filePath], { cwd: tempDir });
        result = { compiled: exec.exitCode === 0, errors: exec.stderr, warnings: '', executable: null };
      } else {
        result = { compiled: false, errors: '未找到python解释器', warnings: '', executable: null };
      }
    } else if (language === 'javascript') {
      if (this.hasTool('node')) {
        const exec = this.run('node', ['--check', filePath], { cwd: tempDir });
        result = { compiled: exec.exitCode === 0, errors: exec.stderr, warnings: '', executable: null };
      } else {
        result = { compiled: false, errors: '未找到Node.js', warnings: '', executable: null };
      }
    } else if (language === 'go') {
      if (this.hasTool('go')) {
        const exec = this.run('go', ['build', filePath], { cwd: tempDir });
        result = { compiled: exec.exitCode === 0, errors: exec.stderr, warnings: '', executable: null };
      } else {
        result = { compiled: false, errors: '未找到Go编译器', warnings: '', executable: null };
      }
    } else if (language === 'java') {
      if (this.hasTool('javac')) {
        const exec = this.run('javac', [filePath], { cwd: tempDir });
        result = { compiled: exec.exitCode === 0, errors: exec.stderr, warnings: '', executable: null };
      } else {
        result = { compiled: false, errors: '未找到javac', warnings: '', executable: null };
      }
    } else {
      result = { compiled: false, errors: `暂不支持 ${language} 的编译检查`, warnings: '', executable: null };
    }

    try {
      fs.unlinkSync(filePath);
    } catch (e) {}
    return result;
  }

  lintCode (code, language, options = {}) {
    const tempDir = options.tempDir || path.join(process.cwd(), 'tmp_lint');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const extMap = { c: '.c', cpp: '.cpp', 'c++': '.cpp', python: '.py', javascript: '.js', typescript: '.ts' };
    const ext = extMap[language?.toLowerCase()] || '.txt';
    const fileName = `lint_${Date.now()}${ext}`;
    const filePath = path.join(tempDir, fileName);
    fs.writeFileSync(filePath, code, 'utf-8');

    let result = { passed: true, issues: [], tool: 'none' };

    if (language === 'python') {
      if (this.hasTool('pylint')) {
        const exec = this.run('pylint', ['--disable=C,R', '--score=no', filePath], { cwd: tempDir });
        result = this._parseLintOutput(exec, 'pylint');
      } else if (this.hasTool('flake8')) {
        const exec = this.run('flake8', ['--max-line-length=120', filePath], { cwd: tempDir });
        result = this._parseLintOutput(exec, 'flake8');
      } else if (this.hasTool('python')) {
        const exec = this.run('python', ['-m', 'py_compile', filePath], { cwd: tempDir });
        result = { passed: exec.exitCode === 0, issues: exec.stderr ? [exec.stderr] : [], tool: 'py_compile' };
      }
    } else if (language === 'javascript') {
      if (this.hasTool('eslint')) {
        const exec = this.run('eslint', ['--no-eslintrc', '--rule', 'semi:error', filePath], { cwd: tempDir });
        result = this._parseLintOutput(exec, 'eslint');
      } else if (this.hasTool('node')) {
        const exec = this.run('node', ['--check', filePath], { cwd: tempDir });
        result = { passed: exec.exitCode === 0, issues: exec.stderr ? [exec.stderr] : [], tool: 'node' };
      }
    } else if (language === 'typescript') {
      if (this.hasTool('tsc')) {
        const exec = this.run('tsc', ['--noEmit', '--strict', filePath], { cwd: tempDir });
        result = this._parseLintOutput(exec, 'tsc');
      } else if (this.hasTool('node')) {
        const exec = this.run('node', ['--check', filePath], { cwd: tempDir });
        result = { passed: exec.exitCode === 0, issues: exec.stderr ? [exec.stderr] : [], tool: 'node' };
      }
    } else if (language === 'c' || language === 'cpp' || language === 'c++') {
      result = { passed: true, issues: [], tool: 'gcc_warnings' };
    } else if (language === 'go') {
      if (this.hasTool('go')) {
        const exec = this.run('go', ['vet', filePath], { cwd: tempDir });
        result = { passed: exec.exitCode === 0, issues: exec.stderr ? [exec.stderr] : [], tool: 'go vet' };
      }
    } else if (language === 'rust') {
      if (this.hasTool('rustc')) {
        const exec = this.run('rustc', ['--crate-type', 'lib', '-o', '/dev/null', filePath], { cwd: tempDir });
        result = { passed: exec.exitCode === 0, issues: exec.stderr ? [exec.stderr] : [], tool: 'rustc' };
      }
    } else if (language === 'bash' || language === 'shell') {
      if (this.hasTool('shellcheck')) {
        const exec = this.run('shellcheck', [filePath], { cwd: tempDir });
        result = this._parseLintOutput(exec, 'shellcheck');
      }
    }

    try {
      fs.unlinkSync(filePath);
    } catch (e) {}
    return result;
  }

  _parseLintOutput (exec, toolName) {
    const issues = [];
    if (exec.stdout) issues.push(...exec.stdout.split('\n').filter(l => l.trim()));
    if (exec.stderr) issues.push(...exec.stderr.split('\n').filter(l => l.trim()));
    return {
      passed: exec.exitCode === 0 && issues.length === 0,
      issues,
      tool: toolName
    };
  }

  runTests (code, language, options = {}) {
    const tempDir = options.tempDir || path.join(process.cwd(), 'tmp_test');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const result = { run: false, passed: 0, failed: 0, errors: [], tool: 'none' };

    if (language === 'python') {
      const testFile = path.join(tempDir, `test_${Date.now()}.py`);
      fs.writeFileSync(testFile, code, 'utf-8');
      if (this.hasTool('python')) {
        const exec = this.run('python', ['-m', 'pytest', testFile, '-v', '--tb=short'], { cwd: tempDir });
        result.run = true;
        result.passed = (exec.stdout.match(/passed/g) || []).length;
        result.failed = (exec.stdout.match(/failed/g) || []).length;
        result.errors = exec.stderr ? [exec.stderr] : [];
        result.tool = 'pytest';
      }
      try {
        fs.unlinkSync(testFile);
      } catch (e) {}
    } else if (language === 'javascript') {
      const testFile = path.join(tempDir, `test_${Date.now()}.js`);
      fs.writeFileSync(testFile, code, 'utf-8');
      if (this.hasTool('node')) {
        const exec = this.run('node', [testFile], { cwd: tempDir });
        result.run = true;
        result.passed = exec.exitCode === 0 ? 1 : 0;
        result.failed = exec.exitCode !== 0 ? 1 : 0;
        result.errors = exec.stderr ? [exec.stderr] : [];
        result.tool = 'node';
      }
      try {
        fs.unlinkSync(testFile);
      } catch (e) {}
    }

    return result;
  }
}

class QualityCheckerAgent extends BaseAgent {
  constructor (provider, options = {}) {
    super(provider, {
      name: 'QualityChecker',
      role: '质量审核员',
      systemPrompt: QUALITY_PROMPT,
      temperature: 0.3,
      ...options
    });
    this.enableStaticCheck = options.enableStaticCheck !== false;
    this.enableCompilation = options.enableCompilation !== false;
    this.enableLint = options.enableLint !== false;
    this.enableTest = options.enableTest !== false;
    this.toolRunner = new ToolRunner();
    this.minQualityScore = options.minQualityScore || 75;
    this.gates = {
      earlySafety: { enabled: true, passThreshold: 0, failAction: 'block' },
      compile: { enabled: true, passThreshold: 0, failAction: 'block' },
      lint: { enabled: true, passThreshold: 0, failAction: 'warn' },
      aiReview: { enabled: true, passThreshold: 75, failAction: 'block' },
      integration: { enabled: false, passThreshold: 0, failAction: 'warn' }
    };
    this.earlySafetyRules = {
      fileDeletion: { enabled: true, patterns: [/rm\s+/, /unlink\s*/, /deleteFile\s*/, /remove\s+/, /fs\.unlink/, /fs\.rm/, /path\.remove/] },
      networkAccess: { enabled: true, patterns: [/http:\/*/, /https:\/*/, /fetch\s*\(/, /axios\./, /request\s*\(/, /socket\./, /net\./, /http\.get/, /http\.post/] },
      permissionElevation: { enabled: true, patterns: [/sudo\s+/, /chmod\s+/, /chown\s+/, /setuid/, /setgid/, /ACL/, /permission/] },
      systemCommands: { enabled: true, patterns: [/exec\s*\(/, /spawn\s*\(/, /child_process/, /system\s*\(/, /shell\./] },
      sensitiveData: { enabled: true, patterns: [/password\s*=/, /secret\s*=/, /api[_\-\s]?key/, /token\s*=/, /private[_\-\s]?key/] }
    };
  }

  async checkQuality (task, result, context = {}) {
    const codeInfo = this._extractCode(result);
    const language = codeInfo?.language || context.constraints?.language || 'text';
    const code = codeInfo?.code || (typeof result === 'string' ? result : JSON.stringify(result));

    const gateResults = await this._runQualityGates(code, language, task, context);

    if (!gateResults.canProceed) {
      return gateResults.finalResult;
    }

    const aiReviewResult = await this._runAIReview(task, result, context, gateResults);

    return this._applyObjectiveScoring(
      aiReviewResult, task,
      gateResults.compileResult,
      gateResults.lintResult,
      gateResults.testResult,
      gateResults.staticCheckResults
    );
  }

  async _runQualityGates (code, language, task, context) {
    const gateResults = {
      compileResult: null,
      lintResult: null,
      testResult: null,
      staticCheckResults: null,
      earlySafetyResult: null,
      canProceed: true,
      failedGate: null,
      finalResult: null
    };

    if (this.gates.earlySafety.enabled && code) {
      gateResults.earlySafetyResult = this._runEarlySafetyGate(code, language, task);
      if (!gateResults.earlySafetyResult.passed) {
        return this._handleGateFailure('earlySafety', gateResults, task);
      }
    }

    if (this.enableCompilation && this.gates.compile.enabled && code) {
      gateResults.compileResult = this.toolRunner.compileCode(code, language);
      if (!gateResults.compileResult.compiled) {
        return this._handleGateFailure('compile', gateResults, task);
      }
    }

    if (this.enableLint && this.gates.lint.enabled && code) {
      gateResults.lintResult = this.toolRunner.lintCode(code, language);
      if (!gateResults.lintResult.passed && gateResults.lintResult.issues.length > 5) {
        return this._handleGateFailure('lint', gateResults, task);
      }
    }

    if (this.enableTest && this.gates.integration.enabled && code) {
      gateResults.testResult = this.toolRunner.runTests(code, language);
      if (gateResults.testResult.run && gateResults.testResult.failed > gateResults.testResult.passed) {
        return this._handleGateFailure('integration', gateResults, task);
      }
    }

    gateResults.staticCheckResults = this._staticCodeCheck(code, language, context.constraints);

    return gateResults;
  }

  _handleGateFailure (gateName, gateResults, task) {
    const gateConfig = this.gates[gateName];

    if (gateConfig.failAction === 'block') {
      const scores = { earlySafety: 20, compile: 30, lint: 50, aiReview: 50, integration: 50 };
      const finalScore = scores[gateName] || 50;
      gateResults.canProceed = false;
      gateResults.failedGate = gateName;

      const securityIssues = gateName === 'earlySafety'
        ? (gateResults.earlySafetyResult?.violations || []).map(v => `${v.rule}: ${v.matched.join(', ')}`)
        : [];

      gateResults.finalResult = {
        taskId: task.id,
        qualityScore: finalScore,
        status: 'failed',
        strengths: [],
        weaknesses: [`${gateName} 门控失败`],
        nextSteps: ['修复问题后重新提交'],
        revisionSuggestions: this._generateFixSuggestion(gateName, gateResults),
        canProceed: false,
        constraintViolations: [],
        securityIssues,
        codeMetrics: {},
        toolResults: {
          earlySafety: gateResults.earlySafetyResult,
          compile: gateResults.compileResult,
          lint: gateResults.lintResult,
          test: gateResults.testResult
        },
        gateReport: {
          passed: false,
          failedGate: gateName,
          gateResults: {
            earlySafety: gateResults.earlySafetyResult?.passed,
            compile: gateResults.compileResult?.compiled,
            lint: gateResults.lintResult?.passed,
            test: gateResults.testResult?.passed
          }
        }
      };
    }

    return gateResults;
  }

  _runEarlySafetyGate (code, language, task) {
    const violations = [];
    const codeLower = code.toLowerCase();

    for (const [ruleName, ruleConfig] of Object.entries(this.earlySafetyRules)) {
      if (!ruleConfig.enabled) continue;

      for (const pattern of ruleConfig.patterns) {
        const matches = codeLower.match(pattern);
        if (matches) {
          violations.push({
            rule: ruleName,
            pattern: pattern.toString(),
            matched: matches.slice(0, 3),
            severity: this._getSafetySeverity(ruleName)
          });
          break;
        }
      }
    }

    return {
      passed: violations.length === 0,
      violations,
      totalViolations: violations.length,
      highSeverityCount: violations.filter(v => v.severity === 'high').length,
      mediumSeverityCount: violations.filter(v => v.severity === 'medium').length
    };
  }

  _getSafetySeverity (ruleName) {
    const severityMap = {
      fileDeletion: 'high',
      permissionElevation: 'high',
      sensitiveData: 'high',
      networkAccess: 'medium',
      systemCommands: 'medium'
    };
    return severityMap[ruleName] || 'low';
  }

  _generateFixSuggestion (gateName, gateResults) {
    switch (gateName) {
    case 'earlySafety': {
      const violations = gateResults.earlySafetyResult?.violations || [];
      const highIssues = violations.filter(v => v.severity === 'high');
      const mediumIssues = violations.filter(v => v.severity === 'medium');
      let suggestion = '早期安全检查失败，检测到以下高危操作：\n';
      if (highIssues.length > 0) {
        suggestion += `高危: ${highIssues.map(v => v.rule).join(', ')}\n`;
      }
      if (mediumIssues.length > 0) {
        suggestion += `中危: ${mediumIssues.map(v => v.rule).join(', ')}\n`;
      }
      suggestion += '请移除或审查这些操作后重新提交';
      return suggestion;
    }
    case 'compile':
      return `编译失败，错误信息：${gateResults.compileResult?.errors?.substring(0, 200)}`;
    case 'lint':
      return `静态检查发现 ${gateResults.lintResult?.issues?.length || 0} 个问题，建议修复后重新提交`;
    case 'integration':
      return '测试失败率过高，建议检查测试用例和实现逻辑';
    default:
      return '质量门控失败，请检查相关工具输出';
    }
  }

  async _runAIReview (task, result, context, gateResults) {
    const codeInfo = this._extractCode(result);
    const language = codeInfo?.language || context.constraints?.language || 'text';
    const code = codeInfo?.code || (typeof result === 'string' ? result : JSON.stringify(result));

    let prompt = '请审核以下代码质量。注意：我已经通过工具进行了客观验证，以下数据可供你参考。\n\n';
    prompt += `【任务】${task.title}\n${task.description}\n`;
    if (task.acceptanceCriteria) {
      prompt += `\n【验收标准】\n${task.acceptanceCriteria}\n`;
    }
    if (context.constraints) {
      prompt += '\n【全局约束】\n';
      prompt += `语言: ${context.constraints.language || '未指定'}\n`;
      prompt += `技术栈: ${context.constraints.techStack || '未指定'}\n`;
      prompt += `平台: ${context.constraints.platform || '未指定'}\n`;
    }
    prompt += `\n【代码成果】\n\`\`\`${language}\n${code.substring(0, 3000)}\n\`\`\`\n`;

    prompt += '\n【质量门控结果】\n';
    if (gateResults.compileResult) {
      prompt += `编译检查: ${gateResults.compileResult.compiled ? '✅ 通过' : '❌ 失败'}\n`;
      if (gateResults.compileResult.errors) prompt += `编译错误: ${gateResults.compileResult.errors.substring(0, 500)}\n`;
      if (gateResults.compileResult.warnings) prompt += `编译警告: ${gateResults.compileResult.warnings.substring(0, 500)}\n`;
    }
    if (gateResults.lintResult) {
      prompt += `静态检查: ${gateResults.lintResult.passed ? '✅ 通过' : '⚠️ 有问题'} (${gateResults.lintResult.tool})\n`;
      if (gateResults.lintResult.issues.length > 0) {
        prompt += `问题列表: ${gateResults.lintResult.issues.slice(0, 5).join('; ')}\n`;
      }
    }
    if (gateResults.testResult) {
      prompt += `测试执行: ${gateResults.testResult.run ? '✅ 已执行' : '❌ 未执行'} (${gateResults.testResult.tool})\n`;
      prompt += `通过/失败: ${gateResults.testResult.passed}/${gateResults.testResult.failed}\n`;
    }

    if (gateResults.staticCheckResults.constraintViolations.length > 0) {
      prompt += `\n【约束违规】\n${gateResults.staticCheckResults.constraintViolations.map(v => `- ${v}`).join('\n')}\n`;
    }
    if (gateResults.staticCheckResults.securityIssues.length > 0) {
      prompt += `\n【安全问题】\n${gateResults.staticCheckResults.securityIssues.map(v => `- ${v}`).join('\n')}\n`;
    }

    prompt += '\n【代码指标】\n';
    prompt += `  行数: ${gateResults.staticCheckResults.metrics.linesOfCode}\n`;
    prompt += `  注释率: ${gateResults.staticCheckResults.metrics.commentRatio}%\n`;
    prompt += `  函数数: ${gateResults.staticCheckResults.metrics.functionCount}\n`;

    prompt += '\n⚠️ 重要：你的评分必须综合考虑以上客观工具数据。';
    prompt += '如果编译失败，正确性得分不应超过50分。';
    prompt += '如果静态检查发现问题，一致性/安全性得分应相应降低。';

    if (context.isFinalReview === true) {
      prompt += '\n\n【最终审查模式】本次审查的是**多个子任务合并后的整体产出**。请额外关注跨文件一致性、整体项目结构完整性、子任务产出之间的接口断裂、重复/冲突的定义、整体代码风格是否统一。在评分时，如果发现上述问题，请额外扣分（每项-10分）。';
    }

    const response = await this.sendWithRetry(prompt);
    const parsed = this._extractJsonWithRepair(response.content);
    if (parsed) return parsed;

    return this._extractJson(response.content);
  }

  _applyObjectiveScoring (parsed, task, compileResult, lintResult, testResult, staticCheckResults) {
    const base = parsed || {
      taskId: task.id,
      qualityScore: 60,
      status: 'completed',
      strengths: ['任务基本完成'],
      weaknesses: ['无法自动评估详细质量'],
      nextSteps: ['建议人工确认'],
      revisionSuggestions: '',
      canProceed: true,
      constraintViolations: [],
      securityIssues: [],
      codeMetrics: {}
    };

    let score = base.qualityScore || 60;
    const violations = [...(base.constraintViolations || [])];
    const securityIssues = [...(base.securityIssues || [])];

    if (compileResult && !compileResult.compiled) {
      score = Math.min(50, score);
      violations.push('编译失败: ' + (compileResult.errors || '未知错误').substring(0, 100));
    } else if (compileResult && compileResult.warnings) {
      const warnCount = (compileResult.warnings.match(/warning/g) || []).length;
      if (warnCount > 3) {
        score = Math.max(0, score - 10);
      }
    }

    if (lintResult && !lintResult.passed) {
      score = Math.max(0, score - 15);
      violations.push(`静态检查未通过 (${lintResult.tool})`);
    }

    if (testResult && testResult.failed > 0) {
      const failRate = testResult.failed / (testResult.passed + testResult.failed);
      score = Math.max(0, score - Math.round(30 * failRate));
      violations.push(`测试失败: ${testResult.failed} 个失败`);
    }

    if (staticCheckResults.constraintViolations.length > 0) {
      const penalty = Math.min(30, staticCheckResults.constraintViolations.length * 8);
      score = Math.max(0, score - penalty);
      violations.push(...staticCheckResults.constraintViolations);
    }

    if (staticCheckResults.securityIssues.length > 0) {
      const penalty = Math.min(20, staticCheckResults.securityIssues.length * 5);
      score = Math.max(0, score - penalty);
      securityIssues.push(...staticCheckResults.securityIssues);
    }

    let status = base.status || 'completed';
    let canProceed = true;
    if (score < 40) {
      status = 'failed';
      canProceed = false;
    } else if (score < this.minQualityScore) {
      status = 'needs_revision';
      canProceed = false;
    }

    return {
      ...base,
      qualityScore: Math.round(score),
      status,
      canProceed,
      constraintViolations: violations,
      securityIssues,
      codeMetrics: staticCheckResults.metrics || base.codeMetrics,
      toolResults: {
        compile: compileResult ? { compiled: compileResult.compiled, errors: compileResult.errors?.substring(0, 500) } : null,
        lint: lintResult ? { passed: lintResult.passed, issues: lintResult.issues.slice(0, 10), tool: lintResult.tool } : null,
        test: testResult ? { run: testResult.run, passed: testResult.passed, failed: testResult.failed, tool: testResult.tool } : null
      },
      gateReport: {
        passed: canProceed,
        compile: compileResult?.compiled,
        lint: lintResult?.passed,
        test: testResult?.passed
      }
    };
  }

  _extractCode (result) {
    if (typeof result === 'string') {
      const match = result.match(/```(\w+)?\s*\n([\s\S]*?)\n```/);
      if (match) return { language: match[1] || 'text', code: match[2].trim() };

      const repaired = this._repairCodeBlocks(result);
      if (repaired) return repaired;

      return null;
    }
    if (result.code) return { language: result.language || 'text', code: result.code };
    if (result.codeBlocks && result.codeBlocks.length > 0) return result.codeBlocks[0];
    return null;
  }

  _repairCodeBlocks (text) {
    if (!text || typeof text !== 'string') return null;

    const patterns = [
      /```(\w+)?\s*\n([\s\S]*)$/,
      /([\s\S]*?)\s*```$/
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return { language: match[1] || 'text', code: match[2].trim() };
      }
    }

    const langPatterns = [
      { lang: 'c', pattern: /^\s*(#include|#define|typedef|struct|union|int|void|char|float|double|long|short|unsigned|static|extern)\s/ },
      { lang: 'python', pattern: /^\s*(def|class|import|from|if|else|for|while|return|print)\s/ },
      { lang: 'javascript', pattern: /^\s*(function|const|let|var|class|import|export|return|if|else)\s/ },
      { lang: 'cpp', pattern: /^\s*(#include|class|template|namespace|std::|using|int|void|char|float|double|long)\s/ }
    ];

    for (const { lang, pattern } of langPatterns) {
      if (pattern.test(text)) {
        return { language: lang, code: text.trim() };
      }
    }

    return null;
  }

  _repairJson (text) {
    if (!text || typeof text !== 'string') return null;

    let repaired = text.trim();

    repaired = repaired.replace(/```json\s*/g, '').replace(/\s*```/g, '');

    repaired = repaired.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();

    if (!repaired.startsWith('{')) {
      const braceIndex = repaired.indexOf('{');
      if (braceIndex !== -1) {
        repaired = repaired.substring(braceIndex);
      }
    }

    if (!repaired.endsWith('}')) {
      const lastBraceIndex = repaired.lastIndexOf('}');
      if (lastBraceIndex !== -1) {
        repaired = repaired.substring(0, lastBraceIndex + 1);
      }
    }

    repaired = this._fixUnclosedStrings(repaired);
    repaired = this._fixMissingCommas(repaired);
    repaired = this._fixTrailingCommas(repaired);

    try {
      return JSON.parse(repaired);
    } catch (e) {
      return null;
    }
  }

  _fixUnclosedStrings (text) {
    let result = '';
    let inString = false;
    let escape = false;
    let stringChar = '';

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (escape) {
        result += char;
        escape = false;
        continue;
      }

      if (char === '\\') {
        result += char;
        escape = true;
        continue;
      }

      if ((char === '"' || char === '\'') && !inString) {
        inString = true;
        stringChar = char;
        result += char;
        continue;
      }

      if (char === stringChar && inString) {
        inString = false;
        stringChar = '';
        result += char;
        continue;
      }

      result += char;
    }

    if (inString) {
      result += stringChar;
    }

    return result;
  }

  _fixMissingCommas (text) {
    return text.replace(/([}\]])\s*(\{|\[)/g, '$1,\n$2')
      .replace(/("[\w]+":\s*[^,}\]])\s*("[\w]+":)/g, '$1,\n$2')
      .replace(/("[\w]+":\s*[^,}\]])\s*(\d+\s*[,}])/g, '$1,\n$2');
  }

  _fixTrailingCommas (text) {
    return text.replace(/,\s*([}\]])/g, '$1');
  }

  _extractJsonWithRepair (text) {
    const parsed = this._extractJson(text);
    if (parsed) return parsed;

    const repaired = this._repairJson(text);
    if (repaired) return repaired;

    return null;
  }

  _staticCodeCheck (code, language, constraints = {}) {
    const violations = [];
    const securityIssues = [];
    const metrics = this._calculateMetrics(code);

    if (constraints.language) {
      const langLower = constraints.language.toLowerCase();
      const detectedLang = this._detectLanguage(code, language);
      if (langLower === 'c' && detectedLang !== 'c') {
        if (this._detectCppFeatures(code)) {
          violations.push('检测到C++语法，违反C语言约束');
        }
      }
      if (langLower === 'c' && language && language.toLowerCase() === 'python') {
        violations.push('代码语言为Python，违反C语言约束');
      }
    }

    if (language === 'c' || constraints.language?.toLowerCase() === 'c') {
      securityIssues.push(...this._checkCSecurity(code));
    }
    if (language === 'javascript' || language === 'typescript') {
      securityIssues.push(...this._checkJSSecurity(code));
    }
    if (language === 'python') {
      securityIssues.push(...this._checkPythonSecurity(code));
    }

    return { constraintViolations: violations, securityIssues, metrics };
  }

  _detectLanguage (code, declaredLanguage) {
    if (declaredLanguage) return declaredLanguage.toLowerCase();
    if (/^\s*#include\s*<.*\.h>/m.test(code) && !/class\s+\w+/.test(code)) return 'c';
    if (/\b(cin|cout|class|new|delete|std::|template|vector<)\b/.test(code)) return 'cpp';
    if (/^\s*(def|class)\s+\w+.*:/m.test(code)) return 'python';
    return 'unknown';
  }

  _detectCppFeatures (code) {
    const cppPatterns = [
      /\bcin\s*>>/, /\bcout\s*<</, /\bclass\s+\w+/, /\bnew\s+\w+/, /\bdelete\s+/,
      /\bstd::\w+/, /\btemplate\s*<.*>/, /\bvector\s*<.*>/, /\busing\s+namespace\s+/
    ];
    return cppPatterns.some(p => p.test(code));
  }

  _checkCSecurity (code) {
    const issues = [];
    if (/gets\s*\(/.test(code)) issues.push('使用了危险函数 gets()，建议 fgets()');
    if (/strcpy\s*\(/.test(code)) issues.push('使用了 strcpy()，建议 strncpy()');
    if (/strcat\s*\(/.test(code)) issues.push('使用了 strcat()，建议 strncat()');
    if (/sprintf\s*\(/.test(code)) issues.push('使用了 sprintf()，建议 snprintf()');
    const mallocCount = (code.match(/\bmalloc\s*\(/g) || []).length;
    const freeCount = (code.match(/\bfree\s*\(/g) || []).length;
    if (mallocCount > freeCount) issues.push(`可能的内存泄漏: malloc ${mallocCount}次, free ${freeCount}次`);
    if (/scanf\s*\(.*%s/.test(code) && !/scanf\s*\(.*%\d*s/.test(code)) issues.push('scanf %s 无长度限制，存在缓冲区溢出风险');
    return issues;
  }

  _checkJSSecurity (code) {
    const issues = [];
    if (/eval\s*\(/.test(code)) issues.push('使用了 eval()，存在代码注入风险');
    if (/innerHTML\s*=/.test(code)) issues.push('使用 innerHTML 赋值，存在XSS风险');
    if (/document\.write\s*\(/.test(code)) issues.push('使用 document.write()，存在安全风险');
    return issues;
  }

  _checkPythonSecurity (code) {
    const issues = [];
    if (/eval\s*\(/.test(code)) issues.push('使用了 eval()，存在代码注入风险');
    if (/exec\s*\(/.test(code)) issues.push('使用了 exec()，存在代码注入风险');
    if (/subprocess\.call\s*\(/.test(code) && !/shell\s*=\s*False/.test(code)) issues.push('subprocess.call() 可能使用shell，存在命令注入风险');
    return issues;
  }

  _calculateMetrics (code) {
    const lines = code.split('\n');
    const totalLines = lines.length;
    let commentLines = 0; let codeLines = 0; let inBlockComment = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (inBlockComment) {
        commentLines++; if (trimmed.includes('*/')) inBlockComment = false; continue;
      }
      if (trimmed.startsWith('/*')) {
        commentLines++; if (!trimmed.includes('*/')) inBlockComment = true; continue;
      }
      if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
        commentLines++; continue;
      }
      if (trimmed.length > 0) codeLines++;
    }

    const functionMatch = code.match(/\b(?:int|void|char|float|double|long|short|unsigned|static|extern|def|function|async\s+function)\s+\w+\s*\(/g);
    const functionCount = functionMatch ? functionMatch.length : 0;
    const commentRatio = totalLines > 0 ? Math.round((commentLines / totalLines) * 100) : 0;

    return { linesOfCode: totalLines, codeLines, commentLines, commentRatio, functionCount };
  }

  async runFullQualityCheck (task, result, context = {}) {
    const codeInfo = this._extractCode(result);
    const language = codeInfo?.language || context.constraints?.language || 'text';
    const code = codeInfo?.code || (typeof result === 'string' ? result : JSON.stringify(result));

    const gateResults = await this._runQualityGates(code, language, task, context);

    if (!gateResults.canProceed) {
      return {
        ...gateResults.finalResult,
        fullReport: gateResults
      };
    }

    const aiReviewResult = await this._runAIReview(task, result, context, gateResults);

    const finalResult = this._applyObjectiveScoring(
      aiReviewResult, task,
      gateResults.compileResult,
      gateResults.lintResult,
      gateResults.testResult,
      gateResults.staticCheckResults
    );

    return {
      ...finalResult,
      fullReport: {
        gates: {
          compile: { passed: gateResults.compileResult?.compiled, details: gateResults.compileResult },
          lint: { passed: gateResults.lintResult?.passed, details: gateResults.lintResult },
          test: { passed: gateResults.testResult?.passed, details: gateResults.testResult },
          aiReview: { passed: finalResult.canProceed }
        },
        metrics: finalResult.codeMetrics,
        securityIssues: finalResult.securityIssues,
        constraintViolations: finalResult.constraintViolations
      }
    };
  }
}

module.exports = QualityCheckerAgent;
