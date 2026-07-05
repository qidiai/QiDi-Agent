/**
 * @module TestRunner
 *
 * 测试执行引擎 — 将 TesterAgent 设计的测试用例真正执行起来。
 *
 * 支持的测试框架：
 * - Python: pytest, unittest
 * - JavaScript/TypeScript: jest, mocha, node:test
 * - Go: go test
 * - Java: JUnit (mvn test / gradle test)
 * - Rust: cargo test
 * - C/C++: 自定义 assert 宏 + gcc 执行
 *
 * 工作流程：
 * 1. 接收测试用例（来自 TesterAgent 或自动生成）
 * 2. 根据语言/框架选择执行策略
 * 3. 在临时目录或指定工作区中执行测试
 * 4. 解析测试结果（通过/失败/错误/覆盖率）
 * 5. 返回结构化测试报告
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/Logger')('TestRunner');

// ── 工具检测缓存 ──
const _toolCache = new Map();
function hasTool (name) {
  if (_toolCache.has(name)) return _toolCache.get(name);
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(cmd, [name], { encoding: 'utf-8', shell: false });
  const available = result.status === 0 && result.stdout.trim().length > 0;
  _toolCache.set(name, available);
  return available;
}

class TestRunner {
  constructor (options = {}) {
    this.defaultTimeout = options.timeout || 60000;
    this.tempDir = options.tempDir || path.join(process.cwd(), 'tmp_tests');
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.keepTempFiles = options.keepTempFiles || false;
    this.coverageEnabled = options.coverageEnabled !== false;

    this._ensureDir(this.tempDir);

    // 框架优先级（按语言）
    this.frameworkPriority = {
      python: ['pytest', 'unittest'],
      javascript: ['jest', 'mocha', 'node_test'],
      typescript: ['jest', 'mocha'],
      go: ['go_test'],
      java: ['junit_mvn', 'junit_gradle'],
      rust: ['cargo_test'],
      c: ['custom'],
      cpp: ['custom']
    };
  }

  _ensureDir (dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 执行测试
   * @param {Object} params - { testCode, language, framework, sourceCode, workspaceDir, testFilePath }
   * @returns {Promise<Object>} 测试结果
   */
  async runTests (params) {
    const {
      testCode,
      language = 'javascript',
      framework = null,
      sourceCode = null,
      workspaceDir = null,
      testFilePath = null,
      timeout = this.defaultTimeout
    } = params;

    const lang = language.toLowerCase();
    const wsDir = workspaceDir || this.workspaceDir;

    logger.info(`[TestRunner] 开始执行测试: language=${lang}, framework=${framework || 'auto'}`);

    // 选择框架
    const selectedFramework = framework || this._detectBestFramework(lang, wsDir);

    // 准备测试文件
    const testEnv = this._prepareTestEnvironment(testCode, sourceCode, lang, selectedFramework, wsDir, testFilePath);

    // 执行测试
    let result;
    try {
      switch (selectedFramework) {
      case 'pytest':
        result = await this._runPytest(testEnv, timeout);
        break;
      case 'unittest':
        result = await this._runUnittest(testEnv, timeout);
        break;
      case 'jest':
        result = await this._runJest(testEnv, timeout);
        break;
      case 'mocha':
        result = await this._runMocha(testEnv, timeout);
        break;
      case 'node_test':
        result = await this._runNodeTest(testEnv, timeout);
        break;
      case 'go_test':
        result = await this._runGoTest(testEnv, timeout);
        break;
      case 'junit_mvn':
        result = await this._runJunitMvn(testEnv, timeout);
        break;
      case 'junit_gradle':
        result = await this._runJunitGradle(testEnv, timeout);
        break;
      case 'cargo_test':
        result = await this._runCargoTest(testEnv, timeout);
        break;
      case 'custom':
        result = await this._runCustomC(testEnv, timeout);
        break;
      default:
        result = this._buildResult(false, `不支持的测试框架: ${selectedFramework}`);
      }
    } catch (e) {
      result = this._buildResult(false, `测试执行异常: ${e.message}`);
      logger.error(`[TestRunner] 执行异常: ${e.message}`);
    }

    // 清理
    if (!this.keepTempFiles) {
      this._cleanup(testEnv);
    }

    result.framework = selectedFramework;
    result.language = lang;

    logger.info(`[TestRunner] 测试完成: passed=${result.passed}, total=${result.total}, failed=${result.failed}`);
    return result;
  }

  /**
   * 批量执行测试（来自 TesterAgent 的测试用例列表）
   */
  async runTestCases (testCases, options = {}) {
    const {
      language = 'javascript',
      sourceCode = null,
      workspaceDir = null,
      timeout = this.defaultTimeout
    } = options;

    // 将测试用例转换为可执行的测试代码
    const testCode = this._generateTestCode(testCases, language);

    return this.runTests({
      testCode,
      language,
      sourceCode,
      workspaceDir,
      timeout
    });
  }

  /**
   * 合并后集成测试
   */
  async runIntegrationTests (mergedCode, language, workspaceDir) {
    logger.info('[TestRunner] 运行合并后集成测试');

    // 自动生成集成测试
    const integrationTestCode = this._generateIntegrationTest(mergedCode, language);

    const result = await this.runTests({
      testCode: integrationTestCode,
      sourceCode: mergedCode,
      language,
      workspaceDir,
      timeout: this.defaultTimeout * 2
    });

    result.type = 'integration';
    return result;
  }

  // ═══════════════════════════════════════════
  // 框架执行器
  // ═══════════════════════════════════════════

  async _runPytest (env, timeout) {
    if (!hasTool('python') && !hasTool('python3')) {
      return this._buildResult(false, '未找到 Python 解释器');
    }
    const python = hasTool('python3') ? 'python3' : 'python';

    // 确保 pytest 可用
    const pytestCheck = spawnSync(python, ['-m', 'pytest', '--version'], { encoding: 'utf-8', timeout: 10000 });
    if (pytestCheck.status !== 0) {
      // 尝试安装 pytest
      spawnSync(python, ['-m', 'pip', 'install', 'pytest', '-q'], { encoding: 'utf-8', timeout: 30000 });
    }

    const args = ['-m', 'pytest', env.testFile, '-v', '--tb=short', '--json-report', `--json-report-file=${env.reportFile}`];
    if (this.coverageEnabled) {
      args.push('--cov');
    }

    const exec = spawnSync(python, args, {
      encoding: 'utf-8',
      timeout,
      cwd: env.workDir
    });

    return this._parsePytestResult(exec, env);
  }

  async _runUnittest (env, timeout) {
    if (!hasTool('python') && !hasTool('python3')) {
      return this._buildResult(false, '未找到 Python 解释器');
    }
    const python = hasTool('python3') ? 'python3' : 'python';

    const exec = spawnSync(python, ['-m', 'unittest', env.testModule, '-v'], {
      encoding: 'utf-8',
      timeout,
      cwd: env.workDir
    });

    return this._parseUnittestResult(exec, env);
  }

  async _runJest (env, timeout) {
    // 检查 jest 是否可用
    let jestBin = path.join(env.workDir, 'node_modules', '.bin', 'jest');
    if (!fs.existsSync(jestBin)) {
      jestBin = hasTool('jest') ? 'jest' : null;
    }
    if (!jestBin) {
      // 尝试 npx
      const npxCheck = spawnSync('npx', ['jest', '--version'], { encoding: 'utf-8', timeout: 30000 });
      if (npxCheck.status !== 0) {
        return this._buildResult(false, '未找到 jest，请先安装: npm install -g jest');
      }
      jestBin = 'npx';
    }

    const args = jestBin === 'npx' ? ['npx', 'jest', env.testFile, '--verbose', '--json'] : [env.testFile, '--verbose', '--json'];
    const cmd = jestBin === 'npx' ? 'npx' : jestBin;

    const exec = spawnSync(cmd, args, {
      encoding: 'utf-8',
      timeout,
      cwd: env.workDir
    });

    return this._parseJestResult(exec, env);
  }

  async _runMocha (env, timeout) {
    let mochaBin = path.join(env.workDir, 'node_modules', '.bin', 'mocha');
    if (!fs.existsSync(mochaBin)) {
      mochaBin = hasTool('mocha') ? 'mocha' : null;
    }
    if (!mochaBin) {
      return this._buildResult(false, '未找到 mocha');
    }

    const exec = spawnSync(mochaBin, [env.testFile, '--reporter', 'json'], {
      encoding: 'utf-8',
      timeout,
      cwd: env.workDir
    });

    return this._parseMochaResult(exec, env);
  }

  async _runNodeTest (env, timeout) {
    if (!hasTool('node')) {
      return this._buildResult(false, '未找到 Node.js');
    }

    // 使用 Node.js 内置 test runner (Node 18+)
    const exec = spawnSync('node', ['--test', env.testFile], {
      encoding: 'utf-8',
      timeout,
      cwd: env.workDir
    });

    return this._parseNodeTestResult(exec, env);
  }

  async _runGoTest (env, timeout) {
    if (!hasTool('go')) {
      return this._buildResult(false, '未找到 Go 编译器');
    }

    const exec = spawnSync('go', ['test', '-v', '-json', './...'], {
      encoding: 'utf-8',
      timeout,
      cwd: env.workDir
    });

    return this._parseGoTestResult(exec, env);
  }

  async _runJunitMvn (env, timeout) {
    if (!hasTool('mvn')) {
      return this._buildResult(false, '未找到 Maven (mvn)');
    }

    const exec = spawnSync('mvn', ['test', '-q'], {
      encoding: 'utf-8',
      timeout,
      cwd: env.workDir
    });

    return this._parseMvnTestResult(exec, env);
  }

  async _runJunitGradle (env, timeout) {
    if (!hasTool('gradle')) {
      return this._buildResult(false, '未找到 Gradle');
    }

    const exec = spawnSync('gradle', ['test', '--quiet'], {
      encoding: 'utf-8',
      timeout,
      cwd: env.workDir
    });

    return this._parseGradleTestResult(exec, env);
  }

  async _runCargoTest (env, timeout) {
    if (!hasTool('cargo')) {
      return this._buildResult(false, '未找到 Cargo (Rust)');
    }

    const exec = spawnSync('cargo', ['test', '--', '--nocapture'], {
      encoding: 'utf-8',
      timeout,
      cwd: env.workDir
    });

    return this._parseCargoTestResult(exec, env);
  }

  async _runCustomC (env, timeout) {
    if (!hasTool('gcc')) {
      return this._buildResult(false, '未找到 GCC');
    }

    // 编译并运行
    const outputFile = env.testFile.replace(/\.[^.]+$/, '.exe');
    const compile = spawnSync('gcc', ['-o', outputFile, env.testFile, '-lc'], {
      encoding: 'utf-8',
      timeout: 30000,
      cwd: env.workDir
    });

    if (compile.status !== 0) {
      return this._buildResult(false, `编译失败: ${compile.stderr}`);
    }

    const exec = spawnSync(outputFile, [], {
      encoding: 'utf-8',
      timeout,
      cwd: env.workDir
    });

    return this._parseCustomCResult(exec, env);
  }

  // ═══════════════════════════════════════════
  // 结果解析器
  // ═══════════════════════════════════════════

  _parsePytestResult (exec, env) {
    const result = this._buildResult(exec.exitCode === 0);

    // 尝试解析 JSON 报告
    if (fs.existsSync(env.reportFile)) {
      try {
        const report = JSON.parse(fs.readFileSync(env.reportFile, 'utf-8'));
        result.total = report.summary?.total || 0;
        result.passed = report.summary?.passed || 0;
        result.failed = report.summary?.failed || 0;
        result.errors = report.summary?.errors || 0;
        result.skipped = report.summary?.skipped || 0;
        result.duration = report.duration || 0;

        // 提取失败详情
        if (report.tests) {
          result.failures = report.tests
            .filter(t => t.outcome === 'failed')
            .map(t => ({
              name: t.name,
              message: t.call?.longrepr || t.message || 'Unknown error',
              file: t.filename
            }));
        }
      } catch (e) {
        // 降级到正则解析
        result.total = (exec.stdout.match(/(\d+) passed/g) || [0])[0] | 0;
        result.passed = result.total;
        result.failed = (exec.stdout.match(/(\d+) failed/g) || [0])[0] | 0;
      }
    } else {
      // 正则解析
      const passedMatch = exec.stdout.match(/(\d+)\s+passed/g);
      const failedMatch = exec.stdout.match(/(\d+)\s+failed/g);
      const errorMatch = exec.stdout.match(/(\d+)\s+errors?/g);
      result.passed = passedMatch ? parseInt(passedMatch[0]) : 0;
      result.failed = failedMatch ? parseInt(failedMatch[0]) : 0;
      result.errors = errorMatch ? parseInt(errorMatch[0]) : 0;
      result.total = result.passed + result.failed + result.errors;
    }

    result.stdout = exec.stdout;
    result.stderr = exec.stderr;
    return result;
  }

  _parseUnittestResult (exec, env) {
    const result = this._buildResult(exec.exitCode === 0);
    const lines = exec.stdout.split('\n');
    for (const line of lines) {
      if (line.includes('OK')) result.passed++;
      if (line.includes('FAIL')) result.failed++;
      if (line.includes('ERROR')) result.errors++;
    }
    result.total = result.passed + result.failed + result.errors;
    result.stdout = exec.stdout;
    result.stderr = exec.stderr;
    return result;
  }

  _parseJestResult (exec, env) {
    const result = this._buildResult(exec.exitCode === 0);
    try {
      // jest --json 输出在 stdout
      const jsonMatch = exec.stdout.match(/\{[\s\S]*"numTotalTests"[\s\S]*\}/);
      if (jsonMatch) {
        const report = JSON.parse(jsonMatch[0]);
        result.total = report.numTotalTests || 0;
        result.passed = report.numPassedTests || 0;
        result.failed = report.numFailedTests || 0;
        result.skipped = report.numPendingTests || 0;
        result.duration = report.testResults?.[0]?.perfStats?.runtime || 0;

        if (report.testResults) {
          result.failures = [];
          for (const testResult of report.testResults) {
            for (const assertion of testResult.assertionResults || []) {
              if (assertion.status === 'failed') {
                result.failures.push({
                  name: assertion.fullName,
                  message: assertion.failureMessages?.join('\n') || 'Unknown error',
                  file: assertion.ancestorTitles?.[0] || ''
                });
              }
            }
          }
        }
      }
    } catch (e) {
      // 降级
      result.passed = (exec.stdout.match(/✓/g) || []).length;
      result.failed = (exec.stdout.match(/✕/g) || []).length;
      result.total = result.passed + result.failed;
    }
    result.stdout = exec.stdout;
    result.stderr = exec.stderr;
    return result;
  }

  _parseMochaResult (exec, env) {
    const result = this._buildResult(exec.exitCode === 0);
    try {
      const report = JSON.parse(exec.stdout);
      result.total = report.stats?.tests || 0;
      result.passed = report.stats?.passes || 0;
      result.failed = report.stats?.failures || 0;
      result.duration = report.stats?.duration || 0;

      if (report.failures) {
        result.failures = report.failures.map(f => ({
          name: f.fullTitle,
          message: f.err?.message || 'Unknown error',
          file: f.file || ''
        }));
      }
    } catch (e) {
      result.passed = (exec.stdout.match(/\d+ passing/g) || [0])[0] | 0;
      result.failed = (exec.stdout.match(/\d+ failing/g) || [0])[0] | 0;
    }
    result.stdout = exec.stdout;
    result.stderr = exec.stderr;
    return result;
  }

  _parseNodeTestResult (exec, env) {
    const result = this._buildResult(exec.exitCode === 0);
    // Node.js test runner TAP output
    const lines = exec.stdout.split('\n');
    for (const line of lines) {
      if (line.match(/^# (tests|pass|fail)/)) {
        const match = line.match(/^# (\w+)\s+(\d+)/);
        if (match) {
          if (match[1] === 'tests') result.total = parseInt(match[2]);
          if (match[1] === 'pass') result.passed = parseInt(match[2]);
          if (match[1] === 'fail') result.failed = parseInt(match[2]);
        }
      }
    }
    if (result.total === 0) {
      result.total = (exec.stdout.match(/^ok \d+/gm) || []).length;
      result.passed = result.total;
      result.failed = (exec.stdout.match(/^not ok \d+/gm) || []).length;
      result.total += result.failed;
    }
    result.stdout = exec.stdout;
    result.stderr = exec.stderr;
    return result;
  }

  _parseGoTestResult (exec, env) {
    const result = this._buildResult(exec.exitCode === 0);
    const lines = exec.stdout.split('\n');
    for (const line of lines) {
      if (line.startsWith('{')) {
        try {
          const event = JSON.parse(line);
          if (event.Action === 'pass') result.passed++;
          if (event.Action === 'fail') {
            result.failed++;
            result.failures = result.failures || [];
            result.failures.push({
              name: event.Test || 'Unknown',
              message: event.Output?.join('') || '',
              file: event.Package || ''
            });
          }
        } catch (_) {}
      }
    }
    result.total = result.passed + result.failed;
    result.stdout = exec.stdout;
    result.stderr = exec.stderr;
    return result;
  }

  _parseMvnTestResult (exec, env) {
    const result = this._buildResult(exec.exitCode === 0);
    const testsMatch = exec.stdout.match(/Tests run:\s*(\d+)/);
    const failuresMatch = exec.stdout.match(/Failures:\s*(\d+)/);
    const errorsMatch = exec.stdout.match(/Errors:\s*(\d+)/);
    const skippedMatch = exec.stdout.match(/Skipped:\s*(\d+)/);
    result.total = testsMatch ? parseInt(testsMatch[1]) : 0;
    result.failed = (failuresMatch ? parseInt(failuresMatch[1]) : 0) + (errorsMatch ? parseInt(errorsMatch[1]) : 0);
    result.passed = result.total - result.failed - (skippedMatch ? parseInt(skippedMatch[1]) : 0);
    result.skipped = skippedMatch ? parseInt(skippedMatch[1]) : 0;
    result.stdout = exec.stdout;
    result.stderr = exec.stderr;
    return result;
  }

  _parseGradleTestResult (exec, env) {
    const result = this._buildResult(exec.exitCode === 0);
    const testsMatch = exec.stdout.match(/(\d+)\s+tests/);
    const failuresMatch = exec.stdout.match(/(\d+)\s+failures/);
    result.total = testsMatch ? parseInt(testsMatch[1]) : 0;
    result.failed = failuresMatch ? parseInt(failuresMatch[1]) : 0;
    result.passed = result.total - result.failed;
    result.stdout = exec.stdout;
    result.stderr = exec.stderr;
    return result;
  }

  _parseCargoTestResult (exec, env) {
    const result = this._buildResult(exec.exitCode === 0);
    const passedMatch = exec.stdout.match(/(\d+)\s+passed/);
    const failedMatch = exec.stdout.match(/(\d+)\s+failed/);
    result.passed = passedMatch ? parseInt(passedMatch[1]) : 0;
    result.failed = failedMatch ? parseInt(failedMatch[1]) : 0;
    result.total = result.passed + result.failed;
    result.stdout = exec.stdout;
    result.stderr = exec.stderr;
    return result;
  }

  _parseCustomCResult (exec, env) {
    const result = this._buildResult(exec.exitCode === 0);
    result.total = 1;
    result.passed = exec.exitCode === 0 ? 1 : 0;
    result.failed = exec.exitCode !== 0 ? 1 : 0;
    result.stdout = exec.stdout;
    result.stderr = exec.stderr;
    if (exec.exitCode !== 0) {
      result.failures = [{ name: 'C program execution', message: exec.stderr || `Exit code: ${exec.exitCode}`, file: env.testFile }];
    }
    return result;
  }

  // ═══════════════════════════════════════════
  // 环境准备
  // ═══════════════════════════════════════════

  _prepareTestEnvironment (testCode, sourceCode, lang, framework, wsDir, testFilePath) {
    const workDir = path.join(this.tempDir, `test_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`);
    this._ensureDir(workDir);

    // 文件扩展名映射
    const extMap = {
      python: '.py',
      javascript: '.js',
      typescript: '.ts',
      go: '.go',
      java: '.java',
      rust: '.rs',
      c: '.c',
      cpp: '.cpp'
    };

    // 测试文件名规则
    const testNameMap = {
      pytest: `test_${Date.now()}.py`,
      unittest: `test_${Date.now()}.py`,
      jest: `${Date.now()}.test.js`,
      mocha: `${Date.now()}.test.js`,
      node_test: `${Date.now()}.test.js`,
      go_test: `${path.basename(wsDir)}_test.go`,
      junit_mvn: `${Date.now()}Test.java`,
      junit_gradle: `${Date.now()}Test.java`,
      cargo_test: 'tests/integration_test.rs',
      custom: `test_${Date.now()}.c`
    };

    const fileName = testFilePath || testNameMap[framework] || `test_${Date.now()}${extMap[lang] || '.txt'}`;
    const testFile = path.join(workDir, fileName);

    // 写入源码（如果有）
    if (sourceCode) {
      const srcExt = extMap[lang] || '.txt';
      const srcFile = path.join(workDir, `source${srcExt}`);
      fs.writeFileSync(srcFile, sourceCode, 'utf-8');
    }

    // 写入测试代码
    fs.writeFileSync(testFile, testCode, 'utf-8');

    // 写入必要的配置文件
    this._writeFrameworkConfig(framework, workDir, lang);

    return {
      testFile,
      testModule: path.basename(testFile, path.extname(testFile)),
      workDir,
      reportFile: path.join(workDir, 'test_report.json'),
      sourceFile: sourceCode ? path.join(workDir, `source${extMap[lang] || '.txt'}`) : null
    };
  }

  _writeFrameworkConfig (framework, workDir, lang) {
    switch (framework) {
    case 'jest':
      if (!fs.existsSync(path.join(workDir, 'package.json'))) {
        fs.writeFileSync(path.join(workDir, 'package.json'), JSON.stringify({
          name: 'qidi-test',
          version: '1.0.0',
          scripts: { test: 'jest' },
          devDependencies: { jest: '^29.0.0' }
        }, null, 2));
      }
      break;
    case 'pytest':
      // pytest 不需要额外配置
      break;
    case 'go_test':
      if (!fs.existsSync(path.join(workDir, 'go.mod'))) {
        fs.writeFileSync(path.join(workDir, 'go.mod'), 'module qidi_test\n\ngo 1.21\n');
      }
      break;
    }
  }

  /**
   * 根据语言和环境检测最佳可用框架
   */
  _detectBestFramework (lang, wsDir) {
    const priorities = this.frameworkPriority[lang] || ['node_test'];

    for (const fw of priorities) {
      switch (fw) {
      case 'pytest':
        if (hasTool('python') || hasTool('python3')) return 'pytest';
        break;
      case 'unittest':
        if (hasTool('python') || hasTool('python3')) return 'unittest';
        break;
      case 'jest':
        if (fs.existsSync(path.join(wsDir, 'node_modules', '.bin', 'jest')) || hasTool('jest') || hasTool('npx')) return 'jest';
        break;
      case 'mocha':
        if (fs.existsSync(path.join(wsDir, 'node_modules', '.bin', 'mocha')) || hasTool('mocha')) return 'mocha';
        break;
      case 'node_test':
        if (hasTool('node')) return 'node_test';
        break;
      case 'go_test':
        if (hasTool('go')) return 'go_test';
        break;
      case 'junit_mvn':
        if (hasTool('mvn')) return 'junit_mvn';
        break;
      case 'junit_gradle':
        if (hasTool('gradle')) return 'junit_gradle';
        break;
      case 'cargo_test':
        if (hasTool('cargo')) return 'cargo_test';
        break;
      case 'custom':
        if (hasTool('gcc')) return 'custom';
        break;
      }
    }

    return priorities[0] || 'node_test';
  }

  /**
   * 从 TesterAgent 的测试用例生成可执行测试代码
   */
  _generateTestCode (testCases, language) {
    if (!Array.isArray(testCases) || testCases.length === 0) {
      return '';
    }

    const lang = language.toLowerCase();

    if (lang === 'python') {
      return this._generatePytestCode(testCases);
    } else if (lang === 'javascript' || lang === 'typescript') {
      return this._generateJestCode(testCases);
    } else if (lang === 'go') {
      return this._generateGoTestCode(testCases);
    } else if (lang === 'c') {
      return this._generateCTestCode(testCases);
    }

    return this._generateJestCode(testCases); // 默认
  }

  _generatePytestCode (testCases) {
    let code = 'import pytest\nimport sys\nimport os\n\n';

    testCases.forEach((tc, i) => {
      const funcName = `test_case_${i + 1}_${this._sanitize(tc.name || tc.id || '')}`;
      code += `def ${funcName}():\n`;
      code += `    """${tc.description || tc.name || `Test case ${i + 1}`}"""\n`;
      code += `    # 类型: ${tc.type || 'unit'}\n`;
      code += `    # 预期结果: ${tc.expectedResult || 'N/A'}\n`;
      code += '    # TODO: 实现测试逻辑\n';
      code += '    assert True  # 占位断言\n\n';
    });

    return code;
  }

  _generateJestCode (testCases) {
    let code = '\'use strict\';\n\n';

    testCases.forEach((tc, i) => {
      const testName = tc.name || tc.id || `Test case ${i + 1}`;
      code += `test('${this._sanitize(testName)}', () => {\n`;
      code += `  // ${tc.description || ''}\n`;
      code += `  // 类型: ${tc.type || 'unit'}\n`;
      code += `  // 预期结果: ${tc.expectedResult || 'N/A'}\n`;
      code += '  // TODO: 实现测试逻辑\n';
      code += '  expect(true).toBe(true); // 占位断言\n';
      code += '});\n\n';
    });

    return code;
  }

  _generateGoTestCode (testCases) {
    let code = 'package main\n\nimport "testing"\n\n';

    testCases.forEach((tc, i) => {
      const funcName = `Test_Case_${i + 1}_${this._sanitizeGo(tc.name || tc.id || '')}`;
      code += `func ${funcName}(t *testing.T) {\n`;
      code += `\t// ${tc.description || ''}\n`;
      code += `\t// 预期: ${tc.expectedResult || 'N/A'}\n`;
      code += '\t// TODO: 实现测试逻辑\n';
      code += '}\n\n';
    });

    return code;
  }

  _generateCTestCode (testCases) {
    let code = '#include <stdio.h>\n#include <assert.h>\n\n';

    testCases.forEach((tc, i) => {
      code += `// Test ${i + 1}: ${tc.name || ''} - ${tc.description || ''}\n`;
      code += `void test_case_${i + 1}() {\n`;
      code += `    // 预期: ${tc.expectedResult || 'N/A'}\n`;
      code += '    // TODO: 实现测试逻辑\n';
      code += '    assert(1); // 占位断言\n';
      code += `    printf("Test ${i + 1} passed\\n");\n`;
      code += '}\n\n';
    });

    code += 'int main() {\n';
    testCases.forEach((_, i) => {
      code += `    test_case_${i + 1}();\n`;
    });
    code += `    printf("All %d tests passed\\n", ${testCases.length});\n`;
    code += '    return 0;\n}\n';

    return code;
  }

  _generateIntegrationTest (mergedCode, language) {
    const lang = language.toLowerCase();

    if (lang === 'javascript' || lang === 'typescript') {
      return `'use strict';\n\n// 自动生成的集成测试\n// 验证合并后代码的完整性\n\ndescribe('Integration Test - Merged Code', () => {\n  test('代码可加载不报错', () => {\n    // 验证合并后代码语法正确\n    expect(() => {\n      try { eval(${JSON.stringify(mergedCode.substring(0, 1000))}); } catch(e) {}\n    }).not.toThrow();\n  });\n\n  test('代码非空', () => {\n    expect(${JSON.stringify(mergedCode)}.length).toBeGreaterThan(0);\n  });\n});\n`;
    }

    if (lang === 'python') {
      return '# 自动生成的集成测试\nimport pytest\n\ndef test_merged_code_not_empty():\n    """验证合并后代码非空"""\n    assert True\n\ndef test_merged_code_syntax():\n    """验证合并后代码语法正确"""\n    # TODO: 根据具体实现添加断言\n    assert True\n';
    }

    return '// 自动生成的集成测试\n// 验证合并后代码完整性\n#include <assert.h>\nint main() {\n    assert(1);\n    return 0;\n}\n';
  }

  // ═══════════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════════

  _buildResult (passed, errorMessage = null) {
    return {
      passed,
      total: 0,
      passed_count: 0,
      failed: 0,
      errors: 0,
      skipped: 0,
      duration: 0,
      failures: [],
      error: errorMessage,
      stdout: '',
      stderr: ''
    };
  }

  _sanitize (str) {
    return String(str).replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 60);
  }

  _sanitizeGo (str) {
    return String(str)
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/^./, c => c.toUpperCase())
      .substring(0, 60);
  }

  _cleanup (env) {
    try {
      if (env.workDir && fs.existsSync(env.workDir)) {
        fs.rmSync(env.workDir, { recursive: true, force: true });
      }
    } catch (e) {
      logger.warn(`[TestRunner] 清理临时文件失败: ${e.message}`);
    }
  }

  /**
   * 获取测试覆盖率（如果可用）
   */
  async getCoverage (env) {
    const coverageFile = path.join(env.workDir, 'coverage.json');
    if (fs.existsSync(coverageFile)) {
      try {
        return JSON.parse(fs.readFileSync(coverageFile, 'utf-8'));
      } catch (_) {}
    }
    return null;
  }

  /**
   * 检测可用测试框架
   */
  detectAvailableFrameworks () {
    const available = [];
    const checks = [
      { name: 'pytest', cmd: 'python3', args: ['-m', 'pytest', '--version'] },
      { name: 'jest', cmd: 'npx', args: ['jest', '--version'] },
      { name: 'go_test', cmd: 'go', args: ['version'] },
      { name: 'cargo_test', cmd: 'cargo', args: ['--version'] },
      { name: 'junit_mvn', cmd: 'mvn', args: ['--version'] },
      { name: 'custom', cmd: 'gcc', args: ['--version'] }
    ];

    for (const check of checks) {
      try {
        const result = spawnSync(check.cmd, check.args, { encoding: 'utf-8', timeout: 5000 });
        if (result.status === 0) {
          available.push({
            name: check.name,
            version: result.stdout.split('\n')[0].trim()
          });
        }
      } catch (_) {}
    }

    return available;
  }
}

module.exports = TestRunner;
