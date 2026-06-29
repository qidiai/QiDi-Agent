/**
 * 契约拼装引擎（ContractAssembler）
 *
 * 核心思路：
 * 1. 从各工具产出的代码中提取"契约"（函数签名、类定义、API接口、数据结构）
 * 2. 验证契约的一致性（参数类型、返回值类型是否匹配）
 * 3. 根据契约关系拼装最终代码
 *
 * 与传统源码合并的区别：
 * - 传统合并：直接拼接源码，可能产生命名冲突、类型不匹配等问题
 * - 契约拼装：先提取接口定义，验证一致性，再按契约组装
 *
 * 隐私保护优势：
 * - 各工具只产出自己的代码片段
 * - 契约拼装时只看接口定义，不泄露实现细节
 * - 最终拼装由本地完成，云端工具不知道整体架构
 * - 支持本地 Ollama 辅助契约提取，代码完全不离开本地
 */

const ProviderFactory = require('../providers');
const createLogger = require('../utils/Logger');
const logger = createLogger('ContractAssembler');

class ContractAssembler {
  constructor (options = {}) {
    this.options = {
      // 严格模式：契约不一致时报错而非警告
      strictMode: options.strictMode !== false,
      // 是否自动生成适配层（当契约不完全匹配时）
      autoAdapt: options.autoAdapt !== false,
      // 支持的语言
      supportedLanguages: options.supportedLanguages || ['c', 'python', 'javascript', 'typescript', 'java', 'go', 'rust'],
      // 本地模型辅助（隐私模式下使用）
      localModel: options.localModel || null,
      // 是否启用 AI 辅助
      enableAIAssist: options.enableAIAssist !== false,
      ...options
    };
    this.contracts = new Map(); // 存储提取的契约
    this.conflicts = []; // 契约冲突记录
    this.adaptations = []; // 自动适配层

    // 初始化本地模型（如果配置了）
    if (this.options.localModel && this.options.enableAIAssist) {
      this._initLocalModel();
    }
  }

  /**
   * 从代码中提取契约（函数签名、类定义、API接口）
   * 支持静态分析 + 本地模型辅助
   */
  async extractContracts (codeBlocks) {
    const contracts = [];

    for (const block of codeBlocks) {
      const lang = block.language?.toLowerCase();
      if (!this.options.supportedLanguages.includes(lang)) continue;

      // 1. 首先用静态分析提取
      const staticExtracted = this._extractByLanguage(block.code, lang);

      // 2. 如果启用本地模型辅助，处理复杂场景
      let aiExtracted = null;
      if (this.localModel && this.options.enableAIAssist) {
        try {
          aiExtracted = await this._extractContractsByAI(block.code, lang, staticExtracted);
        } catch (e) {
          // AI 提取失败，仅用静态分析结果
          logger.warn(`本地模型契约提取失败 (${block.filePath}):`, e.message);
        }
      }

      // 3. 合并结果（AI 结果补充静态分析遗漏的部分）
      const merged = this._mergeExtracted(staticExtracted, aiExtracted);

      contracts.push({
        source: block.filePath || 'unknown',
        language: lang,
        functions: merged.functions || [],
        classes: merged.classes || [],
        interfaces: merged.interfaces || [],
        structs: merged.structs || [],
        apis: merged.apis || [],
        types: merged.types || [],
        exports: merged.exports || [],
        imports: merged.imports || [],
        traits: merged.traits || [],
        enums: merged.enums || [],
        extractionMethod: aiExtracted ? 'static+ai' : 'static'
      });
    }

    return contracts;
  }

  /**
   * 初始化本地模型（Ollama）
   */
  _initLocalModel () {
    try {
      const modelConfig = this.options.localModel;

      // 如果传入的是 Provider 实例，直接使用
      if (modelConfig.chat && typeof modelConfig.chat === 'function') {
        this.localModel = modelConfig;
        logger.info('契约拼装引擎：使用已配置的本地模型');
        return;
      }

      // 如果是配置对象，创建 Provider
      if (modelConfig.provider === 'ollama' || modelConfig.type === 'ollama') {
        this.localModel = ProviderFactory.create('ollama', {
          baseURL: modelConfig.baseURL || 'http://localhost:11434',
          model: modelConfig.model || 'qwen2.5:7b'
        });
        logger.info('契约拼装引擎：初始化本地 Ollama 模型');
      }
    } catch (e) {
      logger.warn('契约拼装引擎：本地模型初始化失败', e.message);
      this.localModel = null;
    }
  }

