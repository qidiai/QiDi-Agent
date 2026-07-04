/**
 * SelfEvolve 代码坏味道检测器
 *
 * 基于 AST 符号提取的静态分析，检测以下代码坏味道：
 * - 长函数：函数行数超过阈值
 * - 深嵌套：控制流嵌套超过阈值
 * - 重复代码：高度相似的代码块
 * - 过多参数：函数参数数量过多
 * - 上帝类：类过大/职责过多
 * - 魔法数字：硬编码数值
 * - 空异常处理：空的 catch/except 块
 * - TODO/FIXME 遗留
 * - 未使用导入
 * - 循环复杂度过高
 */

const { SymbolExtractor } = require('./ASTConflictDetector');

class CodeSmellDetector {
  constructor (options = {}) {
    this.thresholds = {
      maxFunctionLines: options.maxFunctionLines || 80,
      maxNestingDepth: options.maxNestingDepth || 5,
      maxParams: options.maxParams || 6,
      maxClassMethods: options.maxClassMethods || 20,
      maxCyclomaticComplexity: options.maxCyclomaticComplexity || 15,
      maxDuplicateThreshold: options.maxDuplicateThreshold || 0.3,
      minSimilarityForDuplicate: options.minSimilarityForDuplicate || 0.8,
      ...options.thresholds
    };
  }

  /**
   * 检测代码坏味道
   * @param {string} code - 代码内容
   * @param {string} language - 编程语言
   * @returns {Object} { smells, summary, score }
   */
  detect (code, language) {
    if (!code || typeof code !== 'string') {
      return { smells: [], summary: { total: 0 }, score: 100 };
    }

    const lang = (language || '').toLowerCase();
    const symbols = SymbolExtractor.extract(code, lang);

    const smells = [];

    // 1. 长函数检测
    smells.push(...this._detectLongFunctions(code, lang, symbols));

    // 2. 深嵌套检测
    smells.push(...this._detectDeepNesting(code, lang));

    // 3. 重复代码检测
    smells.push(...this._detectDuplicateCode(code));

    // 4. 过多参数检测
    smells.push(...this._detectTooManyParams(symbols));

    // 5. 上帝类检测
    smells.push(...this._detectGodClass(symbols));

    // 6. 魔法数字检测
    smells.push(...this._detectMagicNumbers(code, lang));

    // 7. 空异常处理检测
    smells.push(...this._detectEmptyExceptionHandlers(code, lang));

    // 8. TODO/FIXME 检测
    smells.push(...this._detectTodoFixme(code));

    // 9. 未使用导入检测
    smells.push(...this._detectUnusedImports(code, symbols, lang));

    // 10. 循环复杂度检测
    smells.push(...this._detectHighCyclomaticComplexity(code, symbols, lang));

    // 计算综合评分
    const summary = this._summarize(smells);
    const score = this._calculateScore(smells, code);

    return { smells, summary, score, symbols };
  }

  _detectLongFunctions (code, lang, symbols) {
    const smells = [];
    const lines = code.split('\n');

    for (const fn of symbols.functions) {
      // 查找函数在代码中的位置
      const funcStartIndex = code.indexOf(fn.raw);
      if (funcStartIndex === -1) continue;

      const startLine = code.substring(0, funcStartIndex).split('\n').length - 1;

      // 查找函数结束位置（简化版：基于大括号匹配或缩进）
      let funcLines = 0;
      let braceCount = 0;
      let foundOpenBrace = false;

      for (let i = startLine; i < lines.length; i++) {
        const line = lines[i];
        braceCount += (line.match(/\{/g) || []).length;
        braceCount -= (line.match(/\}/g) || []).length;
        if (braceCount > 0) foundOpenBrace = true;
        funcLines++;

        if (foundOpenBrace && braceCount <= 0 && i > startLine) {
          break;
        }

        // Python: 基于缩进
        if (lang === 'python' && i > startLine && line.trim() && !line.startsWith(' ') && !line.startsWith('\t')) {
          break;
        }
      }

      if (funcLines > this.thresholds.maxFunctionLines) {
        smells.push({
          type: 'long_function',
          severity: funcLines > this.thresholds.maxFunctionLines * 2 ? 'high' : 'medium',
          location: `函数 ${fn.name} (第${startLine + 1}行)`,
          description: `函数 "${fn.name}" 有 ${funcLines} 行，超过阈值 ${this.thresholds.maxFunctionLines} 行`,
          suggestion: '考虑将函数拆分为更小的子函数',
          metrics: { lines: funcLines, threshold: this.thresholds.maxFunctionLines }
        });
      }
    }

    return smells;
  }

