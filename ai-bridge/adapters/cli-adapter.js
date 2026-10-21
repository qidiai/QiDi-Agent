'use strict';

/**
 * CliAdapter — CLI 传输适配器
 *
 * 通过 spawn 子进程调用 AI 编程工具的 CLI。
 * 安全设计：shell:false, windowsHide, 严格退出码判成败。
 *
 * 配置字段:
 *   command:        命令名 (如 "openclaw")
 *   commandPaths:   绝对路径候选 (如 ["{{LOCALAPPDATA}}/AtomCode/atomcode.exe"])
 *   args:            参数模板 (支持 {{task}} {{messageFile}} {{sessionId}} {{outputDir}} {{workspaceDir}} {{taskId}})
 *   inputMode:       arg | message-file | stdin
 *   outputMode:      stdout-text | stdout-json | file
 *   parse.textPath:  stdout-json 模式下提取文本的 JSONPath
 *   parse.usagePath: stdout-json 模式下提取 usage 的 JSONPath
 *   parse.outputFile: file 模式下要读取的输出文件名
 *   timeout:         超时毫秒数
 *
 * 执行目录:
 *   opts.workspaceDir 存在时,子进程 cwd = workspaceDir(工作区模式);
 *   否则回退到 outputDir(一次性输出目录,兼容旧行为)。
 *   outputDir 始终用于存放 input.txt 等桥接中间产物。
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { BaseAdapter } = require('./base');

// Windows CreateProcess 命令行上限约 32K 字符，留出模板其余部分的安全余量
const MAX_ARG_TASK_LEN = 24000;

class CliAdapter extends BaseAdapter {
  constructor (config) {
    super(config);
    this.inputMode = config.inputMode || 'arg';
    this.outputMode = config.outputMode || 'stdout-text';
    this.parseConfig = config.parse || {};
    this.timeout = config.timeout || 120000;
    this.commandPaths = config.commandPaths || [];
  }

  /**
   * 检测命令是否可用
   * 1. 检查 commandPaths 中的绝对路径
   * 2. 用 where.exe 查 PATH
   */
  async detect () {
    // 1. 检查配置的绝对路径
    for (const p of this.commandPaths) {
      const resolved = resolveEnvVars(p);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return true;
    }

    // 2. 查 PATH
    return findInPath(this.config.command);
  }

  /**
   * 执行任务
   */
  async execute (task, opts = {}) {
    const taskId = opts.taskId || `${this.name}_${Date.now()}`;
    // 默认输出根固定在 ai-bridge/output(不随进程 cwd 漂移,与 server 清理逻辑同一坐标系)
    const dir = opts.outputDir || path.join(__dirname, '..', 'output', `${this.name}_${taskId}`);
    fs.mkdirSync(dir, { recursive: true });

    const workspaceDir = opts.workspaceDir ? path.resolve(opts.workspaceDir) : dir;
    if (opts.workspaceDir && (!fs.existsSync(workspaceDir) || !fs.statSync(workspaceDir).isDirectory())) {
      throw new Error(`工作区目录不存在或不是目录: ${workspaceDir}`);
    }

    const sessionId = `bridge-${taskId}-${Date.now()}`;

    // 准备输入
    let messageFile = null;
    if (this.inputMode === 'message-file') {
      messageFile = path.join(dir, 'input.txt');
      fs.writeFileSync(messageFile, task, 'utf-8');
    }

    // Windows 命令行 argv 上限约 32K：arg 模式超长时落盘，任务文本改为让 agent 读文件的短指令
    // 落盘位置用 cwd(workspaceDir)内的相对路径,保证 agent 以自身 cwd 就能读到,且不污染任务目录之外的位置
    let effectiveTask = task;
    let longTaskFile = null;
    if (this.inputMode === 'arg' && task.length > MAX_ARG_TASK_LEN) {
      const longTaskName = '.ai-bridge-long-task.md';
      longTaskFile = path.join(workspaceDir, longTaskName);
      fs.writeFileSync(longTaskFile, task, 'utf-8');
      effectiveTask = `完整任务内容已写入当前目录下的文件: ./${longTaskName}\n请先读取该文件的全部内容，然后严格按照文件中的指令执行任务并给出最终结果。`;
    }

    // 构建参数（模板替换）
    const args = (this.config.args || []).map(arg => {
      return replaceTemplates(arg, {
        task: effectiveTask,
        messageFile: messageFile || '',
        sessionId,
        outputDir: dir,
        workspaceDir,
        taskId
      });
    });

    // 执行
    const stdin = this.inputMode === 'stdin' ? task : null;
    let stdout;
    try {
      stdout = await runCommand(this.config.command, args, {
        timeout: opts.timeout || this.timeout,
        cwd: workspaceDir,
        stdin
      });
    } finally {
      if (longTaskFile) { try { fs.rmSync(longTaskFile, { force: true }); } catch (_) {} }
    }

    // 解析输出
    return this.parseOutput(stdout, dir, workspaceDir);
  }

  /**
   * 按 outputMode 解析命令输出
   */
  parseOutput (stdout, outputDir, workspaceDir = outputDir) {
    switch (this.outputMode) {
      case 'stdout-text':
        return this.buildResult(stdout);

      case 'stdout-json': {
        // 尝试从 stdout 中找到 JSON 部分
        const jsonResult = extractJSON(stdout);
        if (!jsonResult) {
          // JSON 解析失败，fallback 到原始文本
          return this.buildResult(stdout);
        }

        // 用 parsePath 提取文本
        const text = this.parseConfig.textPath
          ? this.parsePath(jsonResult, this.parseConfig.textPath)
          : null;

        // 用 parsePath 提取 usage
        let usage = null;
        if (this.parseConfig.usagePath) {
          const rawUsage = this.parsePath(jsonResult, this.parseConfig.usagePath);
          if (rawUsage) {
            usage = {
              input: rawUsage.input || rawUsage.inputTokens || 0,
              output: rawUsage.output || rawUsage.outputTokens || 0,
              estimated: false
            };
            usage.total = usage.input + usage.output;
          }
        }

        return this.buildResult(text || stdout, usage);
      }

      case 'file': {
        const outputName = this.parseConfig.outputFile || 'output.md';
        let outputFile = path.join(outputDir, outputName);
        // 工作区模式:工具可能把文件直接写进 cwd,两级回退
        if (!fs.existsSync(outputFile) && workspaceDir !== outputDir) {
          outputFile = path.join(workspaceDir, outputName);
        }
        let content = '';
        if (fs.existsSync(outputFile)) {
          content = fs.readFileSync(outputFile, 'utf-8');
        }
        if (!content.trim()) {
          throw new Error(`${this.config.command} 未产出 ${outputName}`);
        }
        return this.buildResult(content);
      }

      default:
        return this.buildResult(stdout);
    }
  }
}

