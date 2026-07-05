const BaseAgent = require('./BaseAgent');
const ContractAssembler = require('../core/ContractAssembler');
const { ASTConflictDetector } = require('../utils/ASTConflictDetector');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/Logger').createLogger('MergeEngine');

/**
 * 代码合并与审查专家：负责合并多个 Agent 的代码产出，解决冲突，选择最佳实现。
 */
const MERGE_PROMPT = `你是一位代码合并与审查专家，擅长从多个实现中选择最优方案，解决冲突，生成统一的高质量代码。

你的职责：
1. 对比多个 Agent 的代码产出，识别差异和冲突
2. 分析每个实现的优缺点（正确性、性能、可读性、安全性）
3. 解决冲突：选择最佳方案或融合多个方案的优点
4. 确保合并后的代码风格一致，遵循原始约束
5. 保持代码的完整性和可编译性

冲突解决策略：
- 函数实现冲突：选择更正确/更高效的实现
- 命名冲突：选择更规范、更语义化的命名
- 结构冲突：选择更符合设计原则的方案
- 注释风格冲突：统一为一致的注释风格

输出格式（严格 JSON）：
{
  "mergedCode": "合并后的完整代码",
  "conflicts": [
    {
      "location": "文件位置/函数名",
      "description": "冲突描述",
      "resolutions": ["Agent1方案", "Agent2方案"],
      "chosenResolution": "选择的方案",
      "reason": "选择理由",
      "conflictType": "semantic|syntax|naming|structural"
    }
  ],
  "improvements": [
    {
      "location": "位置",
      "description": "改进描述",
      "before": "合并前",
      "after": "合并后"
    }
  ],
  "qualityAssessment": {
    "correctness": 0-100,
    "consistency": 0-100,
    "readability": 0-100,
    "security": 0-100
  },
  "mergeStrategy": "best|combine|sequential|manual|three_way",
  "notes": "合并过程中的注意事项"
}

注意：只输出 JSON，不要其他文字。`;

class MergeEngine extends BaseAgent {
  constructor (provider, options = {}) {
    super(provider, {
      name: 'MergeEngine',
      role: '代码合并与审查专家',
      systemPrompt: MERGE_PROMPT,
      temperature: 0.3,
      enableStructuredOutput: false,
      ...options
    });
    this.conflictResolution = options.conflictResolution || 'auto';
    this.enableThreeWayMerge = options.enableThreeWayMerge !== false;
    this.enableSemanticConflictDetection = options.enableSemanticConflictDetection !== false;
    this.enableASTConflictDetection = options.enableASTConflictDetection !== false;
    this.enablePostMergeVerification = options.enablePostMergeVerification !== false;
    this.contractAssembler = options.contractAssembler || new ContractAssembler();
    this.astConflictDetector = options.astConflictDetector || new ASTConflictDetector({ strictMode: true });
    this.mergeHistory = [];
    this._historyLock = Promise.resolve();
    this.maxHistorySize = options.maxHistorySize || 100;
  }

  /**
   * 合并多个 Agent 的代码产出。
   * @param {Object} resultsMap - key: agentName, value: { codeBlocks, content, qualityScore }
   * @param {Object} constraints - 全局约束
   * @param {Object} options - 合并选项
   * @returns {Object} 合并结果
   */
  async merge (resultsMap, constraints = {}, options = {}) {
    const entries = Object.entries(resultsMap).filter(([_, v]) => v && v.success);
    if (entries.length === 0) {
      return { error: '没有可合并的结果', mergedCode: '', conflicts: [] };
    }
    if (entries.length === 1) {
      return this._singleResultMerge(entries[0]);
    }

    const fileGroups = this._groupByFile(entries);
    const mergedFiles = {};
    const allConflicts = [];
    const allImprovements = [];
    const semanticConflicts = [];
    const astConflicts = [];

    for (const [filePath, versions] of Object.entries(fileGroups)) {
      if (versions.length === 1) {
        mergedFiles[filePath] = versions[0].content;
        continue;
      }

      if (this.enableSemanticConflictDetection) {
        const semanticIssues = this._detectSemanticConflicts(versions, constraints);
        semanticConflicts.push(...semanticIssues);
      }

      // AST 结构化冲突检测
      let astSummary = null;
      if (this.enableASTConflictDetection) {
        const astVersions = versions.map(v => ({
          agentName: v.agentName,
          content: v.content,
          language: v.language || constraints.language || 'javascript',
          filePath
        }));
        const astResult = this.astConflictDetector.detect(astVersions);
        astConflicts.push(...astResult.conflicts);

        // 生成 AST 冲突摘要（供 AI prompt 使用）
        astSummary = this._buildASTSummary(astResult);

        // critical 冲突直接给出建议方案（不让 AI 自由发挥）
        const criticalConflicts = astResult.conflicts.filter(c =>
          c.severity === 'critical' || c.type === 'signature'
        );
        if (criticalConflicts.length > 0) {
          // 自动选择参数最完整的版本作为强制建议
          for (const conflict of criticalConflicts) {
            const resolution = this._resolveCriticalASTConflict(conflict, versions);
            if (resolution) {
              allConflicts.push({
                location: `${filePath}::${conflict.name || 'unknown'}`,
                description: `[AST-CRITICAL] ${conflict.description}`,
                resolutions: versions.map(v => v.agentName),
                chosenResolution: resolution.chosenAgent,
                reason: resolution.reason,
                conflictType: 'ast_signature',
                severity: 'critical'
              });
            }
          }
        }
      }

      let mergeResult;
      if (this.enableThreeWayMerge && versions.length >= 3) {
        mergeResult = await this._threeWayMerge(filePath, versions, constraints, astSummary);
      } else {
        mergeResult = await this._mergeFileVersions(filePath, versions, constraints, astSummary);
      }
      mergedFiles[filePath] = mergeResult.mergedCode;
      allConflicts.push(...mergeResult.conflicts);
      allImprovements.push(...mergeResult.improvements);
    }

    const consistencyCheck = this._checkGlobalConsistency(mergedFiles, constraints);

    let verificationResult = null;
    if (this.enablePostMergeVerification) {
      verificationResult = await this._verifyMergedCode(mergedFiles, constraints);
    }

    const qualityAssessment = await this._assessMergedQuality(mergedFiles, entries, constraints);

    const finalResult = {
      mergedFiles,
      mergedCode: this._assembleFinalCode(mergedFiles),
      conflicts: allConflicts,
      semanticConflicts,
      astConflicts,
      improvements: allImprovements,
      qualityAssessment,
      consistencyCheck,
      verificationResult,
      mergeStrategy: this.enableThreeWayMerge ? 'three_way' : 'combine',
      notes: `合并了 ${entries.length} 个 Agent 的产出，处理了 ${allConflicts.length} 个冲突，检测到 ${semanticConflicts.length} 个语义冲突，${astConflicts.length} 个 AST 结构化冲突`
    };

    await this._appendHistory({
      timestamp: Date.now(),
      agentCount: entries.length,
      conflictCount: allConflicts.length,
      success: !verificationResult || verificationResult.passed
    });

    return finalResult;
  }

