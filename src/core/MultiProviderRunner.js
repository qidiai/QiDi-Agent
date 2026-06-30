const AgentFactory = require('../agents');
const MergeEngine = require('../agents/MergeEngine');

class MultiProviderRunner {
  constructor (options = {}) {
    this.providers = options.providers || [];
    this.fileManager = options.fileManager || null;
    this._onEvent = options.onEvent || (() => {});
  }

  async execute (task, context, useSmallModel = false) {
    this._onEvent('multiProviderStart', {
      task,
      providers: this.providers.map(p => p.name || p.constructor.name),
      count: this.providers.length
    });

    const allResults = {};
    const promises = this.providers.map(async (provider, index) => {
      const providerName = provider.name || `provider_${index + 1}`;

      try {
        const agents = AgentFactory.createAll(provider);
        const result = await agents.codeWriter?.writeCode(task, context, { useSmallModel });

        allResults[providerName] = {
          success: true,
          result: { codeBlocks: result?.codeBlocks || [], content: result?.content || '' },
          content: result?.content || '',
          providerName,
          model: result?.model || 'unknown'
        };

        this._onEvent('multiProviderResult', {
          task,
          provider: providerName,
          hasCodeBlocks: (result?.codeBlocks?.length || 0) > 0
        });
      } catch (error) {
        allResults[providerName] = {
          success: false,
          error: error.message,
          providerName
        };
        this._onEvent('multiProviderError', { task, provider: providerName, error: error.message });
      }
    });

    await Promise.all(promises);

    const validResults = Object.keys(allResults).filter(name => allResults[name].success);

    if (validResults.length === 0) {
      this._onEvent('multiProviderFailed', { task, error: '所有Provider都执行失败' });
      return { content: '', codeBlocks: [], multiProviderFailed: true };
    }

    if (validResults.length === 1) {
      const singleResult = allResults[validResults[0]];
      return {
        ...singleResult.result,
        content: singleResult.content,
        source: 'multi_provider_single',
        providerName: validResults[0],
        _providerCount: 1
      };
    }

    const mergeResult = await this._mergeOutputs(task, allResults, context);

    if (mergeResult.codeBlocks && mergeResult.codeBlocks.length > 0) {
      this._saveCodeBlocks(task, mergeResult.codeBlocks);
    }

    return {
      ...mergeResult,
      source: 'multi_provider_merged',
      _providerCount: validResults.length,
      _providers: validResults
    };
  }

  async _mergeOutputs (task, providerResults, context) {
    const validResults = {};
    for (const [name, result] of Object.entries(providerResults)) {
      if (result.success) {
        validResults[name] = result;
      }
    }

    try {
      const mergeEngine = new MergeEngine(null, {
        conflictResolution: 'ai_decides',
        enableThreeWayMerge: Object.keys(validResults).length >= 3
      });

      const mergeResult = await mergeEngine.merge(validResults, context.constraints || {});

      if (mergeResult.mergedCode) {
        const mergedCodeBlocks = Object.entries(mergeResult.mergedFiles || {}).map(([filePath, code]) => ({
          filePath,
          language: this._getLangFromFilePath(filePath),
          code
        }));

        const finalResult = {
          content: mergeResult.mergedCode,
          codeBlocks: mergedCodeBlocks.length > 0 ? mergedCodeBlocks : [],
          mergeQuality: mergeResult.qualityAssessment,
          mergeReport: mergeResult,
          mergeConflicts: mergeResult.conflicts?.length || 0,
          _providerCount: Object.keys(validResults).length
        };

        this._onEvent('multiProviderMerged', {
          task,
          providers: Object.keys(validResults),
          conflicts: mergeResult.conflicts?.length || 0,
          quality: mergeResult.qualityAssessment
        });

        return finalResult;
      }
    } catch (mergeError) {
      this._onEvent('multiProviderMergeFailed', { task, error: mergeError.message });
    }

    return this._pickBestResult(validResults);
  }

  _pickBestResult (providerResults) {
    let bestName = null;
    let bestScore = 0;
    let bestResult = null;

    for (const [name, result] of Object.entries(providerResults)) {
      if (!result.success) continue;

      const blockCount = (result.result?.codeBlocks?.length || 0);
      const contentLength = (result.content?.length || 0);
      const score = blockCount * 100 + Math.min(contentLength / 10, 500);

      if (score > bestScore) {
        bestScore = score;
        bestName = name;
        bestResult = result;
      }
    }

    return {
      ...bestResult.result,
      content: bestResult.content,
      source: 'multi_provider_fallback',
      providerName: bestName
    };
  }

  _saveCodeBlocks (task, codeBlocks) {
    const taskDir = `output/${task.id}`;
    codeBlocks.forEach((block, i) => {
      let relPath = block.filePath;
      if (!relPath || relPath === 'main') {
        const ext = this._getExtFromLanguage(block.language);
        relPath = `result_${i + 1}${ext}`;
      }
      relPath = relPath.replace(/^\/+/, '').replace(/\.\.\//g, '');
      const filePath = `${taskDir}/${relPath}`;
      try {
        this.fileManager?.writeFile(filePath, block.code);
      } catch (e) {}
    });
  }

  _getLangFromFilePath (filePath) {
    if (!filePath || filePath === 'main') return 'text';
    const ext = filePath.split('.').pop().toLowerCase();
    const map = {
      js: 'javascript',
      ts: 'typescript',
      py: 'python',
      rb: 'ruby',
      go: 'go',
      rs: 'rust',
      java: 'java',
      c: 'c',
      cpp: 'cpp',
      cs: 'csharp',
      php: 'php',
      swift: 'swift',
      kt: 'kotlin',
      html: 'html',
      css: 'css',
      json: 'json',
      xml: 'xml',
      yaml: 'yaml',
      yml: 'yaml',
      md: 'markdown',
      sql: 'sql',
      sh: 'shell',
      bash: 'shell',
      ps1: 'powershell'
    };
    return map[ext] || ext;
  }

  _getExtFromLanguage (lang) {
    const map = {
      javascript: '.js',
      python: '.py',
      html: '.html',
      css: '.css',
      json: '.json',
      typescript: '.ts',
      jsx: '.jsx',
      tsx: '.tsx',
      java: '.java',
      go: '.go',
      rust: '.rs',
      c: '.c',
      cpp: '.cpp',
      'c++': '.cpp',
      'c/c++': '.cpp',
      objectivec: '.m',
      csharp: '.cs',
      php: '.php',
      ruby: '.rb',
      swift: '.swift',
      kotlin: '.kt',
      scala: '.scala',
      sql: '.sql',
      shell: '.sh',
      bash: '.sh',
      lua: '.lua',
      perl: '.pl',
      haskell: '.hs',
      fsharp: '.fs',
      dart: '.dart',
      r: '.r',
      julia: '.jl'
    };
    return map[lang?.toLowerCase()] || '.txt';
  }
}

module.exports = MultiProviderRunner;