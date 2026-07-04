/**
 * 原生 API 适配层
 *
 * 为 Claude Code 和 OpenClaw 提供超越 CLI 调用的深度集成能力：
 * - 结构化输出解析（从 stdout 提取 JSON/代码块/文件变更）
 * - 上下文注入（向工具传递项目约束、契约、接口摘要）
 * - 增量采集（只收集变化的文件，而非全量扫描）
 * - 能力探测（检测工具支持的功能特性）
 * - 健康检查（轻量级心跳检测）
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const logger = require('./Logger')('NativeAPIAdapter');

// ── 结构化输出解析器 ──

class StructuredOutputParser {
  /**
   * 从工具 stdout 中提取结构化信息
   * @param {string} rawOutput - 原始输出
   * @returns {Object} { codeBlocks, jsonBlocks, fileChanges, references, errors }
   */
  static parse (rawOutput) {
    if (!rawOutput || typeof rawOutput !== 'string') {
      return { codeBlocks: [], jsonBlocks: [], fileChanges: [], references: [], errors: [] };
    }

    return {
      codeBlocks: StructuredOutputParser._extractCodeBlocks(rawOutput),
      jsonBlocks: StructuredOutputParser._extractJsonBlocks(rawOutput),
      fileChanges: StructuredOutputParser._extractFileChanges(rawOutput),
      references: StructuredOutputParser._extractReferences(rawOutput),
      errors: StructuredOutputParser._extractErrors(rawOutput)
    };
  }

  static _extractCodeBlocks (text) {
    const blocks = [];
    // 标准 markdown 代码块
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      blocks.push({
        language: match[1] || 'text',
        code: match[2].trim(),
        start: match.index,
        end: match.index + match[0].length
      });
    }

    // 缺少结束标记的代码块（修复模式）
    const unclosedRegex = /```(\w+)?\n([\s\S]*?)$/g;
    if (blocks.length === 0) {
      while ((match = unclosedRegex.exec(text)) !== null) {
        blocks.push({
          language: match[1] || 'text',
          code: match[2].trim(),
          start: match.index,
          end: text.length,
          repaired: true
        });
      }
    }

    // 内联代码文件引用: // path: file.js
    const fileRefRegex = /(?:\/\/|#|<!--)\s*(?:path|file|filename):\s*(.+?)(?:\n|$)/gi;
    while ((match = fileRefRegex.exec(text)) !== null) {
      const filePath = match[1].trim();
      // 查找紧随其后的代码块
      const afterRef = text.substring(match.index + match[0].length);
      const codeMatch = afterRef.match(/```(\w+)?\n([\s\S]*?)```/);
      if (codeMatch) {
        blocks.push({
          language: codeMatch[1] || path.extname(filePath).slice(1) || 'text',
          code: codeMatch[2].trim(),
          filePath
        });
      }
    }

    return blocks;
  }

  static _extractJsonBlocks (text) {
    const blocks = [];
    // JSON 代码块
    const jsonRegex = /```json\n([\s\S]*?)```/g;
    let match;
    while ((match = jsonRegex.exec(text)) !== null) {
      try {
        blocks.push({
          type: 'code_block',
          data: JSON.parse(match[1].trim()),
          raw: match[1].trim()
        });
      } catch (e) {
        // 尝试修复 JSON
        const repaired = StructuredOutputParser._repairJson(match[1].trim());
        if (repaired) {
          blocks.push({ type: 'code_block', data: repaired, raw: match[1].trim(), repaired: true });
        }
      }
    }

    // 行内 JSON 对象
    const inlineJsonRegex = /\{[^{}]*"[\w]+":[^{}]*\}/g;
    while ((match = inlineJsonRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
          blocks.push({ type: 'inline', data: parsed, raw: match[0] });
        }
      } catch (e) {}
    }

    return blocks;
  }

  static _extractFileChanges (text) {
    const changes = [];
    // 文件路径引用: "src/main.js", path/to/file.py
    const filePathRegex = /(?:created|modified|updated|deleted|wrote|saved|changed)\s+(?:file\s+)?:?["']?([^"'\n,]+\.\w{1,5})["']?/gi;
    let match;
    while ((match = filePathRegex.exec(text)) !== null) {
      changes.push({
        action: match[0].toLowerCase().includes('delete') ? 'delete' : 'modify',
        path: match[1].trim()
      });
    }

    // diff 格式: +++ b/src/file.js
    const diffRegex = /^\s*\+\+\+\s+b\/(.+)$/gm;
    while ((match = diffRegex.exec(text)) !== null) {
      changes.push({ action: 'modify', path: match[1].trim() });
    }

    // --- a/src/file.js
    const delRegex = /^\s*---\s+a\/(.+)$/gm;
    while ((match = delRegex.exec(text)) !== null) {
      if (!changes.find(c => c.path === match[1].trim())) {
        changes.push({ action: 'modify', path: match[1].trim() });
      }
    }

    return changes;
  }

  static _extractReferences (text) {
    const refs = [];
    // 函数/类引用
    const funcRefRegex = /(?:calling|using|importing|referencing)\s+(?:function|class|module)\s+['"]?(\w+)['"]?/gi;
    let match;
    while ((match = funcRefRegex.exec(text)) !== null) {
      refs.push({ type: 'symbol', name: match[1] });
    }

    // URL 引用
    const urlRegex = /https?:\/\/[^\s)]+/g;
    while ((match = urlRegex.exec(text)) !== null) {
      refs.push({ type: 'url', url: match[0] });
    }

    return refs;
  }

  static _extractErrors (text) {
    const errors = [];
    const errorRegex = /(?:error|exception|failed|traceback|fatal)[:\s]+(.+?)(?:\n|$)/gi;
    let match;
    while ((match = errorRegex.exec(text)) !== null) {
      errors.push({
        message: match[1].trim(),
        raw: match[0].trim()
      });
    }
    return errors;
  }

  static _repairJson (text) {
    try {
      let repaired = text.trim();
      // 移除尾部逗号
      repaired = repaired.replace(/,\s*([}\]])/g, '$1');
      // 补全缺失的引号
      repaired = repaired.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
      return JSON.parse(repaired);
    } catch (e) {
      return null;
    }
  }
}

// ── 上下文注入器 ──

class ContextInjector {
  /**
   * 构建增强的任务提示，注入项目约束、契约和接口摘要
   * @param {string} task - 原始任务描述
   * @param {Object} context - 上下文信息
   * @returns {string} 增强后的任务提示
   */
  static buildEnhancedPrompt (task, context = {}) {
    let prompt = '';

    // 注入全局约束
    if (context.constraints) {
      prompt += '【全局约束】\n';
      if (context.constraints.language) prompt += `- 编程语言: ${context.constraints.language}\n`;
      if (context.constraints.techStack) prompt += `- 技术栈: ${context.constraints.techStack}\n`;
      if (context.constraints.platform) prompt += `- 平台: ${context.constraints.platform}\n`;
      if (context.constraints.framework) prompt += `- 框架: ${context.constraints.framework}\n`;
      if (context.constraints.style) prompt += `- 代码风格: ${context.constraints.style}\n`;
      prompt += '\n';
    }

    // 注入契约信息
    if (context.requiredContracts && context.requiredContracts.length > 0) {
      prompt += '【必须实现的接口契约】\n';
      for (const c of context.requiredContracts) {
        if (typeof c === 'string') {
          prompt += `- ${c}\n`;
        } else {
          prompt += `- ${c.name || c.signature || JSON.stringify(c)}\n`;
        }
      }
      prompt += '\n';
    }

    if (context.producesContracts && context.producesContracts.length > 0) {
      prompt += '【可依赖的接口契约（来自前序模块）】\n';
      for (const c of context.producesContracts) {
        if (typeof c === 'string') {
          prompt += `- ${c}\n`;
        } else {
          prompt += `- ${c.name || c.signature || JSON.stringify(c)}\n`;
        }
      }
      prompt += '\n';
    }

    // 注入接口摘要
    if (context.interfaceSummary) {
      prompt += '【前序模块接口摘要】\n';
      prompt += context.interfaceSummary + '\n\n';
    }

    // 注入项目结构
    if (context.projectStructure) {
      prompt += '【项目结构】\n';
      prompt += context.projectStructure + '\n\n';
    }

    // 注入验收标准
    if (context.acceptanceCriteria) {
      prompt += '【验收标准】\n';
      prompt += context.acceptanceCriteria + '\n\n';
    }

    // 原始任务
    prompt += '【任务描述】\n';
    prompt += task;

    // 输出格式要求
    prompt += '\n\n【输出要求】\n';
    prompt += '1. 使用 markdown 代码块输出代码，标注语言\n';
    prompt += '2. 每个文件用注释标注路径: // path: filename.ext\n';
    prompt += '3. 确保代码可直接编译/运行\n';
    prompt += '4. 严格遵循全局约束和接口契约\n';

    return prompt;
  }
}

// ── 增量文件采集器 ──

class IncrementalCollector {
  constructor () {
    this._baseline = null;
  }

  /**
   * 记录执行前的文件基线
   * @param {string} dir - 工作目录
   */
  snapshot (dir) {
    this._baseline = this._scanDir(dir);
    return this._baseline;
  }

  /**
   * 采集执行后新增/变更的文件
   * @param {string} dir - 工作目录
   * @returns {Array} 变更文件列表
   */
  collectChanges (dir) {
    if (!this._baseline) {
      return this._scanDir(dir).map(f => ({ ...f, action: 'create' }));
    }

    const current = this._scanDir(dir);
    const changes = [];
    const baselineMap = new Map(this._baseline.map(f => [f.path, f]));

    for (const file of current) {
      const base = baselineMap.get(file.path);
      if (!base) {
        changes.push({ ...file, action: 'create' });
      } else if (file.mtime > base.mtime || file.size !== base.size) {
        changes.push({ ...file, action: 'modify' });
      }
      baselineMap.delete(file.path);
    }

    // 被删除的文件
    for (const [path, file] of baselineMap) {
      changes.push({ ...file, action: 'delete' });
    }

    return changes;
  }

  /**
   * 读取变更文件的内容
   * @param {string} baseDir - 基目录
   * @param {Array} changes - 变更列表
   * @returns {Array} 带内容的变更列表
   */
  readChanges (baseDir, changes) {
    return changes
      .filter(c => c.action !== 'delete')
      .map(c => {
        try {
          const fullPath = path.join(baseDir, c.path);
          const content = fs.readFileSync(fullPath, 'utf-8');
          return { ...c, content };
        } catch (e) {
          return { ...c, content: '', error: e.message };
        }
      });
  }

  _scanDir (dir) {
    const files = [];
    try {
      const walk = (currentDir, relativeTo = dir) => {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const fullPath = path.join(currentDir, entry.name);
          const relativePath = path.relative(relativeTo, fullPath);
          if (entry.isDirectory()) {
            walk(fullPath, relativeTo);
          } else {
            try {
              const stat = fs.statSync(fullPath);
              files.push({
                path: relativePath.replace(/\\/g, '/'),
                size: stat.size,
                mtime: stat.mtime.getTime()
              });
            } catch (e) {}
          }
        }
      };
      walk(dir);
    } catch (e) {
      logger.warn(`扫描目录失败: ${dir} - ${e.message}`);
    }
    return files;
  }
}

// ── 能力探测器 ──

class CapabilityProbe {
  /**
   * 探测工具支持的能力
   * @param {Object} adapter - 工具适配器
   * @returns {Object} 能力描述
   */
  static async probe (adapter) {
    const capabilities = {
      name: adapter.name,
      displayName: adapter.displayName,
      features: {
        headlessMode: false,
        fileOutput: false,
        structuredOutput: false,
        contextInjection: false,
        streamingOutput: false,
        multiFileGeneration: false,
        codeReview: false,
        testGeneration: false,
        refactoring: false
      },
      limits: {
        maxContextLength: 0,
        maxOutputLength: 0,
        timeout: 0
      },
      version: adapter.version || 'unknown'
    };

    // Claude Code 能力探测
    if (adapter.name === 'claude-code') {
      capabilities.features = {
        headlessMode: true, // claude -p 支持无头模式
        fileOutput: true,
        structuredOutput: true,
        contextInjection: true,
        streamingOutput: false,
        multiFileGeneration: true,
        codeReview: true,
        testGeneration: true,
        refactoring: true
      };
      capabilities.limits = {
        maxContextLength: 200000,
        maxOutputLength: 64000,
        timeout: 300000
      };
    }

    // OpenClaw 能力探测
    if (adapter.name === 'openclaw') {
      capabilities.features = {
        headlessMode: true,
        fileOutput: true,
        structuredOutput: true,
        contextInjection: true,
        streamingOutput: true,
        multiFileGeneration: true,
        codeReview: true,
        testGeneration: false,
        refactoring: true
      };
      capabilities.limits = {
        maxContextLength: 128000,
        maxOutputLength: 32000,
        timeout: 300000
      };
    }

    // AtomCode 能力探测
    if (adapter.name === 'atom-code') {
      capabilities.features = {
        headlessMode: true,
        fileOutput: true,
        structuredOutput: false,
        contextInjection: true,
        streamingOutput: true,
        multiFileGeneration: true,
        codeReview: false,
        testGeneration: false,
        refactoring: false
      };
      capabilities.limits = {
        maxContextLength: 64000,
        maxOutputLength: 16000,
        timeout: 180000
      };
    }

    // 通用 CLI 工具能力
    if (!capabilities.features.headlessMode) {
      // 通过 --help 输出推断能力
      try {
        const helpResult = await adapter._runCommand(adapter.command, ['--help'], { timeout: 10000 });
        if (helpResult.success) {
          const helpText = helpResult.stdout.toLowerCase();
          capabilities.features.headlessMode = helpText.includes('-p') || helpText.includes('--print') || helpText.includes('--headless');
          capabilities.features.fileOutput = helpText.includes('--output') || helpText.includes('-o');
          capabilities.features.streamingOutput = helpText.includes('--stream') || helpText.includes('--sse');
        }
      } catch (e) {}
    }

    return capabilities;
  }
}

// ── 轻量级健康检查 ──

class HealthProbe {
  /**
   * 轻量级健康检查
   * @param {Object} adapter - 工具适配器
   * @returns {Object} { healthy, responseTime, version }
   */
  static async check (adapter) {
    const start = Date.now();
    try {
      const result = await adapter._runCommand(adapter.command, ['--version'], { timeout: 5000 });
      const responseTime = Date.now() - start;

      if (result.success) {
        return {
          healthy: true,
          responseTime,
          version: result.stdout.trim(),
          lastCheck: new Date().toISOString()
        };
      }

      // 版本命令失败，尝试 --help
      const helpResult = await adapter._runCommand(adapter.command, ['--help'], { timeout: 5000 });
      return {
        healthy: helpResult.success,
        responseTime: Date.now() - start,
        version: null,
        lastCheck: new Date().toISOString()
      };
    } catch (e) {
      return {
        healthy: false,
        responseTime: Date.now() - start,
        error: e.message,
        lastCheck: new Date().toISOString()
      };
    }
  }
}

module.exports = {
  StructuredOutputParser,
  ContextInjector,
  IncrementalCollector,
  CapabilityProbe,
  HealthProbe
};
