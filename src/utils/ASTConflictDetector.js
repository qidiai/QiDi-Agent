/**
 * AST 结构化冲突检测器
 *
 * 基于正则模拟 AST 解析，提取代码结构化信息（函数/类/变量/导入），
 * 对比多版本代码的结构差异，检测以下冲突类型：
 * - 签名冲突：同名函数参数/返回值不同
 * - 结构冲突：同类字段/方法不同
 * - 命名冲突：同作用域同名不同含义
 * - 依赖冲突：导入/引用不兼容
 * - 语义冲突：调用未定义符号
 *
 * 不依赖 tree-sitter 原生库，使用正则+启发式解析实现跨语言支持。
 */

const logger = require('./Logger')('ASTConflictDetector');

// ── 语言提取规则 ──

const LANG_PATTERNS = {
  javascript: {
    functionDef: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g,
    arrowFunc: /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g,
    classDef: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{/g,
    methodDef: /(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/g,
    varDef: /(?:const|let|var)\s+(\w+)\s*(?==)/g,
    importDef: /import\s+(?:(\{\s*[^}]+\s*\})|(\*\s+as\s+\w+)|(\w+))?\s*(?:from\s+)?['"]([^'"]+)['"]/g,
    exportDef: /export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)/g,
    typeAnnotation: /:\s*(\w+(?:<[^>]+>)?)/g
  },
  typescript: {
    functionDef: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?::\s*\S+)?\s*(?:\{|=>)/g,
    arrowFunc: /(?:const|let|var)\s+(\w+)\s*(?::\s*\S+)?\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*\S+)?\s*=>/g,
    classDef: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?\s*\{/g,
    interfaceDef: /(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([^{]+))?\s*\{/g,
    methodDef: /(?:public|private|protected|static|async|readonly|\s)*(\w+)\s*\(([^)]*)\)\s*(?::\s*\S+)?\s*\{/g,
    varDef: /(?:const|let|var)\s+(\w+)\s*(?::\s*\S+)?\s*(?==)/g,
    importDef: /import\s+(?:(\{\s*[^}]+\s*\})|(\*\s+as\s+\w+)|(\w+)(?:\s*,\s*\{[^}]+\})?)?\s*(?:from\s+)?['"]([^'"]+)['"]/g,
    typeDef: /(?:export\s+)?type\s+(\w+)\s*=/g,
    enumDef: /(?:export\s+)?(?:const\s+)?enum\s+(\w+)\s*\{/g
  },
  python: {
    functionDef: /^\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gm,
    classDef: /^\s*class\s+(\w+)(?:\(([^)]*)\))?\s*:/gm,
    varDef: /^\s*(\w+)\s*=\s*(?!def\s|class\s)/gm,
    importDef: /(?:from\s+([\w.]+)\s+)?import\s+([\w.*]+)/g,
    decorator: /@(\w+)/g
  },
  c: {
    functionDef: /^\s*(?:static\s+|extern\s+|inline\s+)*(\w[\w\s*]*?)\s+(\w+)\s*\(([^)]*)\)/gm,
    structDef: /(?:typedef\s+)?struct\s+(\w+)\s*\{/g,
    typedefDef: /typedef\s+.*?\s+(\w+)\s*;/g,
    includeDef: /#include\s*[<"]([^>"]+)[>"]/g,
    macroDef: /#define\s+(\w+)/g
  },
  cpp: {
    functionDef: /^\s*(?:::|static\s+|inline\s+|virtual\s+|override\s+)*([\w:]+(?:\s*<[^>]+>)?)\s+(\w+)\s*\(([^)]*)\)/gm,
    classDef: /(?:class|struct)\s+(\w+)(?:\s*:\s*(?:public|private|protected)\s+(\w+))?\s*\{/g,
    namespaceDef: /namespace\s+(\w+)\s*\{/g,
    includeDef: /#include\s*[<"]([^>"]+)[>"]/g,
    usingDef: /using\s+(?:namespace\s+)?([\w:]+)/g,
    templateDef: /template\s*<[^>]+>\s*(?:class|typename)\s+(\w+)/g
  },
  go: {
    functionDef: /func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)\s*\(([^)]*)\)/g,
    structDef: /type\s+(\w+)\s+struct\s*\{/g,
    interfaceDef: /type\s+(\w+)\s+interface\s*\{/g,
    importDef: /import\s+(?:"([^"]+)"|\(\s*([\s\S]*?)\s*\))/g,
    varDef: /(?:var\s+(\w+)|(\w+)\s*:=)/g,
    packageDef: /package\s+(\w+)/g
  },
  rust: {
    functionDef: /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/g,
    structDef: /(?:pub\s+)?struct\s+(\w+)/g,
    enumDef: /(?:pub\s+)?enum\s+(\w+)/g,
    traitDef: /(?:pub\s+)?trait\s+(\w+)/g,
    implDef: /impl(?:<[^>]+>)?\s+([\w:]+)/g,
    useDef: /use\s+([\w:]+)/g
  },
  java: {
    functionDef: /(?:public|private|protected|static|final|abstract|\s)*(\w+(?:<[^>]+>)?)\s+(\w+)\s*\(([^)]*)\)/g,
    classDef: /(?:public|private|protected|static|final|abstract|\s)*class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?\s*\{/g,
    interfaceDef: /(?:public|private|protected|\s)*interface\s+(\w+)(?:\s+extends\s+([^{]+))?\s*\{/g,
    importDef: /import\s+([\w.]+);/g,
    packageDef: /package\s+([\w.]+);/g
  }
};

// ── 符号提取器 ──

class SymbolExtractor {
  static extract (code, language) {
    const lang = (language || '').toLowerCase();
    const patterns = LANG_PATTERNS[lang] || LANG_PATTERNS.javascript;

    const symbols = {
      functions: [],
      classes: [],
      interfaces: [],
      structs: [],
      variables: [],
      imports: [],
      exports: [],
      namespaces: [],
      macros: [],
      enums: [],
      traits: [],
      impls: []
    };

    // 提取函数
    if (patterns.functionDef) {
      let match;
      patterns.functionDef.lastIndex = 0;
      while ((match = patterns.functionDef.exec(code)) !== null) {
        const name = lang === 'c' || lang === 'cpp' || lang === 'java'
          ? match[2]
          : match[1];
        const params = lang === 'c' || lang === 'cpp' || lang === 'java'
          ? match[3]
          : (match[2] || '');
        const returnType = lang === 'c' || lang === 'cpp' || lang === 'java'
          ? match[1]
          : undefined;
        symbols.functions.push({
          name,
          params: SymbolExtractor._parseParams(params),
          returnType: returnType?.trim(),
          signature: match[0].trim(),
          raw: match[0]
        });
      }
    }

    // 提取箭头函数 (JS/TS)
    if (patterns.arrowFunc) {
      let match;
      patterns.arrowFunc.lastIndex = 0;
      while ((match = patterns.arrowFunc.exec(code)) !== null) {
        symbols.functions.push({
          name: match[1],
          params: SymbolExtractor._parseParams(match[2]),
          returnType: undefined,
          signature: match[0].trim(),
          raw: match[0],
          type: 'arrow'
        });
      }
    }

    // 提取类
    if (patterns.classDef) {
      let match;
      patterns.classDef.lastIndex = 0;
      while ((match = patterns.classDef.exec(code)) !== null) {
        symbols.classes.push({
          name: match[1],
          parent: match[2] || null,
          implements: match[3] ? match[3].split(',').map(s => s.trim()) : [],
          raw: match[0]
        });
      }
    }

    // 提取接口
    if (patterns.interfaceDef) {
      let match;
      patterns.interfaceDef.lastIndex = 0;
      while ((match = patterns.interfaceDef.exec(code)) !== null) {
        symbols.interfaces.push({
          name: match[1],
          parent: match[2] ? match[2].split(',').map(s => s.trim()) : [],
          raw: match[0]
        });
      }
    }

    // 提取结构体
    if (patterns.structDef) {
      let match;
      patterns.structDef.lastIndex = 0;
      while ((match = patterns.structDef.exec(code)) !== null) {
        symbols.structs.push({
          name: match[1],
          raw: match[0]
        });
      }
    }

    // 提取变量
    if (patterns.varDef) {
      let match;
      patterns.varDef.lastIndex = 0;
      while ((match = patterns.varDef.exec(code)) !== null) {
        const varName = match[1] || match[2];
        if (varName) {
          symbols.variables.push({
            name: varName,
            raw: match[0]
          });
        }
      }
    }

    // 提取导入
    if (patterns.importDef) {
      let match;
      patterns.importDef.lastIndex = 0;
      while ((match = patterns.importDef.exec(code)) !== null) {
        let importPath, importNames;
        if (lang === 'python') {
          importPath = match[1] || '';
          importNames = match[2] || '';
        } else if (lang === 'c' || lang === 'cpp') {
          importPath = match[1];
          importNames = '';
        } else if (lang === 'java') {
          importPath = match[1];
          importNames = '';
        } else {
          importPath = match[4] || match[2] || '';
          importNames = match[1] || match[3] || '';
        }
        symbols.imports.push({
          path: importPath,
          names: importNames,
          raw: match[0]
        });
      }
    }

    // 提取导出
    if (patterns.exportDef) {
      let match;
      patterns.exportDef.lastIndex = 0;
      while ((match = patterns.exportDef.exec(code)) !== null) {
        symbols.exports.push({ name: match[1], raw: match[0] });
      }
    }

    // 提取命名空间
    if (patterns.namespaceDef) {
      let match;
      patterns.namespaceDef.lastIndex = 0;
      while ((match = patterns.namespaceDef.exec(code)) !== null) {
        symbols.namespaces.push({ name: match[1], raw: match[0] });
      }
    }

    // 提取宏
    if (patterns.macroDef) {
      let match;
      patterns.macroDef.lastIndex = 0;
      while ((match = patterns.macroDef.exec(code)) !== null) {
        symbols.macros.push({ name: match[1], raw: match[0] });
      }
    }

    // 提取枚举
    if (patterns.enumDef) {
      let match;
      patterns.enumDef.lastIndex = 0;
      while ((match = patterns.enumDef.exec(code)) !== null) {
        symbols.enums.push({ name: match[1], raw: match[0] });
      }
    }

    // 提取 trait
    if (patterns.traitDef) {
      let match;
      patterns.traitDef.lastIndex = 0;
      while ((match = patterns.traitDef.exec(code)) !== null) {
        symbols.traits.push({ name: match[1], raw: match[0] });
      }
    }

    // 提取 impl
    if (patterns.implDef) {
      let match;
      patterns.implDef.lastIndex = 0;
      while ((match = patterns.implDef.exec(code)) !== null) {
        symbols.impls.push({ name: match[1], raw: match[0] });
      }
    }

    return symbols;
  }

  static _parseParams (paramStr) {
    if (!paramStr || !paramStr.trim()) return [];
    return paramStr.split(',').map(p => {
      const trimmed = p.trim();
      if (!trimmed) return null;
      // 尝试提取参数名和类型
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        return { name: parts[parts.length - 1].replace(/[&*]/g, ''), type: parts.slice(0, -1).join(' ') };
      }
      return { name: trimmed.replace(/[&*]/g, ''), type: 'unknown' };
    }).filter(Boolean);
  }
}

// ── 冲突检测器 ──

class ASTConflictDetector {
  constructor (options = {}) {
    this.options = {
      strictMode: options.strictMode !== false,
      detectNamingConflicts: options.detectNamingConflicts !== false,
      detectSignatureConflicts: options.detectSignatureConflicts !== false,
      detectStructuralConflicts: options.detectStructuralConflicts !== false,
      detectDependencyConflicts: options.detectDependencyConflicts !== false,
      detectSemanticConflicts: options.detectSemanticConflicts !== false,
      ...options
    };
  }

  /**
   * 检测多版本代码之间的结构化冲突
   * @param {Array} versions - [{ agentName, content, language, filePath }]
   * @returns {Object} { conflicts, symbolMaps, summary }
   */
  detect (versions) {
    if (!versions || versions.length < 2) {
      return { conflicts: [], symbolMaps: [], summary: { total: 0, byType: {} } };
    }

    // 提取每个版本的符号表
    const symbolMaps = versions.map(v => ({
      agentName: v.agentName,
      filePath: v.filePath,
      language: v.language,
      symbols: SymbolExtractor.extract(v.content, v.language)
    }));

    const conflicts = [];

    // 1. 签名冲突检测
    if (this.options.detectSignatureConflicts) {
      conflicts.push(...this._detectSignatureConflicts(symbolMaps));
    }

    // 2. 结构冲突检测
    if (this.options.detectStructuralConflicts) {
      conflicts.push(...this._detectStructuralConflicts(symbolMaps));
    }

    // 3. 命名冲突检测
    if (this.options.detectNamingConflicts) {
      conflicts.push(...this._detectNamingConflicts(symbolMaps));
    }

    // 4. 依赖冲突检测
    if (this.options.detectDependencyConflicts) {
      conflicts.push(...this._detectDependencyConflicts(symbolMaps));
    }

    // 5. 语义冲突检测
    if (this.options.detectSemanticConflicts) {
      conflicts.push(...this._detectSemanticConflicts(symbolMaps, versions));
    }

    // 按类型汇总
    const byType = {};
    for (const c of conflicts) {
      byType[c.type] = (byType[c.type] || 0) + 1;
    }

    return {
      conflicts,
      symbolMaps,
      summary: {
        total: conflicts.length,
        byType,
        versionCount: versions.length,
        agentNames: versions.map(v => v.agentName)
      }
    };
  }

  /**
   * 签名冲突：同名函数参数/返回值不同
   */
  _detectSignatureConflicts (symbolMaps) {
    const conflicts = [];
    const funcMap = new Map(); // name -> [{ agentName, func }]

    for (const sm of symbolMaps) {
      for (const fn of sm.symbols.functions) {
        if (!funcMap.has(fn.name)) funcMap.set(fn.name, []);
        funcMap.get(fn.name).push({ agentName: sm.agentName, func: fn });
      }
    }

    for (const [name, entries] of funcMap) {
      if (entries.length < 2) continue;

      // 比较参数
      const paramSets = entries.map(e => ({
        agentName: e.agentName,
        paramCount: e.func.params.length,
        paramTypes: e.func.params.map(p => p.type).join(','),
        paramNames: e.func.params.map(p => p.name).join(',')
      }));

      const uniqueParamCounts = [...new Set(paramSets.map(p => p.paramCount))];
      const uniqueParamTypes = [...new Set(paramSets.map(p => p.paramTypes))];

      if (uniqueParamCounts.length > 1) {
        conflicts.push({
          type: 'signature',
          severity: 'high',
          symbolName: name,
          symbolKind: 'function',
          description: `函数 "${name}" 参数数量不一致: ${paramSets.map(p => `${p.agentName}=${p.paramCount}个`).join(', ')}`,
          versions: entries.map(e => ({
            agentName: e.agentName,
            signature: e.func.signature,
            paramCount: e.func.params.length,
            params: e.func.params
          })),
          suggestion: '统一参数数量，选择参数更完整的版本或补全缺失参数',
          autoResolvable: true,
          resolution: 'select_most_complete'
        });
      } else if (uniqueParamTypes.length > 1) {
        conflicts.push({
          type: 'signature',
          severity: 'medium',
          symbolName: name,
          symbolKind: 'function',
          description: `函数 "${name}" 参数类型不一致: ${paramSets.map(p => `${p.agentName}=[${p.paramTypes}]`).join(', ')}`,
          versions: entries.map(e => ({
            agentName: e.agentName,
            signature: e.func.signature,
            paramTypes: e.func.params.map(p => p.type)
          })),
          suggestion: '统一参数类型，确保类型兼容',
          autoResolvable: false,
          resolution: 'manual'
        });
      }

      // 比较返回类型
      const returnTypes = entries.filter(e => e.func.returnType).map(e => ({
        agentName: e.agentName,
        returnType: e.func.returnType
      }));
      if (returnTypes.length >= 2) {
        const uniqueReturnTypes = [...new Set(returnTypes.map(r => r.returnType))];
        if (uniqueReturnTypes.length > 1) {
          conflicts.push({
            type: 'signature',
            severity: 'medium',
            symbolName: name,
            symbolKind: 'function',
            description: `函数 "${name}" 返回类型不一致: ${returnTypes.map(r => `${r.agentName}=${r.returnType}`).join(', ')}`,
            versions: returnTypes,
            suggestion: '统一返回类型，优先选择更具体的类型',
            autoResolvable: false,
            resolution: 'manual'
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * 结构冲突：同类/结构体字段/方法不同
   */
  _detectStructuralConflicts (symbolMaps) {
    const conflicts = [];
    const classMap = new Map();

    for (const sm of symbolMaps) {
      for (const cls of sm.symbols.classes) {
        if (!classMap.has(cls.name)) classMap.set(cls.name, []);
        classMap.get(cls.name).push({ agentName: sm.agentName, cls, symbols: sm.symbols });
      }
    }

    for (const [name, entries] of classMap) {
      if (entries.length < 2) continue;

      // 检查父类不一致
      const parents = entries.filter(e => e.cls.parent).map(e => ({
        agentName: e.agentName,
        parent: e.cls.parent
      }));
      if (parents.length >= 1) {
        const uniqueParents = [...new Set(parents.map(p => p.parent))];
        if (uniqueParents.length > 1) {
          conflicts.push({
            type: 'structural',
            severity: 'high',
            symbolName: name,
            symbolKind: 'class',
            description: `类 "${name}" 继承不同的父类: ${parents.map(p => `${p.agentName}→${p.parent}`).join(', ')}`,
            versions: parents,
            suggestion: '统一继承关系，确保架构一致性',
            autoResolvable: false,
            resolution: 'manual'
          });
        }
      }

      // 检查 implements 不一致
      const allImplements = entries.filter(e => e.cls.implements && e.cls.implements.length > 0);
      if (allImplements.length >= 1) {
        const implSets = allImplements.map(e => ({
          agentName: e.agentName,
          implements: e.cls.implements.sort().join(',')
        }));
        const uniqueImpls = [...new Set(implSets.map(i => i.implements))];
        if (uniqueImpls.length > 1) {
          conflicts.push({
            type: 'structural',
            severity: 'medium',
            symbolName: name,
            symbolKind: 'class',
            description: `类 "${name}" 实现不同接口: ${implSets.map(i => `${i.agentName}=[${i.implements}]`).join(', ')}`,
            versions: implSets,
            suggestion: '统一接口实现，合并所有需要的接口',
            autoResolvable: true,
            resolution: 'merge_all'
          });
        }
      }
    }

    // 检查结构体定义冲突
    const structMap = new Map();
    for (const sm of symbolMaps) {
      for (const st of sm.symbols.structs) {
        if (!structMap.has(st.name)) structMap.set(st.name, []);
        structMap.get(st.name).push({ agentName: sm.agentName, struct: st });
      }
    }
    for (const [name, entries] of structMap) {
      if (entries.length >= 2) {
        conflicts.push({
          type: 'structural',
          severity: 'medium',
          symbolName: name,
          symbolKind: 'struct',
          description: `结构体 "${name}" 在 ${entries.length} 个版本中都有定义`,
          versions: entries.map(e => ({ agentName: e.agentName })),
          suggestion: '合并结构体定义，保留字段最完整的版本',
          autoResolvable: true,
          resolution: 'select_most_complete'
        });
      }
    }

    return conflicts;
  }

  /**
   * 命名冲突：同作用域同名不同含义
   */
  _detectNamingConflicts (symbolMaps) {
    const conflicts = [];

    // 收集所有符号名
    const nameRegistry = new Map(); // name -> [{ agentName, kind }]

    for (const sm of symbolMaps) {
      const allNames = [
        ...sm.symbols.functions.map(f => ({ name: f.name, kind: 'function' })),
        ...sm.symbols.classes.map(c => ({ name: c.name, kind: 'class' })),
        ...sm.symbols.variables.map(v => ({ name: v.name, kind: 'variable' })),
        ...sm.symbols.structs.map(s => ({ name: s.name, kind: 'struct' })),
        ...sm.symbols.interfaces.map(i => ({ name: i.name, kind: 'interface' }))
      ];

      for (const item of allNames) {
        if (!nameRegistry.has(item.name)) nameRegistry.set(item.name, []);
        nameRegistry.get(item.name).push({ agentName: sm.agentName, ...item });
      }
    }

    for (const [name, entries] of nameRegistry) {
      if (entries.length < 2) continue;

      // 检查同名不同类型
      const kinds = [...new Set(entries.map(e => e.kind))];
      if (kinds.length > 1) {
        conflicts.push({
          type: 'naming',
          severity: 'high',
          symbolName: name,
          symbolKind: kinds.join('/'),
          description: `符号 "${name}" 在不同版本中具有不同类型: ${entries.map(e => `${e.agentName}=${e.kind}`).join(', ')}`,
          versions: entries,
          suggestion: '重命名冲突符号，确保语义一致',
          autoResolvable: false,
          resolution: 'manual'
        });
      }

      // 检查同名同类型但来自不同 agent（重复定义）
      if (kinds.length === 1) {
        const agents = [...new Set(entries.map(e => e.agentName))];
        if (agents.length >= 2) {
          conflicts.push({
            type: 'naming',
            severity: 'low',
            symbolName: name,
            symbolKind: kinds[0],
            description: `符号 "${name}" (${kinds[0]}) 在 ${agents.length} 个版本中重复定义`,
            versions: entries,
            suggestion: '选择最优实现，移除重复定义',
            autoResolvable: true,
            resolution: 'select_best'
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * 依赖冲突：导入/引用不兼容
   */
  _detectDependencyConflicts (symbolMaps) {
    const conflicts = [];

    // 收集所有导入
    const importMap = new Map(); // path -> [{ agentName, names }]

    for (const sm of symbolMaps) {
      for (const imp of sm.symbols.imports) {
        const key = imp.path || imp.names;
        if (!key) continue;
        if (!importMap.has(key)) importMap.set(key, []);
        importMap.get(key).push({ agentName: sm.agentName, ...imp });
      }
    }

    // 检查导入冲突：同一模块但导入不同符号
    for (const [path, entries] of importMap) {
      if (entries.length < 2) continue;

      const agents = [...new Set(entries.map(e => e.agentName))];
      if (agents.length >= 2) {
        const nameSets = entries.map(e => ({
          agentName: e.agentName,
          names: e.names || ''
        }));
        const uniqueNameSets = [...new Set(nameSets.map(n => n.names))];
        if (uniqueNameSets.length > 1 && uniqueNameSets.some(n => n)) {
          conflicts.push({
            type: 'dependency',
            severity: 'low',
            symbolName: path,
            symbolKind: 'import',
            description: `模块 "${path}" 在不同版本中导入不同符号`,
            versions: nameSets,
            suggestion: '合并导入，保留所有需要的符号',
            autoResolvable: true,
            resolution: 'merge_all'
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * 语义冲突：调用未定义符号
   */
  _detectSemanticConflicts (symbolMaps, versions) {
    const conflicts = [];

    // 合并所有定义的符号名
    const allDefinedNames = new Set();
    for (const sm of symbolMaps) {
      sm.symbols.functions.forEach(f => allDefinedNames.add(f.name));
      sm.symbols.classes.forEach(c => allDefinedNames.add(c.name));
      sm.symbols.variables.forEach(v => allDefinedNames.add(v.name));
      sm.symbols.structs.forEach(s => allDefinedNames.add(s.name));
      sm.symbols.interfaces.forEach(i => allDefinedNames.add(i.name));
      sm.symbols.imports.forEach(i => {
        if (i.names) {
          i.names.split(',').forEach(n => {
            const trimmed = n.trim().replace(/[{}]/g, '').trim();
            if (trimmed) allDefinedNames.add(trimmed);
          });
        }
      });
    }

    // 内置/常见符号白名单
    const builtinSymbols = new Set([
      'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'return',
      'try', 'catch', 'finally', 'throw', 'new', 'delete', 'typeof', 'instanceof',
      'await', 'async', 'yield', 'import', 'from', 'export', 'default', 'class',
      'function', 'const', 'let', 'var', 'static', 'public', 'private', 'protected',
      'void', 'int', 'char', 'float', 'double', 'long', 'short', 'unsigned', 'signed',
      'bool', 'string', 'object', 'array', 'map', 'set', 'promise', 'date', 'math',
      'console', 'window', 'document', 'require', 'module', 'exports', 'process',
      'print', 'len', 'range', 'list', 'dict', 'str', 'int', 'float', 'bool',
      'none', 'true', 'false', 'null', 'undefined', 'nan', 'infinity',
      'printf', 'scanf', 'malloc', 'free', 'memcpy', 'memset', 'strlen', 'sizeof',
      'std', 'cout', 'cin', 'endl', 'vector', 'string', 'make', 'append', 'copy'
    ]);

    // 检查每个版本中的函数调用
    for (let i = 0; i < versions.length; i++) {
      const version = versions[i];
      const content = version.content;
      if (!content) continue;

      // 提取函数调用
      const callPattern = /\b(\w+)\s*\(/g;
      let match;
      const checkedCalls = new Set();

      while ((match = callPattern.exec(content)) !== null) {
        const funcName = match[1];
        if (checkedCalls.has(funcName)) continue;
        checkedCalls.add(funcName);

        if (!allDefinedNames.has(funcName) && !builtinSymbols.has(funcName)) {
          // 检查是否是方法调用（obj.method()）
          const beforeCall = content.substring(Math.max(0, match.index - 20), match.index);
          if (/\.\s*$/.test(beforeCall)) continue; // 方法调用，跳过

          conflicts.push({
            type: 'semantic',
            severity: 'medium',
            symbolName: funcName,
            symbolKind: 'call',
            description: `版本 "${version.agentName}" 调用未定义函数 "${funcName}"`,
            versions: [{ agentName: version.agentName, call: funcName }],
            suggestion: `确保 "${funcName}" 已定义或正确导入`,
            autoResolvable: false,
            resolution: 'manual'
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * 生成冲突报告
   */
  generateReport (result) {
    const lines = [];
    lines.push('═══════════════════════════════════════════');
    lines.push('        AST 结构化冲突检测报告');
    lines.push('═══════════════════════════════════════════');
    lines.push('');
    lines.push(`检测版本数: ${result.summary.versionCount}`);
    lines.push(`参与 Agent: ${result.summary.agentNames.join(', ')}`);
    lines.push(`冲突总数: ${result.summary.total}`);
    lines.push('');

    if (result.summary.total === 0) {
      lines.push('✅ 未检测到结构化冲突');
      return lines.join('\n');
    }

    lines.push('冲突类型分布:');
    for (const [type, count] of Object.entries(result.summary.byType)) {
      lines.push(`  ${type}: ${count} 个`);
    }
    lines.push('');

    // 按严重程度排序
    const severityOrder = { high: 0, medium: 1, low: 2 };
    const sorted = [...result.conflicts].sort((a, b) =>
      (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3)
    );

    for (const c of sorted) {
      const icon = c.severity === 'high' ? '🔴' : c.severity === 'medium' ? '🟡' : '🟢';
      lines.push(`${icon} [${c.type}] ${c.description}`);
      if (c.suggestion) lines.push(`   建议: ${c.suggestion}`);
      lines.push('');
    }

    return lines.join('\n');
  }
}

module.exports = { ASTConflictDetector, SymbolExtractor };
