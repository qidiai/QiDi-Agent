const TokenCounter = require('./TokenCounter');
const logger = require('./Logger').createLogger('ContextCompressor');

class ContextCompressor {
  constructor (options = {}) {
    this.tokenCounter = new TokenCounter();
    this.maxContextTokens = options.maxContextTokens || 3000;
    this.keepSignatures = options.keepSignatures !== false;
    this.keepComments = options.keepComments || false;
    this.keepImports = options.keepImports !== false;
    this.preserveKeyLines = options.preserveKeyLines !== false;
  }

  compressCode (code, options = {}) {
    if (!code || code.length === 0) return '';

    const maxTokens = options.maxTokens || this.maxContextTokens;
    const tokens = this.tokenCounter.estimateTokens(code);

    if (tokens <= maxTokens) {
      return code;
    }

    let compressed = '';
    const parts = [];

    const importLines = this._extractImports(code);
    if (this.keepImports && importLines.length > 0) {
      parts.push(importLines.join('\n'));
    }

    const keyVariables = this._extractKeyVariables(code);
    if (keyVariables.length > 0) {
      parts.push('// 关键变量定义:');
      keyVariables.forEach(varInfo => {
        parts.push(`//   ${varInfo.name}: ${varInfo.type || 'unknown'}${varInfo.value ? ` = ${varInfo.value}` : ''}`);
      });
    }

    const signatures = this._extractSignatures(code);
    if (this.keepSignatures && signatures.length > 0) {
      parts.push('// 函数/方法签名:');
      signatures.forEach(sig => {
        parts.push(`//   ${sig}`);
      });
    }

    const keyStructures = this._extractKeyStructures(code);
    if (keyStructures.length > 0) {
      parts.push('// 关键数据结构:');
      keyStructures.forEach(str => {
        parts.push(str);
      });
    }

    const importantComments = this._extractImportantComments(code);
    if (this.keepComments && importantComments.length > 0) {
      parts.push('// 关键注释:');
      importantComments.slice(0, 5).forEach(cmt => {
        parts.push(`//   ${cmt}`);
      });
    }

    const summary = this._generateSummary(code);
    parts.push(`// 代码摘要: ${summary}`);

    compressed = parts.join('\n\n') + '\n';

    const currentTokens = this.tokenCounter.estimateTokens(compressed);
    if (currentTokens < maxTokens - 200) {
      const keyLines = this._extractKeyLines(code, maxTokens - currentTokens - 100);
      if (keyLines.length > 0) {
        compressed += '\n// 关键代码片段:\n';
        compressed += keyLines.map(l => l).join('\n');
      }
    }

    logger.debug('代码压缩完成', { originalTokens: tokens, compressedTokens: this.tokenCounter.estimateTokens(compressed) });
    return compressed;
  }

  _extractImports (code) {
    const lines = code.split('\n');
    return lines.filter(line => {
      return line.match(/^#include|^import|^from\s|^require\(|^using\s/);
    });
  }

  _extractKeyVariables (code) {
    const variables = [];
    const patterns = [
      /(?:const|let|var)\s+(\w+)\s*:\s*(\w+)\s*=\s*([^;]+);?/g,
      /(?:const|let|var)\s+(\w+)\s*=\s*(["'`][^"'`]*["'`]|\d+\.?\d*|true|false|null|undefined)/g,
      /(?:public|private|protected)\s+(static\s+)?(\w+)\s+(\w+)\s*=\s*([^;]+);?/g,
      /(\w+)\s+(\w+)\s*=\s*(["'`][^"'`]*["'`]|\d+\.?\d*|true|false|null)/g
    ];

    patterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(code)) !== null) {
        if (match[1] && !match[1].match(/^(function|class|struct|return|if|else|for|while|try|catch|throw|async|await)$/)) {
          const name = match[1];
          const type = match[2] && !match[2].match(/^\d+|^["'`]/) ? match[2] : null;
          const value = match[3] || match[4] || null;
          if (!variables.some(v => v.name === name)) {
            variables.push({ name, type, value: value ? value.trim().substring(0, 50) : null });
          }
        }
      }
    });

    return variables.slice(0, 20);
  }

  _extractSignatures (code) {
    const signatures = [];

    const patterns = [
      /(?:function|def|void|int|char|float|double|struct|class|public|private|protected)\s+(\w+)\s*\([^)]*\)/g,
      /(?:async\s+function|async\s+(\w+))\s*\([^)]*\)/g,
      /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g
    ];

    patterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(code)) !== null) {
        const sig = match[0].substring(0, 100);
        signatures.push(sig);
      }
    });

    return signatures.slice(0, 15);
  }

  _extractKeyStructures (code) {
    const structures = [];

    const structPattern = /(?:typedef\s+struct|struct\s+\w+|class\s+\w+)\s*\{[^}]{0,200}\}/g;
    let match;
    while ((match = structPattern.exec(code)) !== null) {
      structures.push(match[0].substring(0, 200));
    }

    return structures.slice(0, 5);
  }

  _extractImportantComments (code) {
    const comments = [];

    const docCommentPattern = /\/\*\*[\s\S]*?\*\//g;
    const singleCommentPattern = /\/\/[^\n]+/g;

    let match;
    while ((match = docCommentPattern.exec(code)) !== null) {
      comments.push(match[0].substring(0, 100));
    }

    while ((match = singleCommentPattern.exec(code)) !== null) {
      const cmt = match[0].substring(3).trim();
      if (cmt.length > 10 && !cmt.match(/^TODO|^FIXME|^NOTE/i)) {
        comments.push(cmt.substring(0, 50));
      }
    }

    return comments.slice(0, 10);
  }

  _extractKeyLines (code, maxTokens) {
    const lines = code.split('\n');
    const keyLines = [];
    let currentTokens = 0;

    const importantPatterns = [
      /^int\s+main|^def\s+main|^async\s+main/,
      /return\s+\w+;$/,
      /if\s*\(|while\s*\(|for\s*\(/,
      /break;|continue;$/,
      /throw\s+|catch\s*\(/,
      /\.push\(|\.pop\(|\.append\(|\.remove\(/,
      /malloc|free|new\s+\w+|delete\s+/,
      /printf|cout|print|console\.log/
    ];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      const isImportant = importantPatterns.some(p => p.test(trimmed));

      if (isImportant || trimmed.match(/^\w+\s*=\s*[^;]+;$/)) {
        const lineTokens = this.tokenCounter.estimateTokens(trimmed);
        if (currentTokens + lineTokens <= maxTokens) {
          keyLines.push(trimmed.substring(0, 80));
          currentTokens += lineTokens;
        }
      }
    }

    return keyLines.slice(0, 20);
  }

  _generateSummary (code) {
    const lines = code.split('\n').filter(l => l.trim().length > 0);
    const totalLines = lines.length;

    const functionCount = (code.match(/function|def|void\s+\w+\s*\(/g) || []).length;
    const classCount = (code.match(/class\s+\w+/g) || []).length;
    const structCount = (code.match(/struct|typedef\s+struct/g) || []).length;

    let summary = `${totalLines}行代码`;
    if (functionCount > 0) summary += `, ${functionCount}个函数`;
    if (classCount > 0) summary += `, ${classCount}个类`;
    if (structCount > 0) summary += `, ${structCount}个结构体`;

    return summary;
  }

  compressTaskHistory (history, options = {}) {
    if (!history || history.length === 0) return '';

    const maxTokens = options.maxTokens || this.maxContextTokens;
    const parts = [];
    let currentTokens = 0;

    parts.push('// === 已完成任务摘要 ===');

    const sortedHistory = [...history].sort((a, b) => {
      const scoreA = a.qualityScore || 0;
      const scoreB = b.qualityScore || 0;
      return scoreB - scoreA;
    });

    for (const task of sortedHistory) {
      const taskHeader = `// ${task.taskId}: ${task.title || '未知'} (质量: ${task.qualityScore || 0}分)`;
      const headerTokens = this.tokenCounter.estimateTokens(taskHeader);

      if (currentTokens + headerTokens > maxTokens) {
        break;
      }

      parts.push(taskHeader);
      currentTokens += headerTokens;

      if (task.codeBlocks && task.codeBlocks.length > 0) {
        for (const block of task.codeBlocks.slice(0, 2)) {
          const remainingTokens = maxTokens - currentTokens - 100;
          if (remainingTokens <= 0) break;

          const blockCompressed = this.compressCode(block.code, { maxTokens: Math.min(remainingTokens, 300) });
          if (blockCompressed) {
            const blockTokens = this.tokenCounter.estimateTokens(blockCompressed);
            if (currentTokens + blockTokens <= maxTokens) {
              parts.push(`// ${block.language || 'code'}:`);
              parts.push(blockCompressed);
              currentTokens += blockTokens + this.tokenCounter.estimateTokens(`// ${block.language || 'code'}:`);
            }
          }
        }
      }

      parts.push('');
      currentTokens += 2;
    }

    const compressed = parts.join('\n');
    logger.debug('任务历史压缩完成', { originalTasks: history.length, compressedTasks: sortedHistory.length, tokens: this.tokenCounter.estimateTokens(compressed) });
    return compressed;
  }

  compressContext (context, options = {}) {
    const result = {
      constraints: context.constraints,
      previousCode: '',
      previousResults: []
    };

    if (context.previousCode) {
      result.previousCode = this.compressCode(context.previousCode, options);
    }

    if (context.previousResults && context.previousResults.length > 0) {
      result.previousResults = this.compressTaskHistory(context.previousResults, options);
    }

    return result;
  }

  getCompressionRatio (original, compressed) {
    const originalTokens = this.tokenCounter.estimateTokens(original);
    const compressedTokens = this.tokenCounter.estimateTokens(compressed);

    return {
      originalTokens,
      compressedTokens,
      savedTokens: originalTokens - compressedTokens,
      ratio: Math.round((1 - compressedTokens / originalTokens) * 100)
    };
  }
}

module.exports = ContextCompressor;