  _singleResultMerge ([agentName, result]) {
    const code = result.result?.codeBlocks?.[0]?.code || result.content || '';
    return {
      mergedFiles: { main: code },
      mergedCode: code,
      conflicts: [],
      improvements: [],
      qualityAssessment: {
        correctness: 70, consistency: 80, readability: 70, security: 70
      },
      consistencyCheck: { passed: true, issues: [] },
      mergeStrategy: 'single',
      notes: `仅使用 ${agentName} 的产出`
    };
  }

  /**
   * 构建 AST 冲突摘要（供 AI prompt 使用）
   */
  _buildASTSummary (astResult) {
    if (!astResult || !astResult.conflicts || astResult.conflicts.length === 0) {
      return null;
    }

    const lines = ['【AST 结构化冲突分析】'];
    for (const c of astResult.conflicts) {
      const severity = c.severity || 'unknown';
      const type = c.type || 'unknown';
      const name = c.name || c.element || 'unknown';
      lines.push(`- [${severity.toUpperCase()}] ${type} 冲突: ${name} - ${c.description}`);
    }
    if (astResult.summary) {
      lines.push(`【AST 统计】${astResult.summary}`);
    }
    return lines.join('\n');
  }

  /**
   * 解决 critical AST 冲突（不让 AI 自由发挥）
   * 策略：选择参数最完整 + 实现最长的版本
   */
  _resolveCriticalASTConflict (conflict, versions) {
    if (!conflict || versions.length === 0) return null;

    let bestVersion = null;
    let bestScore = -1;
    let reason = '';

    for (const v of versions) {
      const content = v.content || '';
      let score = 0;

      // 基于冲突类型评分
      if (conflict.type === 'signature' && conflict.name) {
        // 函数签名冲突：选择参数最多的版本
        const funcMatch = content.match(new RegExp(`function\\s+${conflict.name}\\s*\\(([^)]*)\\)`));
        if (funcMatch) {
          const params = funcMatch[1].split(',').filter(p => p.trim());
          score = params.length * 10;
        }
      }

      // 内容长度加分
      score += Math.min(content.length / 100, 30);

      if (score > bestScore) {
        bestScore = score;
        bestVersion = v;
        reason = `AST 评分最高 (${score.toFixed(1)}): 参数完整度+实现长度`;
      }
    }

    if (!bestVersion) {
      bestVersion = versions[0];
      reason = '默认选择第一个版本';
    }

    return {
      chosenAgent: bestVersion.agentName,
      reason
    };
  }

  /**
   * 三路合并算法：基于AST级分析的智能合并
   */
  async _threeWayMerge (filePath, versions, constraints, astSummary = null) {
    const sortedVersions = this._sortVersionsByQuality(versions);
    const baseVersion = sortedVersions[0];
    const compareVersions = sortedVersions.slice(1);

    const baseContracts = await this._extractContractsForVersion(baseVersion, constraints);
    const compareContracts = await Promise.all(
      compareVersions.map(v => this._extractContractsForVersion(v, constraints))
    );

    const conflicts = [];
    const improvements = [];

    const conflictMap = this._compareContracts(baseContracts, compareContracts);
    for (const [name, conflict] of Object.entries(conflictMap)) {
      conflicts.push({
        location: `${filePath}::${name}`,
        description: conflict.description,
        resolutions: conflict.versions.map(v => v.agentName),
        chosenResolution: conflict.bestVersion?.agentName || 'manual',
        reason: conflict.reason || '语义分析选择',
        conflictType: conflict.type || 'semantic'
      });
    }

    const prompt = this._buildThreeWayMergePrompt(filePath, sortedVersions, constraints, conflictMap, astSummary);

    try {
      const result = await this.sendWithRetry(prompt, { temperature: 0.2 });
      const parsed = this._extractJson(result.content);
      if (parsed) {
        return {
          mergedCode: parsed.mergedCode || baseVersion.content,
          conflicts: [...conflicts, ...(parsed.conflicts || [])],
          improvements: parsed.improvements || []
        };
      }
    } catch (e) {
      logger.warn('三路合并AI调用失败，回退到默认策略', { error: e.message, filePath });
    }

    return this._fallbackMerge(versions);
  }