  _detectDeepNesting (code, lang) {
    const smells = [];
    const lines = code.split('\n');
    let maxDepth = 0;
    let maxDepthLine = 0;
    let currentDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      currentDepth += (line.match(/[{(]/g) || []).length;
      currentDepth -= (line.match(/[})]/g) || []).length;

      // Python: 基于缩进
      if (lang === 'python') {
        const indent = (line.match(/^\s*/) || [''])[0].length;
        currentDepth = Math.floor(indent / 4);
      }

      if (currentDepth > maxDepth) {
        maxDepth = currentDepth;
        maxDepthLine = i + 1;
      }
    }

    if (maxDepth > this.thresholds.maxNestingDepth) {
      smells.push({
        type: 'deep_nesting',
        severity: maxDepth > this.thresholds.maxNestingDepth * 2 ? 'high' : 'medium',
        location: `第${maxDepthLine}行附近`,
        description: `嵌套深度 ${maxDepth} 层，超过阈值 ${this.thresholds.maxNestingDepth} 层`,
        suggestion: '使用提前返回(early return)或提取子函数减少嵌套',
        metrics: { depth: maxDepth, threshold: this.thresholds.maxNestingDepth }
      });
    }

    return smells;
  }

  _detectDuplicateCode (code) {
    const smells = [];
    const lines = code.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 15 && !l.startsWith('//') && !l.startsWith('#') && !l.startsWith('/*'));

    // 简化的重复检测：查找连续相同的行
    const seen = new Map();
    const duplicates = [];

    for (let i = 0; i < lines.length - 3; i++) {
      const chunk = lines.slice(i, i + 3).join('\n');
      if (chunk.length < 30) continue;

      if (seen.has(chunk)) {
        duplicates.push({
          first: seen.get(chunk),
          second: i,
          content: chunk.substring(0, 80)
        });
      } else {
        seen.set(chunk, i);
      }
    }

    if (duplicates.length > 0) {
      const dupRatio = duplicates.length / lines.length;
      if (dupRatio > this.thresholds.maxDuplicateThreshold) {
        smells.push({
          type: 'duplicate_code',
          severity: dupRatio > 0.5 ? 'high' : 'medium',
          location: '全局',
          description: `检测到 ${duplicates.length} 处重复代码块，重复率 ${(dupRatio * 100).toFixed(1)}%`,
          suggestion: '提取公共函数或使用模板模式消除重复',
          metrics: { duplicates: duplicates.length, ratio: dupRatio }
        });
      }
    }

    return smells;
  }

  _detectTooManyParams (symbols) {
    const smells = [];

    for (const fn of symbols.functions) {
      if (fn.params && fn.params.length > this.thresholds.maxParams) {
        smells.push({
          type: 'too_many_params',
          severity: fn.params.length > this.thresholds.maxParams * 2 ? 'high' : 'low',
          location: `函数 ${fn.name}`,
          description: `函数 "${fn.name}" 有 ${fn.params.length} 个参数，超过阈值 ${this.thresholds.maxParams}`,
          suggestion: '考虑使用参数对象封装相关参数',
          metrics: { paramCount: fn.params.length, threshold: this.thresholds.maxParams }
        });
      }
    }

    return smells;
  }

  _detectGodClass (symbols) {
    const smells = [];

    for (const cls of symbols.classes) {
      // 估算类的方法数量
      const methodCount = symbols.functions.filter(f =>
        f.raw && f.raw.includes(cls.name)
      ).length;

      if (methodCount > this.thresholds.maxClassMethods) {
        smells.push({
          type: 'god_class',
          severity: methodCount > this.thresholds.maxClassMethods * 2 ? 'high' : 'medium',
          location: `类 ${cls.name}`,
          description: `类 "${cls.name}" 估算有 ${methodCount} 个方法，超过阈值 ${this.thresholds.maxClassMethods}`,
          suggestion: '按职责拆分为多个更小的类',
          metrics: { methodCount, threshold: this.thresholds.maxClassMethods }
        });
      }
    }

    return smells;
  }

  _detectMagicNumbers (code, lang) {
    const smells = [];
    const magicNumbers = [];

    // 查找不在变量定义/常量定义中的数字
    const numberRegex = /\b(\d{2,})\b/g;
    let match;
    const whitelist = new Set(['0', '1', '2', '10', '100', '1000', '16', '32', '64', '128', '256', '512', '1024']);

    while ((match = numberRegex.exec(code)) !== null) {
      const num = match[1];
      if (whitelist.has(num)) continue;

      // 检查是否在常量定义中
      const beforeMatch = code.substring(Math.max(0, match.index - 50), match.index);
      if (/const|static|final|#define|enum/i.test(beforeMatch)) continue;

      magicNumbers.push({ number: num, position: match.index });
    }

    if (magicNumbers.length > 5) {
      smells.push({
        type: 'magic_numbers',
        severity: 'low',
        location: '全局',
        description: `检测到 ${magicNumbers.length} 个魔法数字`,
        suggestion: '将魔法数字提取为命名常量',
        metrics: { count: magicNumbers.length }
      });
    }

    return smells;
  }

  _detectEmptyExceptionHandlers (code, lang) {
    const smells = [];

    const patterns = {
      javascript: /catch\s*\([^)]*\)\s*\{\s*\}/g,
      python: /except\s*[^:]*:\s*(?:pass|\.\.\.)\s*$/gm,
      java: /catch\s*\([^)]*\)\s*\{\s*\}/g,
      c: /except\s*\([^)]*\)\s*\{\s*\}/g
    };

    const pattern = patterns[lang] || patterns.javascript;
    const matches = code.match(pattern) || [];

    if (matches.length > 0) {
      smells.push({
        type: 'empty_exception_handler',
        severity: 'high',
        location: '全局',
        description: `检测到 ${matches.length} 个空异常处理块`,
        suggestion: '至少记录异常日志，不要静默吞掉异常',
        metrics: { count: matches.length }
      });
    }

    return smells;
  }

  _detectTodoFixme (code) {
    const smells = [];
    const todoRegex = /(?:TODO|FIXME|HACK|XXX|BUG)[:\s]+([^\n]+)/gi;
    const matches = code.match(todoRegex) || [];

    if (matches.length > 0) {
      smells.push({
        type: 'todo_fixme',
        severity: 'low',
        location: '全局',
        description: `检测到 ${matches.length} 个 TODO/FIXME 标记`,
        suggestion: '解决遗留的 TODO/FIXME 项',
        metrics: { count: matches.length, items: matches.slice(0, 5) }
      });
    }

    return smells;
  }

  _detectUnusedImports (code, symbols, lang) {
    const smells = [];

    for (const imp of symbols.imports) {
      const importName = imp.names || imp.path;
      if (!importName) continue;

      // 检查导入的符号是否在代码中使用
      const names = importName.split(',').map(n => n.trim().replace(/[{}]/g, '').trim()).filter(Boolean);
      const unused = names.filter(name => {
        if (!name || name === '*') return false;
        // 在代码中搜索使用（排除导入行本身）
        const codeWithoutImport = code.replace(imp.raw, '');
        const usageRegex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
        return !usageRegex.test(codeWithoutImport);
      });

      if (unused.length > 0 && unused.length === names.length) {
        smells.push({
          type: 'unused_import',
          severity: 'low',
          location: `导入 ${imp.path || importName}`,
          description: `导入 "${importName}" 似乎未被使用`,
          suggestion: '移除未使用的导入以减少代码冗余',
          metrics: { unused: unused.length, total: names.length }
        });
      }
    }

    return smells;
  }

  _detectHighCyclomaticComplexity (code, symbols, lang) {
    const smells = [];

    // 简化的循环复杂度计算
    const complexityPatterns = [
      /\bif\s*\(/g, /\belse\s+if\s*\(/g, /\bfor\s*\(/g, /\bwhile\s*\(/g,
      /\bcase\s+/g, /\bcatch\s*\(/g, /\b&&\b/g, /\b\|\|\b/g, /\b\?\s*[^:]+:/g
    ];

    for (const fn of symbols.functions) {
      const funcStartIndex = code.indexOf(fn.raw);
      if (funcStartIndex === -1) continue;

      // 提取函数体（简化版）
      const afterFunc = code.substring(funcStartIndex);
      const funcBodyMatch = afterFunc.match(/\{[\s\S]*?\}/);
      const funcBody = funcBodyMatch ? funcBodyMatch[0] : '';

      let complexity = 1;
      for (const pattern of complexityPatterns) {
        pattern.lastIndex = 0;
        const matches = funcBody.match(pattern);
        if (matches) complexity += matches.length;
      }

      if (complexity > this.thresholds.maxCyclomaticComplexity) {
        smells.push({
          type: 'high_cyclomatic_complexity',
          severity: complexity > this.thresholds.maxCyclomaticComplexity * 2 ? 'high' : 'medium',
          location: `函数 ${fn.name}`,
          description: `函数 "${fn.name}" 循环复杂度 ${complexity}，超过阈值 ${this.thresholds.maxCyclomaticComplexity}`,
          suggestion: '简化条件逻辑，提取子函数或使用策略模式',
          metrics: { complexity, threshold: this.thresholds.maxCyclomaticComplexity }
        });
      }
    }

    return smells;
  }

  _summarize (smells) {
    const summary = {
      total: smells.length,
      byType: {},
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }
    };

    for (const smell of smells) {
      summary.byType[smell.type] = (summary.byType[smell.type] || 0) + 1;
      summary.bySeverity[smell.severity] = (summary.bySeverity[smell.severity] || 0) + 1;
    }

    return summary;
  }

  _calculateScore (smells, code) {
    const penalties = { critical: 20, high: 10, medium: 5, low: 2 };
    let totalPenalty = 0;

    for (const smell of smells) {
      totalPenalty += penalties[smell.severity] || 0;
    }

    // 基于代码行数调整（大代码库允许更多坏味道）
    const lines = code.split('\n').length;
    const sizeFactor = Math.max(1, lines / 500);

    return Math.max(0, Math.min(100, Math.round(100 - totalPenalty / sizeFactor)));
  }

  /**
   * 生成坏味道报告
   */
  generateReport (result) {
    const lines = [];
    lines.push('═══════════════════════════════════════════');
    lines.push('        代码坏味道检测报告');
    lines.push('═══════════════════════════════════════════');
    lines.push('');
    lines.push(`检测到 ${result.summary.total} 个坏味道`);
    lines.push(`代码质量评分: ${result.score}/100`);
    lines.push('');

    if (result.summary.total === 0) {
      lines.push('✅ 未检测到代码坏味道');
      return lines.join('\n');
    }

    lines.push('严重程度分布:');
    for (const [sev, count] of Object.entries(result.summary.bySeverity)) {
      if (count > 0) lines.push(`  ${sev}: ${count} 个`);
    }
    lines.push('');

    lines.push('类型分布:');
    for (const [type, count] of Object.entries(result.summary.byType)) {
      lines.push(`  ${type}: ${count} 个`);
    }
    lines.push('');

    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...result.smells].sort((a, b) =>
      (severityOrder[a.severity] || 4) - (severityOrder[b.severity] || 4)
    );

    for (const smell of sorted) {
      const icon = smell.severity === 'high' ? '🔴' : smell.severity === 'medium' ? '🟡' : '🟢';
      lines.push(`${icon} [${smell.type}] ${smell.description}`);
      if (smell.suggestion) lines.push(`   建议: ${smell.suggestion}`);
      lines.push('');
    }

    return lines.join('\n');
  }
}

module.exports = CodeSmellDetector;
