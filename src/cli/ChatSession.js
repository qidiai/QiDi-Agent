'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const chalk = require('chalk');
const ora = require('ora');
const { safeJsonParse } = require('../utils/SafeParser');

const ProviderFactory = require('../providers');
const ToolScanner = require('../core/ToolScanner');
const AdapterFactory = require('../adapters');
const FileManager = require('../utils/FileManager');
const ConfigManager = require('./ConfigManager');

class ChatSession {
  constructor (options = {}) {
    this.workspaceDir = options.workspaceDir || './workspace';
    this.mode = options.mode || 'privacy';
    this.provider = options.provider || process.env.MODEL_PROVIDER || 'ollama';
    this.selectedModel = options.model || '';

    this.configManager = new ConfigManager();
    this.chatHistory = [];
    this.commandHistory = [];
    this.providerInstance = null;
    this.registeredTools = [];
    this.toolScanner = null;
    this.scanned = false;

    this._qidiHome = path.join(os.homedir(), '.qidi');
    this._historyFile = path.join(this._qidiHome, 'chat_history.json');
    this._ensureDirs();
    this._loadHistory();
  }

  _ensureDirs () {
    if (!fs.existsSync(this._qidiHome)) fs.mkdirSync(this._qidiHome, { recursive: true });
    if (!fs.existsSync(this.workspaceDir)) fs.mkdirSync(this.workspaceDir, { recursive: true });
  }

  _loadHistory () {
    try {
      if (fs.existsSync(this._historyFile)) {
        this.chatHistory = safeJsonParse(fs.readFileSync(this._historyFile, 'utf-8'), []).slice(-50);
      }
    } catch (_) {
      this.chatHistory = [];
    }
  }

  _saveHistory () {
    try {
      fs.writeFileSync(this._historyFile, JSON.stringify(this.chatHistory.slice(-50), null, 2), 'utf-8');
    } catch (_) { /* ignore */ }
  }

  async start () {
    console.log(chalk.cyan.bold('\n╔══════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan.bold('║       Qidi Agent Chat - 聊天式编程助手              ║'));
    console.log(chalk.cyan.bold('╚══════════════════════════════════════════════════════╝'));
    console.log(chalk.gray('\n  💬 输入消息开始聊天，使用 /help 查看命令'));
    console.log(chalk.gray('  📁 当前工作目录: ' + path.resolve(this.workspaceDir)));
    console.log(chalk.gray('  🚀 直接输入任务描述即可执行编程任务\n'));

    await this._ensureProvider();
    await this._autoScanTools();

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '',
      completer: (line) => this._completer(line),
      history: this.commandHistory.slice(-100)
    });

    this.rl.on('SIGINT', () => {
      console.log(chalk.yellow('\n  (输入 /exit 退出)'));
      this._showPrompt();
    });

    this.rl.on('line', (input) => this._onLine(input));
    this.rl.on('close', () => this._onClose());

    this._showPrompt();
  }

  _showPrompt () {
    this.rl.setPrompt(chalk.green.bold('\n  You: '));
    this.rl.prompt(true);
  }

  async _ensureProvider () {
    try {
      this.providerInstance = ProviderFactory.create(this.provider);
      const ok = await this.providerInstance.checkConnection();
      if (ok) {
        console.log(chalk.green('  ✅ ' + this.providerInstance.name + ' 已连接'));
      } else {
        console.log(chalk.yellow('  ⚠️ ' + this.provider + ' 连接失败，将使用默认配置'));
      }
    } catch (e) {
      console.log(chalk.yellow('  ⚠️ 提供商初始化失败: ' + e.message));
    }
  }

  async _autoScanTools () {
    try {
      this.toolScanner = new ToolScanner();
      this.toolScanner.registerAdapters(AdapterFactory.createAll());
      await this.toolScanner.scan();
      this.registeredTools = this.toolScanner.adapters.filter(a => a.detected);
      this.scanned = true;
      if (this.registeredTools.length > 0) {
        console.log(chalk.gray('  🔧 发现 ' + this.registeredTools.length + ' 个工具（使用 /scan 连接）'));
      }
    } catch (_) { /* ignore */ }
  }

