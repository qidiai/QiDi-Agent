const TokenCounter = require('./TokenCounter');

class ContextCompressor {
  constructor(options = {}) {
    this.tokenCounter = new TokenCounter();
    this.maxContextTokens = options.maxContextTokens || 1500;
    this.keepSignatures = options.keepSignatures !== false;
    this.keepComments = options.keepComments || false;
    this.keepImports = options.keepImports !== false;
  }

  compressCode(code, options = {}) {
    if (!code || code.length === 0) return '';
    
    const maxTokens = options.maxTokens || this.maxContextTokens;
    const tokens = this.tokenCounter.estimateTokens(code);
    
    if (tokens <= maxTokens) {
      return code;
    }

    let compressed = '';

    const importLines = this._extractImports(code);
    if (this.keepImports && importLines.length > 0) {
      compressed += importLines.join('\n') + '\n\n';
    }

    const signatures = this._extractSignatures(code);
    if (this.keepSignatures && signatures.length > 0) {
      compressed += '// 函数签名:\n';
      signatures.forEach(sig => {
        compressed += `// ${sig}\n`;
      });
      compressed += '\n';
    }

    const keyStructures = this._extractKeyStructures(code);
    if (keyStructures.length > 0) {
      compressed += '// 关键结构:\n';
      keyStructures.forEach(str => {
        compressed += `${str}\n`;
      });
      compressed += '\n';
    }

    const importantComments = this._extractImportantComments(code);
    if (this.keepComments && importantComments.length > 0) {
      compressed += '// 关键注释:\n';
      importantComments.slice(0, 5).forEach(cmt => {
        compressed += `// ${cmt}\n`;
      });
      compressed += '\n';
    }

    const summary = this._generateSummary(code);
    compressed += `// 代码摘要: ${summary}\n`;

    const currentTokens = this.tokenCounter.estimateTokens(compressed);
    if (currentTokens < maxTokens - 200) {
      const keyLines = this._extractKeyLines(code, maxTokens - currentTokens - 100);
      compressed += '\n// 关键代码片段:\n';
      compressed += keyLines.map(l => `// ${l}`).join('\n');
    }

    return compressed;
  }

  _extractImports(code) {
    const lines = code.split('\n');
    return lines.filter(line => {
      return line.match(/^#include|^import|^from\s|^require\(|^using\s/);
    });
  }

  _extractSignatures(code) {
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

  _extractKeyStructures(code) {
    const structures = [];
    
    const structPattern = /(?:typedef\s+struct|struct\s+\w+|class\s+\w+)\s*\{[^}]{0,200}\}/g;
    let match;
    while ((match = structPattern.exec(code)) !== null) {
      structures.push(match[0].substring(0, 200));
    }

    return structures.slice(0, 5);
  }

  _extractImportantComments(code) {
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

  _extractKeyLines(code, maxTokens) {
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

  _generateSummary(code) {
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

  compressTaskHistory(history, options = {}) {
    if (!history || history.length === 0) return '';
    
    const maxTokens = options.maxTokens || this.maxContextTokens;
    let compressed = '';

    compressed += '// === 已完成任务摘要 ===\n\n';
    
    for (const task of history) {
      const taskSummary = `// ${task.taskId}: ${task.title || '未知'} (质量: ${task.qualityScore || 0}分)\n`;
      compressed += taskSummary;
      
      if (task.codeBlocks && task.codeBlocks.length > 0) {
        for (const block of task.codeBlocks.slice(0, 2)) {
          const blockCompressed = this.compressCode(block.code, { maxTokens: 300 });
          compressed += `// ${block.language || 'code'}:\n${blockCompressed}\n`;
        }
      }
    }

    const tokens = this.tokenCounter.estimateTokens(compressed);
    if (tokens > maxTokens) {
      compressed = compressed.substring(0, maxTokens * 2);
    }

    return compressed;
  }

  compressContext(context, options = {}) {
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

  getCompressionRatio(original, compressed) {
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