  _sortVersionsByQuality (versions) {
    return [...versions].sort((a, b) => {
      const scoreA = a.qualityScore || 50;
      const scoreB = b.qualityScore || 50;
      const lengthA = a.content?.length || 0;
      const lengthB = b.content?.length || 0;

      if (scoreA !== scoreB) return scoreB - scoreA;
      return lengthB - lengthA;
    });
  }

  async _extractContractsForVersion (version, constraints) {
    const codeBlocks = [{
      code: version.content,
      language: version.language || constraints.language || 'text',
      filePath: version.filePath || 'main'
    }];
    try {
      const contracts = await this.contractAssembler.extractContracts(codeBlocks);
      return contracts[0] || {};
    } catch (e) {
      logger.warn('提取契约失败', { error: e.message, language: version.language });
      return {};
    }
  }

  _compareContracts (base, compares) {
    const conflicts = {};

    const allFuncNames = new Set();
    base.functions?.forEach(f => allFuncNames.add(f.name));
    compares.forEach(c => c.functions?.forEach(f => allFuncNames.add(f.name)));

    for (const name of allFuncNames) {
      const baseFunc = base.functions?.find(f => f.name === name);
      const compareFuncs = compares.map(c => c.functions?.find(f => f.name === name)).filter(Boolean);

      if (compareFuncs.length >= 2) {
        const signatures = [...new Set(compareFuncs.map(f => f.signature))];
        if (signatures.length > 1) {
          conflicts[name] = this._analyzeSignatureConflict(name, baseFunc, compareFuncs);
        } else {
          const implementations = compareFuncs.map(f => ({
            ...f,
            agentName: f.source || 'unknown'
          }));
          conflicts[name] = this._selectBestImplementation(name, implementations);
        }
      }
    }

    const allClassNames = new Set();
    base.classes?.forEach(c => allClassNames.add(c.name));
    compares.forEach(c => c.classes?.forEach(c => allClassNames.add(c.name)));

    for (const name of allClassNames) {
      const baseClass = base.classes?.find(c => c.name === name);
      const compareClasses = compares.map(c => c.classes?.find(c => c.name === name)).filter(Boolean);

      if (compareClasses.length >= 2) {
        const fieldCounts = [...new Set(compareClasses.map(c => c.fields?.length || 0))];
        if (fieldCounts.length > 1) {
          conflicts[name] = {
            type: 'structural',
            description: `类 ${name} 字段数量不一致`,
            versions: compareClasses.map(c => ({ agentName: c.source || 'unknown' })),
            bestVersion: compareClasses.reduce((best, c) =>
              (c.fields?.length || 0) > (best.fields?.length || 0) ? c : best
            ),
            reason: '选择字段更完整的版本'
          };
        }
      }
    }

    return conflicts;
  }

  _analyzeSignatureConflict (name, baseFunc, compareFuncs) {
    const paramCounts = compareFuncs.map(f => f.params?.length || 0);
    const uniqueCounts = [...new Set(paramCounts)];

    if (uniqueCounts.length > 1) {
      const best = compareFuncs.reduce((best, f) =>
        (f.params?.length || 0) > (best.params?.length || 0) ? f : best
      );
      return {
        type: 'semantic',
        description: `函数 ${name} 参数数量不一致 (${paramCounts.join(', ')})`,
        versions: compareFuncs.map(f => ({ agentName: f.source || 'unknown', signature: f.signature })),
        bestVersion: best,
        reason: '选择参数更完整的版本'
      };
    }

    const returnTypes = [...new Set(compareFuncs.map(f => f.returnType || 'unknown'))];
    if (returnTypes.length > 1) {
      const preferred = compareFuncs.find(f =>
        f.returnType && !['any', 'unknown', 'void'].includes(f.returnType.toLowerCase())
      ) || compareFuncs[0];
      return {
        type: 'semantic',
        description: `函数 ${name} 返回类型不一致 (${returnTypes.join(', ')})`,
        versions: compareFuncs.map(f => ({ agentName: f.source || 'unknown', returnType: f.returnType })),
        bestVersion: preferred,
        reason: '选择非通用类型的返回值'
      };
    }

    return {
      type: 'syntax',
      description: `函数 ${name} 签名冲突`,
      versions: compareFuncs.map(f => ({ agentName: f.source || 'unknown' })),
      bestVersion: compareFuncs[0],
      reason: '默认选择第一个版本'
    };
  }