  _completer (line) {
    const commands = [
      '/help', '/exit', '/quit', '/clear', '/cls',
      '/scan', '/tools', '/status', '/mode', '/provider',
      '/run', '/tasks', '/ls', '/view', '/cat', '/edit',
      '/report', '/reports', '/context', '/history',
      '/pwd', '/reset', '/config', '/find', '/grep',
      '/mkdir', '/touch', '/rm', '/cd', '/rename'
    ];
    const hits = commands.filter(c => c.startsWith(line.trim().toLowerCase()));
    return [hits.length ? hits : [], line];
  }

  async _onLine (input) {
    const raw = input;
    const trimmed = raw.trim();

    if (trimmed === '') {
      this._showPrompt();
      return;
    }

    this.commandHistory.push(trimmed);
    await this._dispatch(trimmed);
  }

  _onClose () {
    this._saveHistory();
    console.log(chalk.yellow('\n  👋 再见！\n'));
    process.exit(0);
  }

  async _dispatch (input) {
    if (input.startsWith('/')) {
      await this._handleCommand(input.slice(1));
      return;
    }

    await this._handleChat(input);
  }

  async _handleCommand (cmdStr) {
    const [cmd, ...args] = cmdStr.split(/\s+/);
    const c = cmd.toLowerCase();

    switch (c) {
    case 'exit':
    case 'quit':
      this._onClose();
      return;

    case 'help':
      this._printHelp();
      break;

    case 'clear':
    case 'cls':
      console.clear && console.clear();
      break;

    case 'history':
      this._printHistory();
      break;

    case 'scan':
      await this._cmdScan();
      break;

    case 'tools':
      this._cmdTools();
      break;

    case 'status':
      this._cmdStatus();
      break;

    case 'mode':
      this._cmdMode(args);
      break;

    case 'provider':
      await this._cmdProvider(args);
      break;

    case 'ls':
      await this._cmdLs(args);
      break;

    case 'view':
    case 'cat':
      await this._cmdView(args);
      break;

    case 'pwd':
      console.log(chalk.gray('  ' + path.resolve(this.workspaceDir)));
      break;

    case 'run':
      await this._runTask(args.join(' '));
      break;

    case 'tasks':
      this._printRecentTasks();
      break;

    case 'reports':
      this._printReports();
      break;

    case 'report':
      await this._cmdReport(args);
      break;

    case 'context':
      this._printContext();
      break;

    case 'reset':
      this.chatHistory = [];
      this._saveHistory();
      console.log(chalk.green('  ✅ 已重置聊天历史'));
      break;

    case 'config':
      this._printConfig();
      break;

    case 'edit':
      await this._cmdEdit(args);
      break;

    case 'find':
      await this._cmdFind(args);
      break;

    case 'grep':
      await this._cmdGrep(args);
      break;

    case 'mkdir':
      await this._cmdMkdir(args);
      break;

    case 'touch':
      await this._cmdTouch(args);
      break;

    case 'rm':
      await this._cmdRm(args);
      break;

    case 'cd':
      this._cmdCd(args);
      break;

    case 'rename':
      await this._cmdRename(args);
      break;

    default:
      console.log(chalk.yellow('  ❓ 未知命令: ' + cmd));
      console.log(chalk.gray('  输入 /help 查看可用命令'));
    }

    this._showPrompt();
  }