// ============================================================
// 安全命令解析 + 执行（从 tool-registry.js 原样搬来，不改逻辑）
// ============================================================

/** Find command in PATH */
async function findInPath (name) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const checker = isWin ? 'where' : 'which';
    const child = spawn(checker, [name], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let found = '';
    child.stdout.on('data', d => found += d);
    child.on('close', code => resolve(code === 0 && found.trim().length > 0));
    child.on('error', () => resolve(false));
  });
}

/** 安全解析 Windows 下的命令路径(避免 shell:true 注入面) */
function resolveWindowsCommand (cmd) {
  if (path.isAbsolute(cmd) && fs.existsSync(cmd) && fs.statSync(cmd).isFile()) return cmd;
  if (fs.existsSync(cmd) && fs.statSync(cmd).isFile()) return path.resolve(cmd);
  try {
    const r = spawnSync('where', [cmd], { encoding: 'utf-8', windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const lines = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const preferred = lines.find(l => /\.(cmd|bat|exe)$/i.test(l) && fs.existsSync(l));
      if (preferred) return preferred;
      const first = lines.find(l => l && fs.existsSync(l));
      if (first) return first;
    }
  } catch (_) {}
  return null;
}

/** Run command safely (严格按退出码判成败;无 shell:true 注入面) */
function runCommand (cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    let actualCmd = cmd;
    let actualArgs = args;

    if (isWin) {
      // 先检查 commandPaths 绝对路径
      let resolved = null;
      // 如果 cmd 本身就是绝对路径且存在
      if (path.isAbsolute(cmd) && fs.existsSync(cmd) && fs.statSync(cmd).isFile()) {
        resolved = cmd;
      } else {
        resolved = resolveWindowsCommand(cmd);
      }
      if (!resolved) {
        reject(new Error(`命令未找到或无法安全解析: ${cmd}(已禁用 shell 回退以防命令注入)`));
        return;
      }
      const lower = resolved.toLowerCase();
      if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
        actualCmd = process.env.ComSpec || 'cmd.exe';
        actualArgs = ['/c', resolved, ...args];
      } else {
        actualCmd = resolved;
        actualArgs = args;
      }
    } else {
      // 非 Windows：如果命令不在 PATH 中，尝试直接执行
      actualCmd = cmd;
      actualArgs = args;
    }

    const child = spawn(actualCmd, actualArgs, {
      cwd: opts.cwd || process.cwd(),
      timeout: opts.timeout || 120000,
      env: { ...process.env, FORCE_COLOR: '0' },
      shell: false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    // 输出总量上限(字符数,非精确字节):防失控子进程无限吐出拖垮内存;可用 env 覆盖,默认 10MB
    const envMaxOutput = parseInt(process.env.AI_BRIDGE_CLI_MAX_OUTPUT_CHARS);
    const MAX_OUTPUT_CHARS = (Number.isFinite(envMaxOutput) && envMaxOutput > 0) ? envMaxOutput : 10 * 1024 * 1024;
    let settled = false; // 防 kill 后 close/error 事件二次 resolve/reject
    function settleReject (err) {
      if (settled) return;
      settled = true;
      reject(err);
    }
    function checkOutputLimit () {
      if (stdout.length + stderr.length > MAX_OUTPUT_CHARS) {
        try { child.kill(); } catch { /* 已退出则忽略 */ }
        settleReject(new Error(`输出超过 ${MAX_OUTPUT_CHARS} 字符上限,已终止`));
      }
    }

    child.stdout.on('data', d => { stdout += d.toString(); checkOutputLimit(); });
    child.stderr.on('data', d => { stderr += d.toString(); checkOutputLimit(); });

    if (opts.stdin) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(stdout);
      } else {
        const err = new Error(`Command exited with code ${code}: ${(stderr || stdout).substring(0, 200)}`);
        err.code = code;
        err.stdout = stdout;
        reject(err);
      }
    });

    child.on('error', (err) => {
      settleReject(new Error(`Execution failed: ${err.message}`));
    });
  });
}