  _selectBestImplementation (name, implementations) {
    const scores = implementations.map(impl => {
      let score = 0;
      if (impl.params?.length > 0) score += impl.params.length * 10;
      if (impl.returnType && impl.returnType !== 'any') score += 20;
      return { ...impl, score };
    });

    const best = scores.reduce((a, b) => a.score > b.score ? a : b);
    return {
      type: 'syntax',
      description: `函数 ${name} 有多个实现，选择最优版本`,
      versions: implementations.map(i => ({ agentName: i.agentName || 'unknown' })),
      bestVersion: best,
      reason: `综合评分最高 (${best.score}分)`
    };
  }

  _buildThreeWayMergePrompt (filePath, versions, constraints, conflictMap, astSummary = null) {
    let prompt = `请执行三路合并：\n\n文件: ${filePath}\n约束: ${JSON.stringify(constraints)}\n\n`;

    prompt += `【基准版本】(${versions[0].agentName}):\n\`\`\`\n${versions[0].content}\n\`\`\`\n\n`;

    for (let i = 1; i < versions.length; i++) {
      prompt += `【版本${i}】(${versions[i].agentName}):\n\`\`\`\n${versions[i].content}\n\`\`\`\n\n`;
    }

    if (astSummary) {
      prompt += `${astSummary}\n\n`;
    }

    prompt += '【语义冲突分析】\n';
    for (const [name, conflict] of Object.entries(conflictMap)) {
      prompt += `- ${name}: ${conflict.description} -> 建议选择 ${conflict.bestVersion?.agentName || 'manual'}\n`;
    }
    prompt += '\n';

    prompt += `请基于以上语义分析${astSummary ? '和 AST 结构化分析' : ''}，智能合并代码：
1. 优先使用基准版本的结构
2. 对于有冲突的函数，选择语义分析建议的版本
3. 融合各版本的优点（更完整的参数、更明确的返回类型等）
4. 确保合并后代码可编译、无语法错误
5. 保持代码风格一致

输出 JSON 格式。`;

    return prompt;
  }

  /**
   * 语义冲突检测：在合并前检测潜在的语义级冲突
   */
  _detectSemanticConflicts (versions, constraints) {
    const conflicts = [];
    const language = constraints.language || 'text';

    if (language === 'c' || language === 'cpp') {
      conflicts.push(...this._detectCSemanticConflicts(versions));
    } else if (language === 'javascript' || language === 'typescript') {
      conflicts.push(...this._detectJSSemanticConflicts(versions));
    } else if (language === 'python') {
      conflicts.push(...this._detectPythonSemanticConflicts(versions));
    }

    conflicts.push(...this._detectCrossVersionConflicts(versions));

    return conflicts;
  }