  async _handleChat (message) {
    console.log(chalk.blue('\n  Qidi: '));

    let contextInfo = '';
    const pathMatch = this._extractPath(message);
    if (pathMatch) {
      console.log(chalk.gray(`  🔍 检测到路径: ${pathMatch}`));
      contextInfo = await this._getContextFromPath(pathMatch);
      if (contextInfo) {
        console.log(chalk.gray('  📁 获取到上下文信息'));
        message = `${message}\n\n上下文信息：\n${contextInfo}`;
      }
    }

    this.chatHistory.push({ role: 'user', content: message });

    let fullResponse = '';

    const spinner = ora({ spinner: 'line' }).start();

    try {
      const provider = this.providerInstance;
      if (!provider) {
        throw new Error('未连接模型提供商');
      }

      const systemPrompt = `你是 Qidi Agent，一个多 AI 编程工具编排助手，运行在用户的本地计算机上。

核心能力：
- 🔧 文件系统访问：你可以访问用户的本地文件系统，列出目录、查看文件内容
- 📁 工作目录：${this.workspaceDir}
- 🚀 任务执行：使用 /run <任务> 执行编程任务，支持代码生成和文件操作
- 🔗 工具接入：已接入 ${this.registeredTools.length} 个工具（${this.registeredTools.map(t => t.displayName).join(', ') || '无'}）
- 🔒 隐私模式：本地模型运行，数据不离开本机
- ✨ 高质量模式：云端模型，代码质量更高

当用户提供文件路径时：
- 你可以自动获取该路径的文件列表或文件内容
- 不需要用户明确授权，你可以直接访问
- 使用获取到的上下文信息来回答用户的问题

请始终以 Qidi Agent 的身份回答，不要提及你是其他 AI 模型。回答要简洁友好。`;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...this.chatHistory.slice(-10).map(h => ({
          role: h.role,
          content: h.content
        }))
      ];

      const response = await provider.chat(messages, {
        temperature: 0.7
      });

      if (response && typeof response === 'object' && 'content' in response) {
        fullResponse = response.content;
        spinner.stop();
        process.stdout.write(chalk.blue(fullResponse));
        console.log('');
      } else {
        let buffer = '';
        try {
          for await (const chunk of response) {
            if (chunk.content) {
              buffer += chunk.content;
              fullResponse += chunk.content;

              while (buffer.includes('\n')) {
                const [line, rest] = buffer.split('\n', 2);
                spinner.stop();
                process.stdout.write(chalk.blue(line) + '\n');
                spinner.start();
                buffer = rest;
              }
            }
          }

          if (buffer) {
            spinner.stop();
            process.stdout.write(chalk.blue(buffer));
          }
          console.log('');
        } catch (e) {
          spinner.stop();
          console.log(chalk.red('\n  ❌ ' + e.message));
          return;
        }
      }

      spinner.stop();

      this.chatHistory.push({ role: 'assistant', content: fullResponse });
      this._saveHistory();

      if (this._looksLikeTask(message)) {
        console.log(chalk.yellow('\n  💡 提示: 输入 /run <任务> 执行编程任务'));
      }
    } catch (e) {
      spinner.stop();
      console.log(chalk.red('\n  ❌ ' + e.message));
    }