  /**
   * 使用本地模型辅助提取契约
   */
  async _extractContractsByAI (code, lang, staticResult) {
    if (!this.localModel) return null;

    const prompt = `分析以下 ${lang} 代码，提取所有契约信息（函数签名、类定义、接口、结构体、类型定义）。

代码：
\`\`\`${lang}
${code}
\`\`\`

已通过静态分析提取：
- 函数：${staticResult.functions?.length || 0} 个
- 类：${staticResult.classes?.length || 0} 个
- 接口：${staticResult.interfaces?.length || 0} 个

请补充静态分析可能遗漏的：
1. 隐式契约（如回调函数签名、事件处理器）
2. 复杂语法（如装饰器、宏、泛型约束）
3. 跨文件依赖推断

以 JSON 格式返回补充的契约：
{
  "functions": [{"name": "...", "params": [...], "returnType": "...", "signature": "..."}],
  "classes": [{"name": "...", "inherits": "..."}],
  "interfaces": [{"name": "...", "properties": [...]}],
  "implicitContracts": [{"type": "...", "description": "..."}]
}

只返回 JSON，不要其他内容。`;

    try {
      const response = await this.localModel.chat({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 2000
      });

      // 解析 AI 返回的 JSON
      const content = response.content || response.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const aiResult = JSON.parse(jsonMatch[0]);
        return {
          functions: aiResult.functions || [],
          classes: aiResult.classes || [],
          interfaces: aiResult.interfaces || [],
          implicitContracts: aiResult.implicitContracts || []
        };
      }
    } catch (e) {
      logger.warn('AI 契约提取解析失败:', e.message);
    }