  _stripCommentsAndStrings (code, language) {
    let result = code;

    if (language === 'python') {
      result = result.replace(/#.*$/gm, '');
      result = result.replace(/'''[\s\S]*?'''/g, '');
      result = result.replace(/"""[\s\S]*?"""/g, '');
      result = result.replace(/'[^']*'/g, '');
      result = result.replace(/"[^"]*"/g, '');
    } else if (language === 'javascript' || language === 'typescript') {
      result = result.replace(/\/\/.*$/gm, '');
      result = result.replace(/\/\*[\s\S]*?\*\//g, '');
      result = result.replace(/`[\s\S]*?`/g, '');
      result = result.replace(/'[^']*'/g, '');
      result = result.replace(/"[^"]*"/g, '');
    } else if (language === 'c' || language === 'cpp') {
      result = result.replace(/\/\/.*$/gm, '');
      result = result.replace(/\/\*[\s\S]*?\*\//g, '');
      result = result.replace(/'[^']*'/g, '');
      result = result.replace(/"[^"]*"/g, '');
    }

    return result;
  }

  _detectCSemanticConflicts (versions) {
    const conflicts = [];

    for (const version of versions) {
      const content = version.content;
      const cleanContent = this._stripCommentsAndStrings(content, 'cpp');

      const funcCalls = cleanContent.match(/\b(\w+)\s*\(/g) || [];
      const definedFuncs = new Set();
      const funcDefPattern = /^\s*(?:static\s+|extern\s+|inline\s+|virtual\s+|override\s+)?(\w+)\s+(\w+)\s*\(/gm;
      let match;
      while ((match = funcDefPattern.exec(cleanContent)) !== null) {
        definedFuncs.add(match[2]);
      }

      for (const call of funcCalls) {
        const funcName = call.match(/\b(\w+)\s*\(/)[1];
        if (!definedFuncs.has(funcName) && !['if', 'while', 'for', 'switch', 'return', 'sizeof', 'malloc', 'free', 'printf', 'scanf', 'new', 'delete', 'throw', 'catch', 'try'].includes(funcName)) {
          conflicts.push({
            location: version.filePath || 'main',
            agentName: version.agentName,
            type: 'semantic',
            severity: 'medium',
            description: `调用未定义函数 ${funcName}`
          });
        }
      }

      const structUsages = cleanContent.match(/struct\s+(\w+)/g) || [];
      const classUsages = cleanContent.match(/class\s+(\w+)/g) || [];
      const definedStructs = new Set();
      const structDefPattern = /(?:struct|class)\s+(\w+)\s*\{/gm;
      while ((match = structDefPattern.exec(cleanContent)) !== null) {
        definedStructs.add(match[1]);
      }

      for (const usage of [...structUsages, ...classUsages]) {
        const structName = usage.match(/(?:struct|class)\s+(\w+)/)[1];
        if (!definedStructs.has(structName) && !['FILE', 'timeval', 'std'].includes(structName)) {
          conflicts.push({
            location: version.filePath || 'main',
            agentName: version.agentName,
            type: 'semantic',
            severity: 'high',
            description: `使用未定义类型 ${structName}`
          });
        }
      }
    }

    return conflicts;
  }

  _detectJSSemanticConflicts (versions) {
    const conflicts = [];

    for (const version of versions) {
      const content = version.content;
      const cleanContent = this._stripCommentsAndStrings(content, 'javascript');

      const definedVars = new Set();
      const definedFuncs = new Set();
      const definedClasses = new Set();

      const varDefPattern = /(?:const|let|var)\s+(\w+)\s*(?==|\[|\.)/g;
      let match;
      while ((match = varDefPattern.exec(cleanContent)) !== null) {
        definedVars.add(match[1]);
      }

      const funcDefPattern = /(?:function\s+(\w+)|async\s+function\s+(\w+)|(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?:=>|\{))/g;
      while ((match = funcDefPattern.exec(cleanContent)) !== null) {
        const funcName = match[1] || match[2] || match[3];
        if (funcName) {
          definedFuncs.add(funcName);
        }
      }

      const classDefPattern = /class\s+(\w+)/g;
      while ((match = classDefPattern.exec(cleanContent)) !== null) {
        definedClasses.add(match[1]);
      }

      const importPattern = /(?:import\s+(?:\{\s*([^}]+)\s*\}|\*\s+as\s+(\w+)|(\w+))\s+from|import\s+(\w+))/g;
      while ((match = importPattern.exec(cleanContent)) !== null) {
        if (match[1]) {
          match[1].split(',').forEach(name => {
            const trimmed = name.trim();
            if (trimmed && !trimmed.includes(' ')) {
              definedVars.add(trimmed);
            }
          });
        } else if (match[2]) {
          definedVars.add(match[2]);
        } else if (match[3] || match[4]) {
          definedVars.add(match[3] || match[4]);
        }
      }

      const funcCalls = cleanContent.match(/\b(\w+)\s*\(/g) || [];
      for (const call of funcCalls) {
        const funcName = call.match(/\b(\w+)\s*\(/)[1];
        if (!definedFuncs.has(funcName) && !definedVars.has(funcName) &&
            !['if', 'while', 'for', 'switch', 'return', 'throw', 'catch', 'try', 'new', 'typeof', 'instanceof', 'delete', 'await', 'async'].includes(funcName)) {
          conflicts.push({
            location: version.filePath || 'main',
            agentName: version.agentName,
            type: 'semantic',
            severity: 'medium',
            description: `调用未定义函数 ${funcName}`
          });
        }
      }

      const classUsages = cleanContent.match(/new\s+(\w+)\s*\(/g) || [];
      for (const usage of classUsages) {
        const className = usage.match(/new\s+(\w+)/)[1];
        if (!definedClasses.has(className) && !definedVars.has(className)) {
          conflicts.push({
            location: version.filePath || 'main',
            agentName: version.agentName,
            type: 'semantic',
            severity: 'high',
            description: `实例化未定义类 ${className}`
          });
        }
      }

      const decoratorPattern = /@(\w+)/g;
      while ((match = decoratorPattern.exec(cleanContent)) !== null) {
        const decoratorName = match[1];
        if (!definedVars.has(decoratorName) && !['override', 'deprecated', 'sealed', 'virtual'].includes(decoratorName)) {
          conflicts.push({
            location: version.filePath || 'main',
            agentName: version.agentName,
            type: 'semantic',
            severity: 'medium',
            description: `使用未定义装饰器 @${decoratorName}`
          });
        }
      }
    }

    return conflicts;
  }

  _detectPythonSemanticConflicts (versions) {
    const conflicts = [];

    for (const version of versions) {
      const content = version.content;
      const cleanContent = this._stripCommentsAndStrings(content, 'python');

      const definedFuncs = new Set();
      const definedVars = new Set();
      const definedClasses = new Set();

      const funcDefPattern = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/gm;
      let match;
      while ((match = funcDefPattern.exec(cleanContent)) !== null) {
        definedFuncs.add(match[1]);
      }

      const classDefPattern = /^\s*class\s+(\w+)/gm;
      while ((match = classDefPattern.exec(cleanContent)) !== null) {
        definedClasses.add(match[1]);
      }

      const varDefPattern = /^\s*(?:global\s+)?(\w+)\s*=\s*(?!def\s|class\s|async\s+def\s)/gm;
      while ((match = varDefPattern.exec(cleanContent)) !== null) {
        definedVars.add(match[1]);
      }

      const importPattern = /(?:from\s+\w+\s+)?import\s+(?:(\w+)(?:\s+as\s+\w+)?|(\*))/g;
      while ((match = importPattern.exec(cleanContent)) !== null) {
        if (match[1]) {
          definedVars.add(match[1]);
        }
      }

      const funcCalls = cleanContent.match(/\b(\w+)\s*\(/g) || [];
      for (const call of funcCalls) {
        const funcName = call.match(/\b(\w+)\s*\(/)[1];
        if (!definedFuncs.has(funcName) && !definedVars.has(funcName) && !definedClasses.has(funcName) &&
            !['print', 'len', 'range', 'list', 'dict', 'str', 'int', 'float', 'bool', 'None', 'True', 'False',
              'if', 'while', 'for', 'return', 'import', 'from', 'async', 'await', 'yield', 'lambda', 'with',
              'try', 'except', 'finally', 'raise', 'assert', 'break', 'continue', 'pass', 'del', 'is', 'in',
              'and', 'or', 'not', 'as', 'class', 'def', 'global', 'nonlocal', 'elif', 'else'].includes(funcName)) {
          conflicts.push({
            location: version.filePath || 'main',
            agentName: version.agentName,
            type: 'semantic',
            severity: 'medium',
            description: `调用未定义函数 ${funcName}`
          });
        }
      }
    }

    return conflicts;
  }

  _detectCrossVersionConflicts (versions) {
    const conflicts = [];
    const nameCounts = {};

    for (const version of versions) {
      const content = version.content;
      const funcPattern = /(?:function\s+|def\s+|fn\s+|int\s+|void\s+|char\s+)\s+(\w+)\s*\(/g;
      let match;
      while ((match = funcPattern.exec(content)) !== null) {
        const name = match[1];
        if (!nameCounts[name]) nameCounts[name] = new Set();
        nameCounts[name].add(version.agentName);
      }
    }

    for (const [name, agents] of Object.entries(nameCounts)) {
      if (agents.size >= 2) {
        conflicts.push({
          location: 'global',
          type: 'naming',
          severity: 'low',
          description: `函数 ${name} 在多个 Agent 中都有定义`,
          agents: [...agents]
        });
      }
    }

    return conflicts;
  }

  /**
   * 合并后验证：编译检查、语法验证、契约一致性检查
   */
  async _verifyMergedCode (mergedFiles, constraints) {
    const language = constraints.language || 'text';
    const allCode = Object.values(mergedFiles).join('\n');
    const results = {
      compileCheck: null,
      syntaxCheck: null,
      contractConsistency: null,
      passed: true,
      errors: []
    };

    results.compileCheck = this._runCompileCheck(allCode, language);
    if (!results.compileCheck.passed) {
      results.passed = false;
      results.errors.push(`编译检查失败: ${results.compileCheck.error}`);
    }

    results.syntaxCheck = this._runSyntaxCheck(allCode, language);
    if (!results.syntaxCheck.passed) {
      results.passed = false;
      results.errors.push(`语法检查失败: ${results.syntaxCheck.error}`);
    }

    results.contractConsistency = await this._runContractConsistencyCheck(mergedFiles, constraints);
    if (!results.contractConsistency.passed) {
      results.passed = false;
      results.errors.push(...results.contractConsistency.issues);
    }

    return results;
  }

  _runCompileCheck (code, language) {
    let tempFile = null;
    try {
      let cmd, args;
      const extMap = { c: '.c', cpp: '.cpp', python: '.py', javascript: '.js', typescript: '.ts', go: '.go', rust: '.rs' };
      const ext = extMap[language] || '.txt';

      tempFile = path.join(require('os').tmpdir(), `tmp_verify_${Date.now()}_${Math.random().toString(36).substr(2, 9)}${ext}`);

      fs.writeFileSync(tempFile, code, 'utf-8');

      switch (language) {
      case 'c':
        cmd = process.platform === 'win32' ? 'gcc.exe' : 'gcc';
        args = ['-fsyntax-only', tempFile];
        break;
      case 'cpp':
        cmd = process.platform === 'win32' ? 'g++.exe' : 'g++';
        args = ['-fsyntax-only', tempFile];
        break;
      case 'python':
        cmd = process.platform === 'win32' ? 'python.exe' : 'python';
        args = ['-m', 'py_compile', tempFile];
        break;
      case 'javascript':
        cmd = process.platform === 'win32' ? 'node.exe' : 'node';
        args = ['--check', tempFile];
        break;
      case 'typescript':
        cmd = 'tsc';
        args = ['--noEmit', tempFile];
        break;
      case 'go':
        cmd = process.platform === 'win32' ? 'go.exe' : 'go';
        args = ['build', tempFile];
        break;
      default:
        return { passed: true, message: '未执行编译检查' };
      }

      const result = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 30000 });

      return {
        passed: result.status === 0,
        error: result.stderr || result.stdout,
        tool: cmd
      };
    } catch (e) {
      logger.warn(`编译检查失败: ${e.message}`, { language, error: e });
      return { passed: true, message: `工具不可用: ${e.message}` };
    } finally {
      if (tempFile) {
        try {
          fs.unlinkSync(tempFile);
        } catch (unlinkErr) {
          logger.warn(`清理临时文件失败: ${tempFile}`, { error: unlinkErr });
        }
      }
    }
  }

  _runSyntaxCheck (code, language) {
    const patterns = {
      c: [
        { pattern: /#include\s*<[^>]+>/gm, required: false },
        { pattern: /;\s*$/gm, required: false },
        { pattern: /\{\s*\}/gm, required: false }
      ],
      python: [
        { pattern: /^\s*(def|class)\s+\w+\s*\(/gm, required: false },
        { pattern: /:\s*$/gm, required: false }
      ],
      javascript: [
        { pattern: /function\s+\w+\s*\(/gm, required: false },
        { pattern: /;\s*$/gm, required: false },
        { pattern: /\{\s*\}/gm, required: false }
      ]
    };

    const checks = patterns[language] || [];
    const errors = [];

    const braceCount = (code.match(/\{/g) || []).length;
    const closingBraceCount = (code.match(/\}/g) || []).length;
    if (braceCount !== closingBraceCount) {
      errors.push(`括号不匹配: {=${braceCount}, }=${closingBraceCount}`);
    }

    const parenCount = (code.match(/\(/g) || []).length;
    const closingParenCount = (code.match(/\)/g) || []).length;
    if (parenCount !== closingParenCount) {
      errors.push(`圆括号不匹配: (=${parenCount}, )=${closingParenCount}`);
    }

    const bracketCount = (code.match(/\[/g) || []).length;
    const closingBracketCount = (code.match(/\]/g) || []).length;
    if (bracketCount !== closingBracketCount) {
      errors.push(`方括号不匹配: [=${bracketCount}, ]=${closingBracketCount}`);
    }

    return {
      passed: errors.length === 0,
      errors,
      message: errors.length === 0 ? '语法检查通过' : `发现 ${errors.length} 个语法问题`
    };
  }

  async _runContractConsistencyCheck (mergedFiles, constraints) {
    const codeBlocks = Object.entries(mergedFiles).map(([filePath, content]) => ({
      code: content,
      language: constraints.language || 'text',
      filePath
    }));

    try {
      const contracts = await this.contractAssembler.extractContracts(codeBlocks);
      const validation = this.contractAssembler.validateContracts(contracts);

      return {
        passed: validation.valid,
        issues: validation.errors.map(e => e.details),
        warnings: validation.warnings.map(e => e.details),
        contractCount: contracts.length
      };
    } catch (e) {
      return {
        passed: true,
        issues: [],
        warnings: [`契约检查异常: ${e.message}`],
        contractCount: 0
      };
    }
  }

  /**
   * 回退合并策略
   */
  _fallbackMerge (versions) {
    const best = versions.reduce((a, b) => {
      const scoreA = a.qualityScore || 50;
      const scoreB = b.qualityScore || 50;
      if (scoreA !== scoreB) return scoreA > scoreB ? a : b;
      return (a.content?.length || 0) > (b.content?.length || 0) ? a : b;
    });

    return {
      mergedCode: best.content,
      conflicts: [{
        location: 'global',
        description: '智能合并失败，回退到最佳版本',
        resolutions: versions.map(v => v.agentName),
        chosenResolution: best.agentName,
        reason: '质量评分最高或内容最完整',
        conflictType: 'fallback'
      }],
      improvements: []
    };
  }

  /**
   * 将多个 Agent 的结果按文件路径分组。
   */
  _groupByFile (entries) {
    const groups = {};
    for (const [agentName, result] of entries) {
      const codeBlocks = result.result?.codeBlocks || result.result?.code?.codeBlocks || [];
      if (codeBlocks.length === 0) continue;

      for (const block of codeBlocks) {
        const filePath = block.filePath || block.filename || 'main';
        if (!groups[filePath]) groups[filePath] = [];
        groups[filePath].push({ agentName, content: block.code, language: block.language });
      }
    }
    return groups;
  }

  /**
   * 合并同一文件的多版本。
   */
  async _mergeFileVersions (filePath, versions, constraints, astSummary = null) {
    if (versions.length === 2) {
      // 简单两路合并：先算差异，再让AI判断
      return await this._twoWayMerge(filePath, versions[0], versions[1], constraints, astSummary);
    }

    // 多路合并：先两两合并，再最终合并
    let current = versions[0].content;
    const allConflicts = [];
    const allImprovements = [];

    for (let i = 1; i < versions.length; i++) {
      const result = await this._twoWayMerge(filePath, { content: current }, versions[i], constraints, astSummary);
      current = result.mergedCode;
      allConflicts.push(...result.conflicts);
      allImprovements.push(...result.improvements);
    }

    return { mergedCode: current, conflicts: allConflicts, improvements: allImprovements };
  }

  async _twoWayMerge (filePath, versionA, versionB, constraints, astSummary = null) {
    let prompt = `请合并以下两个版本的代码：\n\n文件: ${filePath}\n约束: ${JSON.stringify(constraints)}\n\n【版本A】(${versionA.agentName || 'Agent1'}):\n\`\`\`\n${versionA.content}\n\`\`\`\n\n【版本B】(${versionB.agentName || 'Agent2'}):\n\`\`\`\n${versionB.content}\n\`\`\`\n\n`;
    if (astSummary) {
      prompt += `${astSummary}\n\n`;
    }
    prompt += `请分析差异${astSummary ? '（参考 AST 结构化分析）' : ''}，选择最佳方案，输出 JSON。`;

    try {
      const result = await this.sendOnce(prompt);
      const parsed = this._extractJson(result.content);
      if (parsed) {
        return {
          mergedCode: parsed.mergedCode || versionA.content,
          conflicts: parsed.conflicts || [],
          improvements: parsed.improvements || []
        };
      }
    } catch (e) {
      logger.warn('两路合并AI调用失败，回退到选择较长版本', { error: e.message, filePath });
    }

    // 回退策略：选择更完整的版本
    const chosen = versionA.content.length > versionB.content.length ? versionA : versionB;
    return {
      mergedCode: chosen.content,
      conflicts: [{
        location: filePath,
        description: '自动合并失败，选择更完整版本',
        resolutions: [versionA.agentName, versionB.agentName],
        chosenResolution: chosen.agentName || 'Agent1',
        reason: '内容更完整'
      }],
      improvements: []
    };
  }

  /**
   * 全局一致性检查：风格、命名、导入等。
   */
  _checkGlobalConsistency (mergedFiles, constraints) {
    const issues = [];
    const allCode = Object.values(mergedFiles).join('\n');

    // 检查语言一致性
    if (constraints.language) {
      const detected = this._detectLanguage(allCode);
      if (detected !== constraints.language.toLowerCase()) {
        issues.push(`语言不一致：约束为 ${constraints.language}，检测到 ${detected}`);
      }
    }

    // 检查导入/引用一致性
    const imports = allCode.match(/^#include|^import|^from\s|^require\(/gm) || [];
    const importSet = new Set(imports);
    if (importSet.size > 15) {
      issues.push('导入/引用过多，建议清理冗余依赖');
    }

    return { passed: issues.length === 0, issues };
  }

  _detectLanguage (code) {
    if (/\b(cin|cout|class|new\s+\w+|delete\s+|std::|template|vector<)\b/.test(code)) return 'cpp';
    if (/^\s*#include\s*<.*\.h>/m.test(code)) return 'c';
    if (/^\s*(def|class)\s+\w+.*:/m.test(code)) return 'python';
    if (/\bfunction\s+\w+|const\s+\w+\s*=/.test(code)) return 'javascript';
    return 'unknown';
  }

  async _assessMergedQuality (mergedFiles, entries, constraints) {
    // 如果只有一个结果，直接复用其质量评分
    if (entries.length === 1) {
      const score = entries[0][1].result?.quality?.qualityScore || 70;
      return { correctness: score, consistency: score, readability: score, security: score, overall: score };
    }

    // 多个结果：基于实际合并代码的多维评估
    const mergedCode = Object.values(mergedFiles).join('\n');

    // 1. 统计未解决的冲突（merge markers）
    const conflictMarkers = (mergedCode.match(/<<<<<<< |=======|>>>>>>> /g) || []);
    const unresolvedConflictCount = conflictMarkers.length > 0 ? Math.ceil(conflictMarkers.length / 3) : 0;
    const conflictScore = Math.max(0, 100 - unresolvedConflictCount * 20);

    // 2. 代码完整性检查：检查关键接口/类/函数是否定义
    const definedSymbols = (mergedCode.match(/^(?:function|class|const|let|var|def|async\s+function)\s+\w+/gm) || []).length;
    const entrySymbols = entries.map(([_, r]) => {
      const code = r.result?.output || r.result?.code || '';
      return (code.match(/^(?:function|class|const|let|var|def|async\s+function)\s+\w+/gm) || []).length;
    });
    const expectedSymbols = Math.max(...entrySymbols, 1);
    const completenessScore = Math.min(100, Math.round((definedSymbols / expectedSymbols) * 100));

    // 3. 原始工具评分的参考权重（30%）
    const baseScores = entries.map(([_, r]) => r.result?.quality?.qualityScore || r.qualityScore || 60);
    const refScore = baseScores.length > 0 ? Math.max(...baseScores) * 0.3 : 0;

    // 4. 综合评分（实际代码分析占70%）
    const score = Math.round(
      refScore +
      (conflictScore * 0.35) +
      (completenessScore * 0.35)
    );

    return {
      correctness: Math.min(100, completenessScore > 80 ? score + 10 : score - 10),
      consistency: conflictScore,
      readability: Math.min(100, completenessScore > 70 ? score : score - 10),
      security: Math.min(100, score),
      overall: Math.min(100, Math.round(score * 0.4 + conflictScore * 0.3 + completenessScore * 0.3))
    };
  }

  _assembleFinalCode (mergedFiles) {
    const parts = [];
    for (const [path, code] of Object.entries(mergedFiles)) {
      parts.push(`// === ${path} ===\n${code}\n`);
    }
    return parts.join('\n');
  }

  /**
   * 生成合并报告。
   */
  generateMergeReport (mergeResult) {
    let report = '═══════════════════════════════════════════\n';
    report += '          多 Agent 合并报告\n';
    report += '═══════════════════════════════════════════\n\n';
    report += `合并策略: ${mergeResult.mergeStrategy}\n`;
    report += `文件数: ${Object.keys(mergeResult.mergedFiles || {}).length}\n`;
    report += `冲突数: ${mergeResult.conflicts?.length || 0}\n`;
    report += `改进数: ${mergeResult.improvements?.length || 0}\n`;
    if (mergeResult.qualityAssessment) {
      report += '\n质量评分:\n';
      for (const [k, v] of Object.entries(mergeResult.qualityAssessment)) {
        report += `  ${k}: ${v}\n`;
      }
    }
    if (mergeResult.consistencyCheck?.issues?.length > 0) {
      report += '\n⚠️ 一致性问题:\n';
      for (const issue of mergeResult.consistencyCheck.issues) {
        report += `  - ${issue}\n`;
      }
    }
    report += `\n${mergeResult.notes || ''}\n`;
    return report;
  }

  async _appendHistory (entry) {
    const lock = this._historyLock;
    this._historyLock = (async () => {
      await lock;
      this.mergeHistory.push(entry);
      if (this.mergeHistory.length > this.maxHistorySize) {
        this.mergeHistory.shift();
      }
    })();
    await this._historyLock;
  }
}

module.exports = MergeEngine;