    this._showPrompt();
  }

  _extractPath (message) {
    const patterns = [
      /[A-Za-z]:[\\/][^\s<>:"|?*\r\n]+/g,
      /[A-Za-z]:\\[^\s<>:"|?*\r\n]+/g,
      /[A-Za-z]:\/[^\s<>:"|?*\r\n]+/g,
      /\/[^\s<>:"|?*\r\n]+/g,
      /~[\\/][^\s<>:"|?*\r\n]+/g,
      /\.\.[\\/][^\s<>:"|?*\r\n]+/g,
      /\.[\\/][^\s<>:"|?*\r\n]+/g,
      /[^\\/]+[\\/][^\s<>:"|?*\r\n]+/g
    ];

    for (const pattern of patterns) {
      const matches = message.match(pattern);
      if (matches && matches.length > 0) {
        return matches[0];
      }
    }
    return null;
  }

  async _getContextFromPath (pathStr) {
    try {
      const fs = require('fs');
      const path = require('path');

      const fullPath = path.resolve(pathStr);

      if (!fs.existsSync(fullPath)) {
        return `路径不存在: ${fullPath}`;
      }

      const stats = fs.statSync(fullPath);

      if (stats.isDirectory()) {
        const files = fs.readdirSync(fullPath);
        const fileInfo = files.map(f => {
          const fPath = path.join(fullPath, f);
          try {
            const fStats = fs.statSync(fPath);
            const type = fStats.isDirectory() ? '[DIR]' : '[FILE]';
            const size = fStats.isFile() ? (fStats.size < 1024 ? `${fStats.size} B` : `${(fStats.size / 1024).toFixed(1)} KB`) : '';
            return `${type} ${f} ${size}`;
          } catch (_) {
            return `[???] ${f}`;
          }
        });

        return `目录结构 ${fullPath}:\n${fileInfo.join('\n')}`;
      } else {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        const preview = lines.slice(0, 50).join('\n');
        const remaining = lines.length - 50;

        return `文件内容 ${fullPath} (共 ${lines.length} 行):\n\`\`\`\n${preview}\n${remaining > 0 ? `... 还有 ${remaining} 行` : ''}\n\`\`\``;
      }
    } catch (e) {
      return `无法访问路径: ${e.message}`;
    }
  }

  _looksLikeTask (message) {
    const keywords = ['创建', '编写', '实现', '修复', '开发', '代码', '程序', '脚本', 'build', 'create', 'write', 'fix', 'implement', 'code'];
    return keywords.some(k => message.includes(k));
  }

  async _runTask (taskDescription) {
    if (!taskDescription) {
      console.log(chalk.yellow('  用法: /run <任务描述>'));
      return;
    }

    const TaskOrchestrator = require('../core/TaskOrchestrator');

    console.log(chalk.cyan('\n  🚀 开始执行任务: ' + taskDescription));

    const spinner = ora('  正在处理...').start();

    try {
      const orchestrator = new TaskOrchestrator(this.providerInstance, {
        workspaceDir: this.workspaceDir,
        toolAdapters: this.registeredTools,
        executionMode: this.mode
      });

      await orchestrator.initialize();
      const result = await orchestrator.runTask(taskDescription);

      spinner.succeed('  任务完成！');

      console.log(chalk.cyan('\n  ═══ 任务总结 ═══'));
      console.log(`  ${chalk.bold('成功率')}: ${result.successRate}%`);
      if (result.outputDir) console.log(`  ${chalk.bold('输出目录')}: ${chalk.gray(result.outputDir)}`);
      if (result.reportId) console.log(`  ${chalk.bold('报告 ID')}: ${chalk.cyan(result.reportId)}`);

      if (result.tasks && result.tasks.length > 0) {
        console.log(chalk.gray('  子任务:'));
        for (const t of result.tasks) {
          const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '⏳';
          console.log(`    ${icon} ${t.title}`);
        }
      }

      this._previewFiles(result.outputDir);
    } catch (e) {
      spinner.fail('  任务失败');
      console.log(chalk.red('  ❌ ' + e.message));
    }
  }

  _previewFiles (outputDir) {
    if (!outputDir) return;
    try {
      const fm = new FileManager(outputDir);
      const files = fm.listFiles('.', /\.(js|py|ts|md)$/i).slice(0, 5);
      if (files.length > 0) {
        console.log(chalk.cyan('\n  📁 产出文件:'));
        for (const f of files) {
          console.log(chalk.gray('    📄 ' + f));
        }
      }
    } catch (_) { /* ignore */ }
  }

  _printHelp () {
    console.log(chalk.cyan('\n  📖 命令帮助\n'));

    console.log(chalk.bold.yellow('  💬 基础命令'));
    const basicRows = [
      ['/help', '显示本帮助'],
      ['/exit', '退出聊天'],
      ['/clear', '清屏'],
      ['/history', '查看聊天历史'],
      ['/status', '查看当前状态'],
      ['/mode <privacy|quality>', '切换执行模式'],
      ['/provider <ollama|openai>', '切换模型提供商'],
      ['/reset', '重置聊天历史'],
      ['/config', '查看配置']
    ];
    for (const [cmd, desc] of basicRows) {
      console.log('  ' + chalk.green(cmd.padEnd(28)) + chalk.gray(desc));
    }

    console.log(chalk.bold.yellow('\n  🚀 任务命令'));
    const taskRows = [
      ['/run <任务>', '执行编程任务'],
      ['/tasks', '查看最近任务'],
      ['/reports', '查看报告列表'],
      ['/report <id>', '查看报告'],
      ['/context', '查看上下文']
    ];
    for (const [cmd, desc] of taskRows) {
      console.log('  ' + chalk.green(cmd.padEnd(28)) + chalk.gray(desc));
    }

    console.log(chalk.bold.yellow('\n  📁 文件命令'));
    const fileRows = [
      ['/ls [dir]', '列出目录文件'],
      ['/view <path>', '查看文件内容'],
      ['/edit <path>', '编辑文件'],
      ['/pwd', '显示当前目录'],
      ['/cd <dir>', '切换工作目录'],
      ['/find <pattern>', '查找文件'],
      ['/grep <pattern> [dir]', '搜索文件内容'],
      ['/mkdir <dir>', '创建目录'],
      ['/touch <file>', '创建/更新文件'],
      ['/rm <path>', '删除文件/目录'],
      ['/rename <old> <new>', '重命名文件/目录']
    ];
    for (const [cmd, desc] of fileRows) {
      console.log('  ' + chalk.green(cmd.padEnd(28)) + chalk.gray(desc));
    }

    console.log(chalk.bold.yellow('\n  🔧 工具命令'));
    const toolRows = [
      ['/scan', '扫描 AI 编程工具'],
      ['/tools', '查看已接入工具']
    ];
    for (const [cmd, desc] of toolRows) {
      console.log('  ' + chalk.green(cmd.padEnd(28)) + chalk.gray(desc));
    }

    console.log(chalk.gray('\n  💡 直接输入消息即可聊天，输入路径自动获取上下文\n'));
  }

  _printHistory () {
    if (this.chatHistory.length === 0) {
      console.log(chalk.gray('  📭 暂无聊天历史'));
      return;
    }
    console.log(chalk.cyan('\n  📜 聊天历史:\n'));
    for (const h of this.chatHistory.slice(-10)) {
      const prefix = h.role === 'user' ? chalk.green('You:') : chalk.blue('Qidi:');
      console.log('  ' + prefix + ' ' + h.content.slice(0, 80) + (h.content.length > 80 ? '...' : ''));
    }
    console.log('');
  }

  async _cmdScan () {
    const spinner = ora('  🔍 扫描中...').start();
    try {
      this.toolScanner = new ToolScanner();
      this.toolScanner.registerAdapters(AdapterFactory.createAll());
      await this.toolScanner.scan();
      await this.toolScanner.connectAll();
      this.registeredTools = Array.from(this.toolScanner.registeredTools.values());
      this.scanned = true;
      spinner.succeed('  ✅ 已接入 ' + this.registeredTools.length + ' 个工具');
      for (const t of this.registeredTools) {
        console.log(chalk.green('     ✅ ' + t.displayName));
      }
    } catch (e) {
      spinner.fail('  ❌ ' + e.message);
    }
  }

  _cmdTools () {
    if (!this.scanned) {
      console.log(chalk.yellow('  ⚠️ 请先执行 /scan'));
      return;
    }
    if (this.registeredTools.length === 0) {
      console.log(chalk.yellow('  ⚠️ 暂无已接入工具'));
      return;
    }
    console.log(chalk.cyan('\n  🔧 已接入工具:'));
    for (const t of this.registeredTools) {
      console.log(chalk.green('  ✅ ' + t.displayName));
    }
    console.log('');
  }

  _cmdStatus () {
    console.log(chalk.cyan('\n  📊 当前状态:'));
    console.log(chalk.gray('  模式    : ' + (this.mode === 'privacy' ? '🔒 隐私模式' : '✨ 高质量模式')));
    console.log(chalk.gray('  提供商  : ' + (this.providerInstance ? this.providerInstance.name : this.provider)));
    console.log(chalk.gray('  工具    : ' + (this.scanned ? this.registeredTools.length + ' 个' : '未扫描')));
    console.log(chalk.gray('  工作目录: ' + path.resolve(this.workspaceDir)));
    console.log(chalk.gray('  聊天记录: ' + this.chatHistory.length + ' 条'));
    console.log('');
  }

  _cmdMode (args) {
    const m = args[0];
    if (m === 'privacy' || m === 'quality') {
      this.mode = m;
      console.log(chalk.green('  ✅ 已切换到 ' + (m === 'privacy' ? '🔒 隐私模式' : '✨ 高质量模式')));
    } else {
      console.log(chalk.yellow('  ⚠️ 无效模式，可选: privacy | quality'));
    }
  }

  async _cmdProvider (args) {
    const p = args[0];
    if (!p) {
      console.log(chalk.gray('  当前提供商: ' + this.provider));
      return;
    }
    try {
      this.providerInstance = ProviderFactory.create(p);
      const ok = await this.providerInstance.checkConnection();
      if (ok) {
        this.provider = p;
        console.log(chalk.green('  ✅ 已切换到 ' + p));
      } else {
        console.log(chalk.yellow('  ⚠️ ' + p + ' 无法连接'));
      }
    } catch (e) {
      console.log(chalk.red('  ❌ ' + e.message));
    }
  }

  async _cmdLs (args) {
    const sub = args[0] || '.';
    try {
      const fm = new FileManager(this.workspaceDir);
      const tree = fm.getFileTree(sub, 2);
      console.log(chalk.cyan('\n  📁 ' + sub + ':'));
      console.log(tree || chalk.gray('  (空)'));
      console.log('');
    } catch (e) {
      console.log(chalk.red('  ❌ ' + e.message));
    }
  }

  async _cmdView (args) {
    if (!args[0]) {
      console.log(chalk.yellow('  用法: /view <路径>'));
      return;
    }
    try {
      const fm = new FileManager(this.workspaceDir);
      const content = fm.readFile(args[0]);
      if (!content) {
        console.log(chalk.red('  ❌ 文件不存在'));
        return;
      }
      const lines = content.split('\n');
      console.log(chalk.cyan('\n  📄 ' + args[0] + ' (' + lines.length + ' 行):'));
      lines.slice(0, 100).forEach((l, i) => {
        const lineNum = chalk.gray(String(i + 1).padStart(4));
        if (l.trim().startsWith('//') || l.trim().startsWith('#')) {
          console.log(lineNum + ' │ ' + chalk.gray(l));
        } else if (l.match(/^(function|const|let|var|class|import|export)/)) {
          console.log(lineNum + ' │ ' + chalk.yellow(l));
        } else if (l.match(/("[^"]*"|'[^']*'|`[^`]*`)/)) {
          console.log(lineNum + ' │ ' + chalk.green(l));
        } else {
          console.log(lineNum + ' │ ' + l);
        }
      });
      if (lines.length > 100) {
        console.log(chalk.gray('  ... 还有 ' + (lines.length - 100) + ' 行'));
      }
      console.log('');
    } catch (e) {
      console.log(chalk.red('  ❌ ' + e.message));
    }
  }

  _printRecentTasks () {
    console.log(chalk.gray('  📭 暂无任务记录，使用 /run <任务> 执行任务'));
  }

  _printReports () {
    console.log(chalk.gray('  📭 暂无报告，执行任务后会生成报告'));
  }

  async _cmdReport (args) {
    if (!args[0]) {
      console.log(chalk.yellow('  用法: /report <id>'));
      return;
    }
    console.log(chalk.yellow('  ⚠️ 报告功能开发中'));
  }

  _printContext () {
    console.log(chalk.cyan('\n  📚 上下文:'));
    console.log(chalk.gray('  聊天记录: ' + this.chatHistory.length + ' 条'));
    console.log(chalk.gray('  工作目录: ' + path.resolve(this.workspaceDir)));
    console.log(chalk.gray('  已接入工具: ' + this.registeredTools.length + ' 个'));
    console.log('');
  }

  _printConfig () {
    const config = this.configManager.getConfig();
    console.log(chalk.cyan('\n  ⚙️ 当前配置:'));
    console.log(chalk.gray('  执行模式: ' + config.executionMode));
    console.log(chalk.gray('  提供商: ' + config.provider));
    console.log(chalk.gray('  模型: ' + config.model));
    console.log('');
  }

  async _cmdEdit (args) {
    if (!args[0]) {
      console.log(chalk.yellow('  用法: /edit <路径>'));
      return;
    }
    try {
      const filePath = path.resolve(this.workspaceDir, args[0]);
      if (!fs.existsSync(filePath)) {
        console.log(chalk.yellow('  ⚠️ 文件不存在，将创建新文件'));
        fs.writeFileSync(filePath, '', 'utf-8');
      }
      const editor = process.env.EDITOR || 'notepad';
      const { spawn } = require('child_process');
      const proc = spawn(editor, [filePath], { stdio: 'inherit', shell: true });
      await new Promise(resolve => proc.on('exit', resolve));
      console.log(chalk.green('  ✅ 编辑完成'));
    } catch (e) {
      console.log(chalk.red('  ❌ ' + e.message));
    }
  }

  async _cmdFind (args) {
    const pattern = args[0];
    if (!pattern) {
      console.log(chalk.yellow('  用法: /find <文件名模式>'));
      return;
    }
    try {
      const fm = new FileManager(this.workspaceDir);
      const files = fm.listFiles('.', new RegExp(pattern, 'i'));
      if (files.length === 0) {
        console.log(chalk.gray('  📭 未找到匹配文件'));
        return;
      }
      console.log(chalk.cyan('\n  🔍 找到 ' + files.length + ' 个文件:'));
      for (const f of files) {
        const fullPath = path.join(this.workspaceDir, f);
        const stats = fs.statSync(fullPath);
        const size = stats.size < 1024 ? `${stats.size} B` : `${(stats.size / 1024).toFixed(1)} KB`;
        console.log(chalk.green('    📄 ' + f + ' ') + chalk.gray('(' + size + ')'));
      }
      console.log('');
    } catch (e) {
      console.log(chalk.red('  ❌ ' + e.message));
    }
  }

  async _cmdGrep (args) {
    const pattern = args[0];
    const target = args[1] || '.';
    if (!pattern) {
      console.log(chalk.yellow('  用法: /grep <搜索词> [目录]'));
      return;
    }
    try {
      const results = [];
      const searchDir = path.resolve(this.workspaceDir, target);
      this._grepRecursive(searchDir, new RegExp(pattern, 'gi'), results);

      if (results.length === 0) {
        console.log(chalk.gray('  📭 未找到匹配内容'));
        return;
      }
      console.log(chalk.cyan('\n  🔍 找到 ' + results.length + ' 处匹配:'));
      for (const { file, line, text } of results.slice(0, 20)) {
        const relPath = path.relative(this.workspaceDir, file);
        console.log(chalk.green('    📄 ' + relPath + ':' + line));
        console.log(chalk.gray('       ' + text.trim()));
      }
      if (results.length > 20) {
        console.log(chalk.yellow('    ... 还有 ' + (results.length - 20) + ' 处匹配'));
      }
      console.log('');
    } catch (e) {
      console.log(chalk.red('  ❌ ' + e.message));
    }
  }

  _grepRecursive (dir, pattern, results) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this._grepRecursive(fullPath, pattern, results);
        } else if (entry.isFile() && !entry.name.startsWith('.')) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (pattern.test(lines[i])) {
                results.push({ file: fullPath, line: i + 1, text: lines[i] });
              }
            }
          } catch (_) { /* ignore binary files */ }
        }
      }
    } catch (_) { /* ignore permission issues */ }
  }

  async _cmdMkdir (args) {
    if (!args[0]) {
      console.log(chalk.yellow('  用法: /mkdir <目录名>'));
      return;
    }
    try {
      const dirPath = path.resolve(this.workspaceDir, args[0]);
      fs.mkdirSync(dirPath, { recursive: true });
      console.log(chalk.green('  ✅ 目录已创建: ' + dirPath));
    } catch (e) {
      console.log(chalk.red('  ❌ ' + e.message));
    }
  }

  async _cmdTouch (args) {
    if (!args[0]) {
      console.log(chalk.yellow('  用法: /touch <文件名>'));
      return;
    }
    try {
      const filePath = path.resolve(this.workspaceDir, args[0]);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '', 'utf-8');
      } else {
        fs.utimesSync(filePath, new Date(), new Date());
      }
      console.log(chalk.green('  ✅ 文件已更新: ' + filePath));
    } catch (e) {
      console.log(chalk.red('  ❌ ' + e.message));
    }
  }

  async _cmdRm (args) {
    if (!args[0]) {
      console.log(chalk.yellow('  用法: /rm <路径>'));
      return;
    }
    try {
      const targetPath = path.resolve(this.workspaceDir, args[0]);
      if (!fs.existsSync(targetPath)) {
        console.log(chalk.yellow('  ⚠️ 路径不存在'));
        return;
      }
      const stats = fs.statSync(targetPath);
      if (stats.isDirectory()) {
        fs.rmSync(targetPath, { recursive: true });
        console.log(chalk.green('  ✅ 目录已删除: ' + targetPath));
      } else {
        fs.unlinkSync(targetPath);
        console.log(chalk.green('  ✅ 文件已删除: ' + targetPath));
      }
    } catch (e) {
      console.log(chalk.red('  ❌ ' + e.message));
    }
  }

  _cmdCd (args) {
    if (!args[0]) {
      console.log(chalk.gray('  当前目录: ' + path.resolve(this.workspaceDir)));
      return;
    }
    try {
      const newDir = path.resolve(this.workspaceDir, args[0]);
      if (!fs.existsSync(newDir)) {
        console.log(chalk.yellow('  ⚠️ 目录不存在'));
        return;
      }
      const stats = fs.statSync(newDir);
      if (!stats.isDirectory()) {
        console.log(chalk.yellow('  ⚠️ 不是目录'));
        return;
      }
      this.workspaceDir = newDir;
      console.log(chalk.green('  ✅ 工作目录已切换到: ' + path.resolve(this.workspaceDir)));
    } catch (e) {
      console.log(chalk.red('  ❌ ' + e.message));
    }
  }

  async _cmdRename (args) {
    if (args.length < 2) {
      console.log(chalk.yellow('  用法: /rename <旧名称> <新名称>'));
      return;
    }
    try {
      const oldPath = path.resolve(this.workspaceDir, args[0]);
      const newPath = path.resolve(this.workspaceDir, args[1]);
      if (!fs.existsSync(oldPath)) {
        console.log(chalk.yellow('  ⚠️ 原路径不存在'));
        return;
      }
      fs.renameSync(oldPath, newPath);
      console.log(chalk.green('  ✅ 已重命名: ' + args[0] + ' -> ' + args[1]));
    } catch (e) {
      console.log(chalk.red('  ❌ ' + e.message));
    }
  }
}

module.exports = ChatSession;