    return null;
  }

  /**
   * 合并静态分析和 AI 提取结果
   */
  _mergeExtracted (staticResult, aiResult) {
    if (!aiResult) return staticResult;

    const merged = { ...staticResult };

    // 初始化所有需要合并的字段
    const fieldsToMerge = [
      'functions', 'classes', 'interfaces', 'structs', 'types',
      'exports', 'traits', 'enums', 'modules'
    ];

    for (const field of fieldsToMerge) {
      if (!merged[field]) merged[field] = [];

      // 收集静态已有的名称
      const existingNames = new Set(
        (merged[field] || []).map(item => item.name || item.identifier)
      );

      // 添加 AI 提取的新项
      for (const aiItem of aiResult[field] || []) {
        const name = aiItem.name || aiItem.identifier;
        if (name && !existingNames.has(name)) {
          merged[field].push({
            ...aiItem,
            source: 'ai_assist'
          });
        }
      }
    }

    // 保存隐式契约（单独字段）
    if (aiResult.implicitContracts?.length > 0) {
      merged.implicitContracts = aiResult.implicitContracts;
    }

    return merged;
  }

  /**
   * 根据语言提取契约
   */
  _extractByLanguage (code, lang) {
    const extractors = {
      c: this._extractCContracts.bind(this),
      python: this._extractPythonContracts.bind(this),
      javascript: this._extractJSContracts.bind(this),
      typescript: this._extractTSContracts.bind(this),
      java: this._extractJavaContracts.bind(this),
      go: this._extractGoContracts.bind(this),
      rust: this._extractRustContracts.bind(this)
    };

    const extractor = extractors[lang] || extractors.javascript;
    return extractor(code);
  }

  /**
   * C语言契约提取
   */
  _extractCContracts (code) {
    const contracts = { functions: [], structs: [], types: [], includes: [] };

    // 提取函数声明（包括返回类型、参数）
    const funcPattern = /^(\w+)\s+(\w+)\s*\(([^)]*)\)\s*;?/gm;
    let match;
    while ((match = funcPattern.exec(code)) !== null) {
      contracts.functions.push({
        returnType: match[1],
        name: match[2],
        params: this._parseParams(match[3], 'c'),
        signature: `${match[1]} ${match[2]}(${match[3]})`
      });
    }

    // 提取结构体定义
    const structPattern = /struct\s+(\w+)\s*\{([^}]*)\}/gm;
    while ((match = structPattern.exec(code)) !== null) {
      const fields = match[2].split(';').filter(f => f.trim())
        .map(f => {
          const parts = f.trim().split(/\s+/);
          return { type: parts[0], name: parts[1] };
        });
      contracts.structs.push({
        name: match[1],
        fields,
        signature: `struct ${match[1]}`
      });
    }

    // 提取 typedef
    const typedefPattern = /typedef\s+(\w+)\s+(\w+)\s*;/gm;
    while ((match = typedefPattern.exec(code)) !== null) {
      contracts.types.push({
        original: match[1],
        alias: match[2]
      });
    }

    // 提取 #include
    const includePattern = /#include\s*[<"]([^>"]+)[>"]/gm;
    while ((match = includePattern.exec(code)) !== null) {
      contracts.includes.push(match[1]);
    }

    return contracts;
  }

  /**
   * Python契约提取
   */
  _extractPythonContracts (code) {
    const contracts = { functions: [], classes: [], imports: [] };

    // 提取函数定义
    const funcPattern = /def\s+(\w+)\s*\(([^)]*)\)\s*(->\s*([^:]+))?\s*:/gm;
    let match;
    while ((match = funcPattern.exec(code)) !== null) {
      contracts.functions.push({
        name: match[1],
        params: this._parseParams(match[2], 'python'),
        returnType: match[4]?.trim() || 'Any',
        signature: `def ${match[1]}(${match[2]})${match[3] || ''}`
      });
    }

    // 提取类定义
    const classPattern = /class\s+(\w+)(\s*\(([^)]*)\))?\s*:/gm;
    while ((match = classPattern.exec(code)) !== null) {
      contracts.classes.push({
        name: match[1],
        inherits: match[3]?.split(',').map(s => s.trim()) || [],
        signature: `class ${match[1]}${match[2] || ''}`
      });
    }

    // 提取 import
    const importPattern = /^(?:import|from)\s+(\w+)/gm;
    while ((match = importPattern.exec(code)) !== null) {
      contracts.imports.push(match[1]);
    }

    return contracts;
  }

  /**
   * JavaScript契约提取
   */
  _extractJSContracts (code) {
    const contracts = { functions: [], classes: [], exports: [], imports: [] };

    // 提取函数声明
    const funcPattern = /function\s+(\w+)\s*\(([^)]*)\)/gm;
    let match;
    while ((match = funcPattern.exec(code)) !== null) {
      contracts.functions.push({
        name: match[1],
        params: this._parseParams(match[2], 'javascript'),
        returnType: 'any',
        signature: `function ${match[1]}(${match[2]})`
      });
    }

    // 提取箭头函数（const xxx = (...) => ...）
    const arrowPattern = /(?:const|let|var)\s+(\w+)\s*=\s*\(([^)]*)\)\s*=>/gm;
    while ((match = arrowPattern.exec(code)) !== null) {
      contracts.functions.push({
        name: match[1],
        params: this._parseParams(match[2], 'javascript'),
        returnType: 'any',
        isArrow: true,
        signature: `${match[1]}(${match[2]})`
      });
    }

    // 提取类定义
    const classPattern = /class\s+(\w+)(\s+extends\s+(\w+))?\s*\{/gm;
    while ((match = classPattern.exec(code)) !== null) {
      contracts.classes.push({
        name: match[1],
        inherits: match[3] || null,
        signature: `class ${match[1]}${match[2] || ''}`
      });
    }

    // 提取 export
    const exportPattern = /export\s+(?:default\s+)?(?:function|class|const|let|var)?\s*(\w+)/gm;
    while ((match = exportPattern.exec(code)) !== null) {
      contracts.exports.push(match[1]);
    }

    // 提取 import
    const importPattern = /import\s+(?:\{([^}]+)\}|(\w+))\s+from/gm;
    while ((match = importPattern.exec(code)) !== null) {
      const imports = match[1]?.split(',').map(s => s.trim()) || [match[2]];
      contracts.imports.push(...imports.filter(i => i));
    }

    return contracts;
  }

  /**
   * TypeScript契约提取（增强版，包含类型信息）
   */
  _extractTSContracts (code) {
    const base = this._extractJSContracts(code);
    const contracts = {
      functions: base.functions,
      classes: base.classes,
      exports: base.exports,
      imports: base.imports,
      interfaces: [],
      types: []
    };

    // TypeScript 函数签名（带类型）
    const tsFuncPattern = /(?:function|const|let)\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?::\s*([^={;]+))?/gm;
    let match;
    while ((match = tsFuncPattern.exec(code)) !== null) {
      const existing = contracts.functions.find(f => f.name === match[1]);
      if (existing) {
        existing.returnType = match[3]?.trim() || 'any';
        existing.signature = `${match[1]}(${match[2]})${match[3] ? `: ${match[3]}` : ''}`;
      }
    }

    // interface 定义
    const interfacePattern = /interface\s+(\w+)(\s*extends\s+(\w+))?\s*\{([^}]+)\}/gm;
    while ((match = interfacePattern.exec(code)) !== null) {
      const properties = match[4].split(/[;\n]/).filter(p => p.trim())
        .map(p => {
          const parts = p.trim().split(':');
          return { name: parts[0]?.trim(), type: parts[1]?.trim() };
        });
      contracts.interfaces.push({
        name: match[1],
        extends: match[3] || null,
        properties,
        signature: `interface ${match[1]}`
      });
    }

    // type 定义
    const typePattern = /type\s+(\w+)\s*=\s*([^;]+);/gm;
    while ((match = typePattern.exec(code)) !== null) {
      contracts.types.push({
        name: match[1],
        definition: match[2].trim()
      });
    }

    return contracts;
  }

  /**
   * Java契约提取
   */
  _extractJavaContracts (code) {
    const contracts = { functions: [], classes: [], interfaces: [], imports: [] };

    // 提取类定义
    const classPattern = /(public|private|protected)?\s*class\s+(\w+)(\s+extends\s+(\w+))?(\s+implements\s+([^{]+))?\s*\{/gm;
    let match;
    while ((match = classPattern.exec(code)) !== null) {
      contracts.classes.push({
        visibility: match[1] || 'package',
        name: match[2],
        extends: match[4] || null,
        implements: match[6]?.split(',').map(s => s.trim()) || [],
        signature: `${match[1] || ''} class ${match[2]}`
      });
    }

    // 提取方法定义
    const methodPattern = /(public|private|protected)\s+(\w+)\s+(\w+)\s*\(([^)]*)\)/gm;
    while ((match = methodPattern.exec(code)) !== null) {
      contracts.functions.push({
        visibility: match[1],
        returnType: match[2],
        name: match[3],
        params: this._parseParams(match[4], 'java'),
        signature: `${match[1]} ${match[2]} ${match[3]}(${match[4]})`
      });
    }

    // 提取 interface
    const interfacePattern = /(public|private)?\s*interface\s+(\w+)(\s+extends\s+([^{]+))?\s*\{/gm;
    while ((match = interfacePattern.exec(code)) !== null) {
      contracts.interfaces.push({
        visibility: match[1] || 'package',
        name: match[2],
        extends: match[4]?.split(',').map(s => s.trim()) || [],
        signature: `interface ${match[2]}`
      });
    }

    return contracts;
  }

  /**
   * Go契约提取
   */
  _extractGoContracts (code) {
    const contracts = { functions: [], structs: [], interfaces: [] };

    // 提取函数定义
    const funcPattern = /func\s+(\w+)\s*\(([^)]*)\)\s*(\([^)]+\)|[\w*]+)\s*\{/gm;
    let match;
    while ((match = funcPattern.exec(code)) !== null) {
      const returnRaw = match[3] || '';
      contracts.functions.push({
        name: match[1],
        params: this._parseParams(match[2], 'go'),
        returnType: returnRaw.replace(/[()]/g, '').trim(),
        signature: `func ${match[1]}(${match[2]}) ${returnRaw}`
      });
    }

    // 提取 struct
    const structPattern = /type\s+(\w+)\s+struct\s*\{([^}]+)\}/gm;
    while ((match = structPattern.exec(code)) !== null) {
      const fields = match[2].split('\n').filter(f => f.trim())
        .map(f => {
          const parts = f.trim().split(/\s+/);
          return { name: parts[0], type: parts[1] };
        });
      contracts.structs.push({
        name: match[1],
        fields,
        signature: `type ${match[1]} struct`
      });
    }

    // 提取 interface
    const interfacePattern = /type\s+(\w+)\s+interface\s*\{([^}]+)\}/gm;
    while ((match = interfacePattern.exec(code)) !== null) {
      contracts.interfaces.push({
        name: match[1],
        methods: match[2].split('\n').filter(m => m.trim()),
        signature: `type ${match[1]} interface`
      });
    }

    return contracts;
  }

  /**
   * Rust契约提取
   */
  _extractRustContracts (code) {
    const contracts = { functions: [], structs: [], enums: [], traits: [] };

    // 提取函数定义
    const funcPattern = /(?:pub\s+)?fn\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?/gm;
    let match;
    while ((match = funcPattern.exec(code)) !== null) {
      contracts.functions.push({
        visibility: match[0].includes('pub') ? 'pub' : 'private',
        name: match[1],
        params: this._parseParams(match[2], 'rust'),
        returnType: match[3]?.trim() || 'void',
        signature: `fn ${match[1]}(${match[2]})${match[3] ? ` -> ${match[3]}` : ''}`
      });
    }

    // 提取 struct
    const structPattern = /(?:pub\s+)?struct\s+(\w+)(?:<[^>]+>)?\s*\{([^}]+)\}/gm;
    while ((match = structPattern.exec(code)) !== null) {
      contracts.structs.push({
        visibility: match[0].includes('pub') ? 'pub' : 'private',
        name: match[1],
        signature: `struct ${match[1]}`
      });
    }

    // 提取 trait
    const traitPattern = /(?:pub\s+)?trait\s+(\w+)(?:<[^>]+>)?\s*\{([^}]+)\}/gm;
    while ((match = traitPattern.exec(code)) !== null) {
      contracts.traits.push({
        visibility: match[0].includes('pub') ? 'pub' : 'private',
        name: match[1],
        signature: `trait ${match[1]}`
      });
    }

    return contracts;
  }

  /**
   * 解析参数列表
   */
  _parseParams (paramsStr, lang) {
    if (!paramsStr || paramsStr.trim() === '') return [];

    const params = paramsStr.split(',').filter(p => p.trim());
    return params.map(p => {
      const parts = p.trim().split(/\s+/);

      switch (lang) {
      case 'c':
        return { type: parts[0], name: parts[1] || parts[0] };
      case 'python': {
        const pyMatch = p.match(/(\w+)(?:\s*:\s*(\w+))?/);
        return { name: pyMatch[1], type: pyMatch[2] || 'Any' };
      }
      case 'javascript':
        return { name: parts[0] };
      case 'typescript': {
        const tsMatch = p.match(/(\w+)(?:\s*:\s*(\w+))?/);
        return { name: tsMatch[1], type: tsMatch[2] || 'any' };
      }
      case 'java':
        return { type: parts[0], name: parts[1] };
      case 'go': {
        const goParts = p.trim().split(/\s+/);
        if (goParts.length === 2) {
          return { name: goParts[0], type: goParts[1] };
        }
        return { name: goParts[0] };
      }
      case 'rust': {
        const rustMatch = p.match(/(\w+)(?:\s*:\s*(\w+))?/);
        return { name: rustMatch[1], type: rustMatch[2] || 'unknown' };
      }
      default:
        return { name: parts[0] };
      }
    });
  }

  /**
   * 验证契约一致性
   */
  validateContracts (contracts) {
    const issues = [];

    // 按函数名分组，检查是否有同名函数的签名不一致
    const funcByName = {};
    for (const contract of contracts) {
      for (const func of contract.functions || []) {
        if (!funcByName[func.name]) {
          funcByName[func.name] = [];
        }
        funcByName[func.name].push({
          ...func,
          source: contract.source,
          language: contract.language
        });
      }
    }

    // 检查同名函数签名一致性
    for (const [name, defs] of Object.entries(funcByName)) {
      if (defs.length > 1) {
        // 检查签名是否一致
        const signatures = defs.map(d => d.signature);
        const uniqueSigs = [...new Set(signatures)];

        if (uniqueSigs.length > 1) {
          issues.push({
            type: 'function_conflict',
            name,
            severity: 'high',
            details: `函数 ${name} 有 ${defs.length} 个不同的定义`,
            definitions: defs,
            suggestions: this._suggestResolution(name, defs)
          });
        }
      }
    }

    // 检查类名冲突
    const classByName = {};
    for (const contract of contracts) {
      for (const cls of contract.classes || []) {
        if (!classByName[cls.name]) {
          classByName[cls.name] = [];
        }
        classByName[cls.name].push({
          ...cls,
          source: contract.source,
          language: contract.language
        });
      }
    }

    for (const [name, defs] of Object.entries(classByName)) {
      if (defs.length > 1) {
        issues.push({
          type: 'class_conflict',
          name,
          severity: 'medium',
          details: `类 ${name} 有 ${defs.length} 个不同的定义`,
          definitions: defs
        });
      }
    }

    // 检查接口/类型冲突
    // ...

    return {
      valid: issues.filter(i => i.severity === 'high').length === 0,
      issues,
      warnings: issues.filter(i => i.severity === 'medium' || i.severity === 'low'),
      errors: issues.filter(i => i.severity === 'high')
    };
  }

  /**
   * 建议解决方案
   */
  _suggestResolution (name, defs) {
    const suggestions = [];

    // 如果参数数量不同，可能需要适配层
    const paramCounts = defs.map(d => d.params?.length || 0);
    if ([...new Set(paramCounts)].length > 1) {
      suggestions.push({
        type: 'adapter',
        description: '创建适配函数，统一参数签名',
        targetSignature: this._chooseBestSignature(defs)
      });
    }

    // 如果返回类型不同，可能需要转换
    const returnTypes = defs.map(d => d.returnType || 'unknown');
    if ([...new Set(returnTypes)].length > 1) {
      suggestions.push({
        type: 'conversion',
        description: '添加返回值转换层',
        targetReturnType: this._chooseBestReturnType(defs)
      });
    }

    return suggestions;
  }

  /**
   * 选择最佳签名
   */
  _chooseBestSignature (defs) {
    // 选择参数最多的版本（通常是功能最完整的）
    return defs.reduce((best, d) =>
      (d.params?.length || 0) > (best.params?.length || 0) ? d : best
    ).signature;
  }

  /**
   * 选择最佳返回类型
   */
  _chooseBestReturnType (defs) {
    // 避免选择 'any' 或 'unknown'
    const preferred = defs.find(d =>
      d.returnType && !['any', 'unknown', 'void'].includes(d.returnType.toLowerCase())
    );
    return preferred?.returnType || defs[0]?.returnType || 'unknown';
  }

  /**
   * 拼装代码：根据契约关系组装最终代码
   * 支持异步契约提取（如果启用本地模型辅助）
   */
  async assemble (contractResultsOrCodeBlocks, options = {}) {
    const language = options.language || 'c';
    const strictMode = options.strictMode !== false;

    // 支持两种输入：
    // 1. 已提取的契约列表（旧接口兼容）
    // 2. 代码块列表（需要先提取契约）
    let contractResults = contractResultsOrCodeBlocks;

    // 如果输入是代码块，先提取契约
    if (contractResultsOrCodeBlocks[0]?.code && !contractResultsOrCodeBlocks[0]?.functions) {
      contractResults = await this.extractContracts(contractResultsOrCodeBlocks);
    }

    // 1. 验证契约一致性
    const validation = this.validateContracts(contractResults);
    if (!validation.valid && strictMode) {
      return {
        success: false,
        error: '契约验证失败',
        issues: validation.issues,
        code: null
      };
    }

    // 2. 提取所有契约
    const allContracts = {
      functions: [],
      classes: [],
      structs: [],
      interfaces: [],
      types: [],
      imports: [],
      includes: []
    };

    for (const cr of contractResults) {
      for (const key of Object.keys(allContracts)) {
        if (cr[key]) {
          allContracts[key].push(...cr[key]);
        }
      }
    }

    // 3. 去重（同名契约只保留一个）
    const deduplicated = this._deduplicateContracts(allContracts);

    // 4. 按依赖关系排序
    const ordered = this._orderByDependencies(deduplicated);

    // 5. 生成拼装代码
    const assembledCode = this._generateCode(ordered, language, validation);

    // 6. 生成拼装报告
    const report = {
      success: true,
      language,
      contracts: {
        functions: ordered.functions.length,
        classes: ordered.classes.length,
        structs: ordered.structs.length,
        interfaces: ordered.interfaces.length
      },
      conflicts: validation.issues.length,
      resolved: this.conflicts.length,
      adaptations: this.adaptations.length,
      code: assembledCode
    };

    return report;
  }

  /**
   * 契约去重
   */
  _deduplicateContracts (contracts) {
    const dedup = {
      functions: [],
      classes: [],
      structs: [],
      interfaces: [],
      types: [],
      imports: [...new Set(contracts.imports)],
      includes: [...new Set(contracts.includes)]
    };

    // 函数去重
    const funcMap = new Map();
    for (const f of contracts.functions) {
      if (!funcMap.has(f.name)) {
        funcMap.set(f.name, f);
      } else {
        // 签名相同则忽略，不同则记录冲突
        const existing = funcMap.get(f.name);
        if (existing.signature !== f.signature) {
          this.conflicts.push({
            type: 'function',
            name: f.name,
            signatures: [existing.signature, f.signature]
          });
        }
      }
    }
    dedup.functions = [...funcMap.values()];

    // 类去重
    const classMap = new Map();
    for (const c of contracts.classes) {
      if (!classMap.has(c.name)) {
        classMap.set(c.name, c);
      }
    }
    dedup.classes = [...classMap.values()];

    // 结构体去重
    const structMap = new Map();
    for (const s of contracts.structs) {
      if (!structMap.has(s.name)) {
        structMap.set(s.name, s);
      }
    }
    dedup.structs = [...structMap.values()];

    // 接口去重
    const interfaceMap = new Map();
    for (const i of contracts.interfaces) {
      if (!interfaceMap.has(i.name)) {
        interfaceMap.set(i.name, i);
      }
    }
    dedup.interfaces = [...interfaceMap.values()];

    return dedup;
  }

  /**
   * 按依赖关系排序
   */
  _orderByDependencies (contracts) {
    // 简单排序：结构体 -> 接口 -> 类 -> 函数
    return {
      includes: contracts.includes,
      imports: contracts.imports,
      structs: contracts.structs,
      interfaces: contracts.interfaces,
      types: contracts.types,
      classes: contracts.classes,
      functions: contracts.functions
    };
  }

  /**
   * 生成拼装代码
   */
  _generateCode (ordered, lang, validation) {
    const generators = {
      c: this._generateCCode.bind(this),
      python: this._generatePythonCode.bind(this),
      javascript: this._generateJSCode.bind(this),
      typescript: this._generateTSCode.bind(this),
      java: this._generateJavaCode.bind(this),
      go: this._generateGoCode.bind(this),
      rust: this._generateRustCode.bind(this)
    };

    const generator = generators[lang] || generators.c;
    return generator(ordered, validation);
  }

  /**
   * 生成 C 语言代码
   */
  _generateCCode (ordered, validation) {
    let code = '';

    // includes
    for (const inc of ordered.includes) {
      code += `#include <${inc}>\n`;
    }
    if (ordered.includes.length > 0) code += '\n';

    // typedefs
    for (const t of ordered.types || []) {
      code += `typedef ${t.original} ${t.alias};\n`;
    }
    if (ordered.types?.length > 0) code += '\n';

    // structs
    for (const s of ordered.structs) {
      code += `struct ${s.name} {\n`;
      for (const f of s.fields) {
        code += `    ${f.type} ${f.name};\n`;
      }
      code += '};\n\n';
    }

    // function declarations
    code += '// 函数声明\n';
    for (const f of ordered.functions) {
      code += `${f.signature};\n`;
    }
    code += '\n';

    // 冲突处理提示
    if (validation.issues.length > 0) {
      code += '// ⚠️ 契约冲突提示：\n';
      for (const issue of validation.issues) {
        code += `// - ${issue.details}\n`;
      }
      code += '\n';
    }

    return code;
  }

  /**
   * 生成 Python 代码
   */
  _generatePythonCode (ordered, validation) {
    let code = '';

    // imports
    for (const imp of ordered.imports) {
      code += `import ${imp}\n`;
    }
    if (ordered.imports.length > 0) code += '\n';

    // classes
    for (const c of ordered.classes) {
      code += `class ${c.name}${c.inherits?.length > 0 ? `(${c.inherits.join(', ')})` : ''}:\n`;
      code += '    pass  # TODO: 实现类方法\n\n';
    }

    // functions
    for (const f of ordered.functions) {
      code += `def ${f.name}(${f.params?.map(p => p.name).join(', ') || ''})${f.returnType !== 'Any' ? ` -> ${f.returnType}` : ''}:\n`;
      code += '    pass  # TODO: 实现\n\n';
    }

    return code;
  }

  /**
   * 生成 JavaScript/TypeScript 代码
   */
  _generateJSCode (ordered, validation) {
    let code = '';

    // imports
    for (const imp of ordered.imports) {
      code += `import ${imp};\n`;
    }
    if (ordered.imports.length > 0) code += '\n';

    // classes
    for (const c of ordered.classes) {
      code += `class ${c.name}${c.inherits ? ` extends ${c.inherits}` : ''} {\n`;
      code += '  constructor() {}\n';
      code += '}\n\n';
    }

    // functions
    for (const f of ordered.functions) {
      if (f.isArrow) {
        code += `const ${f.name} = (${f.params?.map(p => p.name).join(', ') || ''}) => {\n`;
        code += '  // TODO: 实现\n';
        code += '};\n\n';
      } else {
        code += `function ${f.name}(${f.params?.map(p => p.name).join(', ') || ''}) {\n`;
        code += '  // TODO: 实现\n';
        code += '}\n\n';
      }
    }

    // exports
    for (const exp of ordered.exports || []) {
      code += `export { ${exp} };\n`;
    }

    return code;
  }

  /**
   * 生成 TypeScript 代码（带类型）
   */
  _generateTSCode (ordered, validation) {
    let code = '';

    // imports
    for (const imp of ordered.imports) {
      code += `import { ${imp} } from '...';\n`;
    }
    if (ordered.imports.length > 0) code += '\n';

    // interfaces
    for (const i of ordered.interfaces) {
      code += `interface ${i.name}${i.extends ? ` extends ${i.extends}` : ''} {\n`;
      for (const p of i.properties) {
        code += `  ${p.name}: ${p.type};\n`;
      }
      code += '}\n\n';
    }

    // types
    for (const t of ordered.types || []) {
      code += `type ${t.name} = ${t.definition};\n\n`;
    }

    // classes
    for (const c of ordered.classes) {
      code += `class ${c.name}${c.inherits ? ` extends ${c.inherits}` : ''} {\n`;
      code += '  constructor() {}\n';
      code += '}\n\n';
    }

    // functions
    for (const f of ordered.functions) {
      const params = f.params?.map(p => `${p.name}: ${p.type || 'any'}`).join(', ') || '';
      code += `function ${f.name}(${params}): ${f.returnType || 'any'} {\n`;
      code += '  // TODO: 实现\n';
      code += '}\n\n';
    }

    return code;
  }

  /**
   * 生成 Java 代码
   */
  _generateJavaCode (ordered, validation) {
    let code = '';

    // package declaration (placeholder)
    code += 'package com.generated;\n\n';

    // imports
    for (const imp of ordered.imports || []) {
      code += `import ${imp};\n`;
    }
    if (ordered.imports?.length > 0) code += '\n';

    // interfaces
    for (const i of ordered.interfaces) {
      code += `${i.visibility} interface ${i.name}${i.extends?.length > 0 ? ` extends ${i.extends.join(', ')}` : ''} {\n`;
      code += '}\n\n';
    }

    // classes
    for (const c of ordered.classes) {
      code += `${c.visibility} class ${c.name}${c.extends ? ` extends ${c.extends}` : ''}${c.implements?.length > 0 ? ` implements ${c.implements.join(', ')}` : ''} {\n`;
      code += `  public ${c.name}() {}\n`;
      code += '}\n\n';
    }

    return code;
  }

  /**
   * 生成 Go 代码
   */
  _generateGoCode (ordered, validation) {
    let code = 'package main\n\n';

    // imports
    if (ordered.imports?.length > 0) {
      code += 'import (\n';
      for (const imp of ordered.imports) {
        code += `  "${imp}"\n`;
      }
      code += ')\n\n';
    }

    // interfaces
    for (const i of ordered.interfaces) {
      code += `type ${i.name} interface {\n`;
      for (const m of i.methods) {
        code += `  ${m}\n`;
      }
      code += '}\n\n';
    }

    // structs
    for (const s of ordered.structs) {
      code += `type ${s.name} struct {\n`;
      for (const f of s.fields) {
        code += `  ${f.name} ${f.type}\n`;
      }
      code += '}\n\n';
    }

    // functions
    for (const f of ordered.functions) {
      const params = f.params?.map(p => `${p.name} ${p.type}`).join(', ') || '';
      code += `func ${f.name}(${params}) ${f.returnType} {\n`;
      code += '  // TODO: 实现\n';
      code += '}\n\n';
    }

    return code;
  }

  /**
   * 生成 Rust 代码
   */
  _generateRustCode (ordered, validation) {
    let code = '';

    // structs
    for (const s of ordered.structs) {
      code += `${s.visibility === 'pub' ? 'pub ' : ''}struct ${s.name} {\n`;
      code += '  // fields\n';
      code += '}\n\n';
    }

    // traits
    for (const t of ordered.traits) {
      code += `${t.visibility === 'pub' ? 'pub ' : ''}trait ${t.name} {\n`;
      code += '  // methods\n';
      code += '}\n\n';
    }

    // functions
    for (const f of ordered.functions) {
      const params = f.params?.map(p => `${p.name}: ${p.type}`).join(', ') || '';
      code += `${f.visibility === 'pub' ? 'pub ' : ''}fn ${f.name}(${params})${f.returnType !== 'void' ? ` -> ${f.returnType}` : ''} {\n`;
      code += '  // TODO: 实现\n';
      code += '}\n\n';
    }

    return code;
  }

  /**
   * 获取拼装报告
   */
  getAssemblyReport () {
    return {
      contractsExtracted: this.contracts.size,
      conflictsDetected: this.conflicts.length,
      adaptationsGenerated: this.adaptations.length,
      conflicts: this.conflicts,
      adaptations: this.adaptations
    };
  }
}

module.exports = ContractAssembler;
