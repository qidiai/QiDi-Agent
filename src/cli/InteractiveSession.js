'use strict';

/**
 * InteractiveSession — 启迪 Agent 交互式编程会话
 *
 * 在原有 readline REPL 基础上完善：
 *  - 多行输入（空行结束 / .submit 强制结束 / Shift+Enter 换行通过粘贴实现）
 *  - 命令历史持久化（~/.qidi/history）
 *  - 上下文记忆（最近任务、最近报告、最近错误）
 *  - 快捷命令（h/h、cls、h、ctx、wf、report、tools ...）
 *  - 任务实时进度条
 *  - 任务产出文件预览
 *  - 软中断 Ctrl+C 优雅退出（不打断主进程）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const chalk = require('chalk');
const ora = require('ora');

const ProviderFactory = require('../providers');
const TaskOrchestrator = require('../core/TaskOrchestrator');
const ToolScanner = require('../core/ToolScanner');
const AdapterFactory = require('../adapters');
const FileManager = require('../utils/FileManager');
const { miniLogo } = require('./logo');

class InteractiveSession {
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir || './workspace';
    this.configDir = options.configDir || path.join(__dirname, '../../config');
    this.defaultMode = options.mode || 'privacy';
    this.defaultProvider = options.provider || process.env.MODEL_PROVIDER || 'ollama';

    this.mode = this.defaultMode;
    this.registeredTools = [];
    this.toolScanner = null;
    this.provider = null;
    this.scanned = false;

    // 上下文记忆
    this.history = [];          // 命令历史（运行时）
    this.recentTasks = [];      // 最近任务 [{task, success, ts}]
    this.recentReportIds = [];  // 最近报告 ID
    this.lastError = null;
    this.lastResult = null;

    // 多行输入缓冲
    this._multilineBuffer = [];
    this._multilineMode = false;

    // 持久化目录
    this._qidiHome = path.join(os.homedir(), '.qidi');
    this._historyFile = path.join(this._qidiHome, 'history');
    this._ctxFile = path.join(this._qidiHome, 'session.json');

    // 当前运行中的 spinner / 进度
    this._activeSpinner = null;

    this._ensureDirs();
  }

  // ───────────────────────── 初始化 ─────────────────────────

  _ensureDirs() {
    try {
      if (!fs.existsSync(this._qidiHome)) fs.mkdirSync(this._qidiHome, { recursive: true });
      if (!fs.existsSync(this.workspaceDir)) fs.mkdirSync(this.workspaceDir, { recursive: true });
    } catch (_) { /* ignore */ }
  }

  _loadHistory() {
    try {
      if (fs.existsSync(this._historyFile)) {
        this.history = JSON.parse(fs.readFileSync(this._historyFile, 'utf-8')) || [];
      }
    } catch (_) { this.history = []; }
  }

  _saveHistory() {
    try {
      // 最多保留 200 条
      const trimmed = this.history.slice(-200);
      fs.writeFileSync(this._historyFile, JSON.stringify(trimmed, null, 2), 'utf-8');
    } catch (_) { /* ignore */ }
  }

  _loadContext() {
    try {
      if (fs.existsSync(this._ctxFile)) {
        const ctx = JSON.parse(fs.readFileSync(this._ctxFile, 'utf-8'));
        this.recentTasks = ctx.recentTasks || [];
        this.recentReportIds = ctx.recentReportIds || [];
      }
    } catch (_) { /* ignore */ }
  }

  _saveContext() {
    try {
      fs.writeFileSync(this._ctxFile, JSON.stringify({
        recentTasks: this.recentTasks.slice(-20),
        recentReportIds: this.recentReportIds.slice(-20),
        savedAt: Date.now()
      }, null, 2), 'utf-8');
    } catch (_) { /* ignore */ }
  }

  // ───────────────────────── 启动 ─────────────────────────

  async start() {
    console.log(miniLogo);
    console.log(chalk.cyan.bold('\n  🚀 Qidi Agent 交互式编程界面'));
    console.log(chalk.gray('  ─────────────────────────────────────────'));
    console.log(chalk.gray('  多行任务：直接回车结束，或在末尾输入 ; 提交多行任务'));
    console.log(chalk.gray('  输入 help 查看命令，exit 退出，Ctrl+C 退出\n'));

    this._loadHistory();
    this._loadContext();
    this._printContextResume();

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.green.bold('\n  qidi> '),
      completer: (line) => this._completer(line),
      history: this.history.slice(-100).reverse()
    });

    // 软中断：第一次 Ctrl+C 取消当前输入；第二次退出
    this.rl.on('SIGINT', () => {
      if (this._activeSpinner) {
        this._activeSpinner.fail('已取消');
        this._activeSpinner = null;
      }
      this._multilineBuffer = [];
      this._multilineMode = false;
      this.rl.setPrompt(chalk.green.bold('\n  qidi> '));
      console.log(chalk.yellow('\n  (输入 exit 退出，或按 Ctrl+C 两次)'));
      this.rl.prompt();
    });

    this.rl.on('line', (input) => this._onLine(input));
    this.rl.on('close', () => this._onClose());

    this.rl.prompt();
  }

  _printContextResume() {
    if (this.recentTasks.length === 0 && this.recentReportIds.length === 0) {
      console.log(chalk.gray('  📭 暂无历史记忆\n'));
      return;
    }
    console.log(chalk.cyan('  📚 上下文记忆:'));
    if (this.recentTasks.length > 0) {
      const last = this.recentTasks[this.recentTasks.length - 1];
      const ok = last.success ? chalk.green('✅') : chalk.red('❌');
      console.log(chalk.gray(`     最近任务: ${ok} "${last.task.slice(0, 50)}" (${new Date(last.ts).toLocaleString()})`));
    }
    if (this.recentReportIds.length > 0) {
      console.log(chalk.gray(`     最近报告: ${this.recentReportIds.slice(-3).join(', ')}`));
    }
    console.log('');
  }

  // ───────────────────────── Tab 补全 ─────────────────────────

  _completer(line) {
    const commands = [
      'help', 'exit', 'quit', 'clear', 'cls',
      'scan', 'status', 'tools', 'mode', 'provider',
      'run', 'tasks', 'files', 'file', 'view', 'cat',
      'report', 'reports', 'context', 'ctx',
      'ls', 'pwd', 'reset', 'history'
    ];
    const hits = commands.filter(c => c.startsWith(line.trim().toLowerCase()));
    return [hits.length ? hits : [], line];
  }

  // ───────────────────────── 输入处理 ─────────────────────────

  async _onLine(input) {
    const raw = input;
    const trimmed = raw.trim();

    // 多行输入模式：以 ; 结尾或者空行提交
    if (this._multilineMode) {
      if (trimmed === '' || trimmed === '.submit' || trimmed === ';') {
        const task = this._multilineBuffer.join('\n').trim();
        this._multilineBuffer = [];
        this._multilineMode = false;
        this.rl.setPrompt(chalk.green.bold('\n  qidi> '));
        if (task) await this._runTask(task);
      } else if (trimmed === '.cancel') {
        this._multilineBuffer = [];
        this._multilineMode = false;
        this.rl.setPrompt(chalk.green.bold('\n  qidi> '));
        console.log(chalk.yellow('  已取消多行输入'));
      } else {
        this._multilineBuffer.push(raw);
        this.rl.setPrompt(chalk.gray.bold('  ...> '));
      }
      this._pushHistory(raw);
      this.rl.prompt();
      return;
    }

    if (trimmed === '') {
      this.rl.prompt();
      return;
    }

    this._pushHistory(raw);
    await this._dispatch(trimmed);
    this.rl.prompt();
  }

  _pushHistory(line) {
    if (!line || line.trim() === '') return;
    // 去重最近一条
    if (this.history[this.history.length - 1] !== line) {
      this.history.push(line);
    }
    this._saveHistory();
  }

  _onClose() {
    this._saveContext();
    console.log(chalk.yellow('\n  👋 已保存上下文，再见！\n'));
    process.exit(0);
  }

  // ───────────────────────── 命令分发 ─────────────────────────

  async _dispatch(input) {
    const [cmd, ...args] = input.split(/\s+/);
    const c = cmd.toLowerCase();

    switch (c) {
      case 'exit':
      case 'quit':
      case 'q':
        this._onClose();
        return;

      case 'help':
      case 'h':
      case '?':
        this._printHelp();
        return;

      case 'clear':
      case 'cls':
        console.clear && console.clear();
        return;

      case 'history':
        this._printHistory();
        return;

      case 'scan':
        await this._cmdScan(args);
        return;

      case 'status':
        this._cmdStatus();
        return;

      case 'tools':
        this._cmdTools();
        return;

      case 'mode':
        this._cmdMode(args);
        return;

      case 'provider':
        this._cmdProvider(args);
        return;

      case 'tasks':
        this._printRecentTasks();
        return;

      case 'context':
      case 'ctx':
        this._printContextResume();
        return;

      case 'reports':
        this._printReportIds();
        return;

      case 'report':
        await this._cmdReport(args);
        return;

      case 'ls':
      case 'files':
      case 'list':
        await this._cmdLs(args);
        return;

      case 'view':
      case 'cat':
      case 'file':
        await this._cmdView(args);
        return;

      case 'pwd':
        console.log(chalk.gray('  ' + path.resolve(this.workspaceDir)));
        return;

      case 'reset':
        this.recentTasks = [];
        this.recentReportIds = [];
        this.lastError = null;
        this.lastResult = null;
        this._saveContext();
        console.log(chalk.green('  ✅ 已重置上下文记忆'));
        return;

      case 'run':
        // run <task...>
        if (args.length > 0) {
          await this._runTask(args.join(' '));
        } else {
          console.log(chalk.gray('  用法: run <任务描述>，或直接输入任务描述'));
        }
        return;

      default:
        // 不是已知命令 → 视为任务描述
        await this._runTask(input);
    }
  }

  // ───────────────────────── 帮助 ─────────────────────────

  _printHelp() {
    console.log(chalk.cyan('\n  📖 命令帮助\n'));
    const rows = [
      ['scan',              '扫描并接入本机 AI 编程工具'],
      ['tools',             '查看已接入工具'],
      ['status',            '查看当前状态'],
      ['mode privacy|quality', '切换执行模式'],
      ['provider ollama|openai|anthropic', '切换默认模型提供商'],
      ['<任务描述>',        '直接执行编程任务'],
      ['run <任务描述>',    '同上（显式）'],
      ['tasks',             '查看最近任务历史'],
      ['reports',           '查看最近报告 ID'],
      ['report <id>',       '查看报告内容'],
      ['context / ctx',     '查看上下文记忆'],
      ['ls [dir] [depth]',  '列出工作目录文件'],
      ['view <path>',       '查看工作目录中的文件'],
      ['pwd',               '显示当前工作目录'],
      ['history',           '查看命令历史'],
      ['reset',             '重置上下文记忆'],
      ['clear / cls',       '清屏'],
      ['help / h / ?',      '显示本帮助'],
      ['exit / quit / q',   '退出']
    ];
    for (const [cmd, desc] of rows) {
      console.log('  ' + chalk.green(cmd.padEnd(34)) + chalk.gray(desc));
    }
    console.log(chalk.gray('\n  多行任务：在末尾加 ; 触发多行模式，空行或 ; 提交，.cancel 取消\n'));
  }

  _printHistory() {
    if (this.history.length === 0) {
      console.log(chalk.gray('  📭 暂无历史'));
      return;
    }
    console.log(chalk.cyan('\n  📜 命令历史:\n'));
    const start = Math.max(0, this.history.length - 30);
    for (let i = start; i < this.history.length; i++) {
      console.log(chalk.gray(`  ${String(i + 1).padStart(3)}  ${this.history[i]}`));
    }
    console.log('');
  }

  // ───────────────────────── 状态命令 ─────────────────────────

  _cmdStatus() {
    console.log(chalk.cyan('\n  📊 当前状态:\n'));
    console.log(chalk.gray(`  执行模式: ${this.mode === 'privacy' ? '🔒 隐私模式' : '✨ 高质量模式'}`));
    console.log(chalk.gray(`  提供商  : ${this.provider ? this.provider.name : this.defaultProvider + ' (未连接)'}`));
    console.log(chalk.gray(`  工具    : ${this.scanned ? `${this.registeredTools.length} 个已接入` : '未扫描 (输入 scan)'}`));
    console.log(chalk.gray(`  工作目录: ${path.resolve(this.workspaceDir)}`));
    console.log(chalk.gray(`  任务记忆: ${this.recentTasks.length} 条，报告 ${this.recentReportIds.length} 个`));
    console.log('');
  }

  _cmdTools() {
    if (!this.scanned) {
      console.log(chalk.yellow('  ⚠️ 请先运行 scan'));
      return;
    }
    if (this.registeredTools.length === 0) {
      console.log(chalk.yellow('  ⚠️ 暂无已接入工具'));
      return;
    }
    console.log(chalk.cyan('\n  🔧 已接入工具:\n'));
    for (const t of this.registeredTools) {
      console.log(chalk.green(`  ✅ ${t.displayName}`));
    }
    console.log('');
  }

  _cmdMode(args) {
    const m = args[0];
    if (m === 'privacy' || m === 'quality') {
      this.mode = m;
      console.log(chalk.green(`\n  ✅ 已切换到 ${m === 'privacy' ? '🔒 隐私模式' : '✨ 高质量模式'}\n`));
    } else {
      console.log(chalk.yellow(`\n  ⚠️ 无效模式，可选: privacy | quality (当前: ${this.mode})\n`));
    }
  }

  _cmdProvider(args) {
    const p = args[0];
    if (!p) {
      console.log(chalk.gray(`\n  当前提供商: ${this.defaultProvider}\n`));
      return;
    }
    try {
      // 仅验证可创建
      ProviderFactory.create(p);
      this.defaultProvider = p;
      this.provider = null; // 触发下次重连
      console.log(chalk.green(`\n  ✅ 默认提供商已切换为 ${p}\n`));
    } catch (e) {
      console.log(chalk.red(`\n  ❌ 无效提供商: ${e.message}\n`));
    }
  }

  _printRecentTasks() {
    if (this.recentTasks.length === 0) {
      console.log(chalk.gray('  📭 暂无任务记忆'));
      return;
    }
    console.log(chalk.cyan('\n  📋 最近任务:\n'));
    const start = Math.max(0, this.recentTasks.length - 10);
    for (let i = start; i < this.recentTasks.length; i++) {
      const t = this.recentTasks[i];
      const ok = t.success ? chalk.green('✅') : chalk.red('❌');
      const date = new Date(t.ts).toLocaleString();
      console.log(`  ${ok} ${chalk.gray(date)} ${chalk.cyan(t.task.slice(0, 60))}`);
      if (t.reportId) console.log(chalk.gray(`       报告: ${t.reportId}`));
    }
    console.log('');
  }

  _printReportIds() {
    if (this.recentReportIds.length === 0) {
      console.log(chalk.gray('  📭 暂无报告记忆'));
      return;
    }
    console.log(chalk.cyan('\n  📋 最近报告 ID:\n'));
    const start = Math.max(0, this.recentReportIds.length - 10);
    for (let i = start; i < this.recentReportIds.length; i++) {
      console.log(chalk.gray(`  ${i + 1}. ${this.recentReportIds[i]}`));
    }
    console.log('');
  }

  async _cmdReport(args) {
    if (args.length === 0) {
      console.log(chalk.gray('  用法: report <id>'));
      return;
    }
    const id = args[0];
    try {
      const orch = new TaskOrchestrator(null, { workspaceDir: this.workspaceDir });
      const report = orch.loadReport(id);
      if (!report) {
        console.log(chalk.red(`  ❌ 报告 ${id} 不存在`));
        return;
      }
      console.log(chalk.cyan(`\n  📄 报告 ${id}:\n`));
      console.log(report.content || JSON.stringify(report, null, 2));
      console.log('');
    } catch (e) {
      console.log(chalk.red(`  ❌ 加载报告失败: ${e.message}`));
    }
  }

  async _cmdLs(args) {
    const sub = args[0] || '.';
    const depth = parseInt(args[1] || '2', 10);
    try {
      const fm = new FileManager(this.workspaceDir);
      const tree = fm.getFileTree(sub, depth);
      console.log(chalk.cyan(`\n  📁 ${sub} (depth=${depth}):\n`));
      console.log(tree || chalk.gray('  (空)'));
      console.log('');
    } catch (e) {
      console.log(chalk.red(`  ❌ ${e.message}`));
    }
  }

  async _cmdView(args) {
    if (args.length === 0) {
      console.log(chalk.gray('  用法: view <相对路径>'));
      return;
    }
    const rel = args[0];
    try {
      const fm = new FileManager(this.workspaceDir);
      const content = fm.readFile(rel);
      if (content === null) {
        console.log(chalk.red(`  ❌ 文件不存在: ${rel}`));
        return;
      }
      const lines = content.split('\n');
      const total = lines.length;
      const max = 200;
      console.log(chalk.cyan(`\n  📄 ${rel} (${total} 行${total > max ? `, 仅显示前 ${max} 行` : ''}):\n`));
      const shown = lines.slice(0, max);
      shown.forEach((l, i) => {
        console.log(chalk.gray(String(i + 1).padStart(4, ' ') + ' │ ') + l);
      });
      if (total > max) {
        console.log(chalk.gray(`\n  ... 还有 ${total - max} 行未显示`));
      }
      console.log('');
    } catch (e) {
      console.log(chalk.red(`  ❌ ${e.message}`));
    }
  }

  // ───────────────────────── 扫描 ─────────────────────────

  async _cmdScan() {
    const spinner = ora('  🔍 扫描本机 AI 编程工具...').start();
    try {
      this.toolScanner = new ToolScanner();
      this.toolScanner.registerAdapters(AdapterFactory.createAll());
      await this.toolScanner.scan();
      await this.toolScanner.connectAll();
      this.registeredTools = Array.from(this.toolScanner.registeredTools.values());
      this.scanned = true;
      spinner.succeed(`  ✅ 已接入 ${this.registeredTools.length} 个工具`);
      for (const t of this.registeredTools) {
        console.log(chalk.green(`     ✅ ${t.displayName}`));
      }
    } catch (e) {
      spinner.fail(`  扫描失败: ${e.message}`);
    }
  }

  // ───────────────────────── 执行任务 ─────────────────────────

  async _ensureProvider() {
    if (this.provider) return this.provider;
    const spinner = ora(`  🔗 连接提供商 ${this.defaultProvider}...`).start();
    try {
      this.provider = ProviderFactory.create(this.defaultProvider);
      const ok = await this.provider.checkConnection();
      if (ok) {
        spinner.succeed(`  ✅ ${this.provider.name} 已连接`);
        return this.provider;
      }
      spinner.fail(`  ❌ ${this.defaultProvider} 无法连接`);
      this.provider = null;
      console.log(chalk.yellow('  💡 提示:'));
      console.log(chalk.yellow('     - Ollama: ollama serve && ollama pull qwen2.5:7b'));
      console.log(chalk.yellow('     - 或配置 OpenAI API Key'));
      return null;
    } catch (e) {
      spinner.fail(`  连接失败: ${e.message}`);
      this.provider = null;
      return null;
    }
  }

  async _runTask(taskDescription) {
    if (!taskDescription || taskDescription.length === 0) return;

    // 触发多行模式：以 ; 结尾且长度 > 1
    if (taskDescription.endsWith(';') && taskDescription.trim().length > 1) {
      this._multilineMode = true;
      this._multilineBuffer = [taskDescription.slice(0, -1)];
      this.rl.setPrompt(chalk.gray.bold('  ...> '));
      console.log(chalk.gray('  进入多行模式，空行或 ; 提交，.cancel 取消'));
      return;
    }

    const provider = await this._ensureProvider();
    if (!provider) return;

    if (!this.scanned) {
      // 自动扫描一次（静默）
      try {
        this.toolScanner = new ToolScanner();
        this.toolScanner.registerAdapters(AdapterFactory.createAll());
        await this.toolScanner.scan();
        await this.toolScanner.connectAll();
        this.registeredTools = Array.from(this.toolScanner.registeredTools.values());
        this.scanned = true;
        if (this.registeredTools.length > 0) {
          console.log(chalk.gray(`  🔧 已自动接入 ${this.registeredTools.length} 个工具`));
        }
      } catch (_) { /* ignore */ }
    }

    const modeLabel = this.mode === 'privacy' ? '🔒 隐私模式' : '✨ 高质量模式';
    console.log(chalk.cyan(`\n  🚀 开始执行 (${modeLabel})\n`));

    this._activeSpinner = ora('  正在处理任务...').start();
    let progressMsg = '初始化';
    const progressTimer = setInterval(() => {
      if (this._activeSpinner) {
        this._activeSpinner.text = `  ${progressMsg}...`;
      }
    }, 800);

    try {
      const orchestrator = new TaskOrchestrator(provider, {
        workspaceDir: this.workspaceDir,
        toolAdapters: this.registeredTools,
        executionMode: this.mode
      });
      orchestrator.setExecutionMode(this.mode);

      // 订阅事件用于进度提示
      orchestrator.on('splitting', () => { progressMsg = '拆分任务'; });
      orchestrator.on('taskSplit', (d) => { progressMsg = `拆分完成: ${d.tasks.length} 个子任务`; });
      orchestrator.on('taskStart_sub', (d) => { progressMsg = `执行子任务 ${d.index + 1}/${d.total}`; });
      orchestrator.on('taskComplete_sub', () => { progressMsg = '子任务完成'; });
      orchestrator.on('reportGenerated', (d) => {
        if (d.reportId) this.recentReportIds.push(d.reportId);
      });

      await orchestrator.initialize();
      const result = await orchestrator.runTask(taskDescription);

      clearInterval(progressTimer);
      if (this._activeSpinner) {
        this._activeSpinner.succeed('  任务完成！');
        this._activeSpinner = null;
      }

      this.lastResult = result;
      this.recentTasks.push({
        task: taskDescription,
        success: result.successRate === 100,
        successRate: result.successRate,
        outputDir: result.outputDir,
        reportId: result.reportId,
        ts: Date.now()
      });
      this._saveContext();

      // 打印简要总结
      this._printTaskSummary(result);

      // 预览生成文件
      this._previewOutputFiles(result.outputDir);
    } catch (e) {
      clearInterval(progressTimer);
      if (this._activeSpinner) {
        this._activeSpinner.fail(`  任务失败: ${e.message}`);
        this._activeSpinner = null;
      }
      this.lastError = e.message;
      this.recentTasks.push({
        task: taskDescription,
        success: false,
        error: e.message,
        ts: Date.now()
      });
      this._saveContext();
    }
  }

  _printTaskSummary(result) {
    console.log(chalk.cyan('\n  ═══ 任务总结 ═══'));
    console.log(`  ${chalk.bold('成功率')}: ${result.successRate}% (${result.completedTasks}/${result.totalTasks})`);
    if (result.outputDir) console.log(`  ${chalk.bold('输出目录')}: ${chalk.gray(result.outputDir)}`);
    if (result.reportId) {
      console.log(`  ${chalk.bold('报告 ID')}: ${chalk.cyan(result.reportId)}`);
      console.log(chalk.gray(`  查看报告: report ${result.reportId}`));
    }
    if (result.tasks && result.tasks.length > 0) {
      console.log(chalk.gray('  子任务:'));
      for (const t of result.tasks) {
        const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '⏳';
        const score = t.qualityScore ? ` [${t.qualityScore}]` : '';
        console.log(`    ${icon} ${t.id} ${t.title}${score}`);
      }
    }
    console.log('');
  }

  _previewOutputFiles(outputDir) {
    if (!outputDir) return;
    try {
      const fm = new FileManager(outputDir);
      const files = fm.listFiles('.', /\.(js|py|ts|c|cpp|java|go|md|txt|json)$/i).slice(0, 8);
      if (files.length === 0) return;
      console.log(chalk.cyan('  📁 产出文件 (预览):'));
      for (const f of files) {
        const full = path.resolve(outputDir, f);
        const stat = fs.statSync(full);
        const size = this._fmtSize(stat.size);
        console.log(chalk.gray(`    📄 ${f} (${size})`));
      }
      console.log(chalk.gray('  输入 view <路径> 查看内容\n'));
    } catch (_) { /* ignore */ }
  }

  _fmtSize(bytes) {
    if (!bytes) return '0B';
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return bytes + 'B';
  }
}

module.exports = InteractiveSession;