/**
 * 模板变量替换
 * {{task}} {{messageFile}} {{sessionId}} {{outputDir}} {{workspaceDir}} {{taskId}}
 */
function replaceTemplates (str, vars) {
  return str
    .replace(/\{\{task\}\}/g, vars.task || '')
    .replace(/\{\{messageFile\}\}/g, vars.messageFile || '')
    .replace(/\{\{sessionId\}\}/g, vars.sessionId || '')
    .replace(/\{\{outputDir\}\}/g, vars.outputDir || '')
    .replace(/\{\{workspaceDir\}\}/g, vars.workspaceDir || '')
    .replace(/\{\{taskId\}\}/g, vars.taskId || '');
}

/**
 * 环境变量替换（用于 commandPaths）
 * {{LOCALAPPDATA}} {{APPDATA}} {{USERPROFILE}} {{ProgramFiles}}
 */
function resolveEnvVars (str) {
  return str
    .replace(/\{\{LOCALAPPDATA\}\}/g, process.env.LOCALAPPDATA || '')
    .replace(/\{\{APPDATA\}\}/g, process.env.APPDATA || '')
    .replace(/\{\{USERPROFILE\}\}/g, process.env.USERPROFILE || '')
    .replace(/\{\{ProgramFiles\}\}/g, process.env.ProgramFiles || '')
    .replace(/\{\{ProgramFiles\(x86\)\}\}/g, process.env['ProgramFiles(x86)'] || '')
    .replace(/\//g, path.sep); // Unix → Windows 路径分隔符
}

/**
 * 从 stdout 中提取 JSON
 * 支持：纯 JSON、JSON 前有日志行（找第一个 { 开始）
 */
function extractJSON (stdout) {
  const lines = stdout.split('\n');
  const jsonStart = lines.findIndex(l => l.trim().startsWith('{'));
  if (jsonStart < 0) return null;

  const jsonText = lines.slice(jsonStart).join('\n');
  try {
    return JSON.parse(jsonText);
  } catch (_) {
    // 尝试正则提取最外层 JSON
    const match = stdout.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (_) {}
    }
    return null;
  }
}

module.exports = { CliAdapter };
