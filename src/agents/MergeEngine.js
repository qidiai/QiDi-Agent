const BaseAgent = require('./BaseAgent');

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
      "reason": "选择理由"
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
  "mergeStrategy": "best|combine|sequential|manual",
  "notes": "合并过程中的注意事项"
}

注意：只输出 JSON，不要其他文字。`;

class MergeEngine extends BaseAgent {
  constructor(provider, options = {}) {
    super(provider, {
      name: 'MergeEngine',
      role: '代码合并与审查专家',
      systemPrompt: MERGE_PROMPT,
      temperature: 0.3,
      ...options
    });
    this.conflictResolution = options.conflictResolution || 'auto'; // auto, conservative, aggressive
  }

  /**
   * 合并多个 Agent 的代码产出。
   * @param {Object} resultsMap - key: agentName, value: { codeBlocks, content, qualityScore }
   * @param {Object} constraints - 全局约束
   * @returns {Object} 合并结果
   */
  async merge(resultsMap, constraints = {}) {
    const entries = Object.entries(resultsMap).filter(([_, v]) => v && v.success);
    if (entries.length === 0) {
      return { error: '没有可合并的结果', mergedCode: '', conflicts: [] };
    }
    if (entries.length === 1) {
      return this._singleResultMerge(entries[0]);
    }

    // 1. 按文件分组
    const fileGroups = this._groupByFile(entries);

    // 2. 逐文件合并
    const mergedFiles = {};
    const allConflicts = [];
    const allImprovements = [];

    for (const [filePath, versions] of Object.entries(fileGroups)) {
      if (versions.length === 1) {
        mergedFiles[filePath] = versions[0].content;
        continue;
      }

      const mergeResult = await this._mergeFileVersions(filePath, versions, constraints);
      mergedFiles[filePath] = mergeResult.mergedCode;
      allConflicts.push(...mergeResult.conflicts);
      allImprovements.push(...mergeResult.improvements);
    }

    // 3. 全局一致性检查
    const consistencyCheck = this._checkGlobalConsistency(mergedFiles, constraints);

    // 4. 构建最终结果
    const qualityAssessment = await this._assessMergedQuality(mergedFiles, entries, constraints);

    return {
      mergedFiles,
      mergedCode: this._assembleFinalCode(mergedFiles),
      conflicts: allConflicts,
      improvements: allImprovements,
      qualityAssessment,
      consistencyCheck,
      mergeStrategy: 'combine',
      notes: `合并了 ${entries.length} 个 Agent 的产出，处理了 ${allConflicts.length} 个冲突`
    };
  }

  _singleResultMerge([agentName, result]) {
    const code = result.result?.codeBlocks?.[0]?.code || result.content || '';
    return {
      mergedFiles: { 'main': code },
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
   * 将多个 Agent 的结果按文件路径分组。
   */
  _groupByFile(entries) {
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
  async _mergeFileVersions(filePath, versions, constraints) {
    if (versions.length === 2) {
      // 简单两路合并：先算差异，再让AI判断
      return await this._twoWayMerge(filePath, versions[0], versions[1], constraints);
    }

    // 多路合并：先两两合并，再最终合并
    let current = versions[0].content;
    const allConflicts = [];
    const allImprovements = [];

    for (let i = 1; i < versions.length; i++) {
      const result = await this._twoWayMerge(filePath, { content: current }, versions[i], constraints);
      current = result.mergedCode;
      allConflicts.push(...result.conflicts);
      allImprovements.push(...result.improvements);
    }

    return { mergedCode: current, conflicts: allConflicts, improvements: allImprovements };
  }

  async _twoWayMerge(filePath, versionA, versionB, constraints) {
    const prompt = `请合并以下两个版本的代码：\n\n文件: ${filePath}\n约束: ${JSON.stringify(constraints)}\n\n【版本A】(${versionA.agentName || 'Agent1'}):\n\`\`\`\n${versionA.content}\n\`\`\`\n\n【版本B】(${versionB.agentName || 'Agent2'}):\n\`\`\`\n${versionB.content}\n\`\`\`\n\n请分析差异，选择最佳方案，输出 JSON。`;

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
      // 合并失败，回退到选择较长版本
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
  _checkGlobalConsistency(mergedFiles, constraints) {
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

  _detectLanguage(code) {
    if (/\b(cin|cout|class|new\s+\w+|delete\s+|std::|template|vector<)\b/.test(code)) return 'cpp';
    if (/^\s*#include\s*<.*\.h>/m.test(code)) return 'c';
    if (/^\s*(def|class)\s+\w+.*:/m.test(code)) return 'python';
    if (/\bfunction\s+\w+|const\s+\w+\s*=/.test(code)) return 'javascript';
    return 'unknown';
  }

  async _assessMergedQuality(mergedFiles, entries, constraints) {
    // 如果只有一个结果，直接复用其质量评分
    if (entries.length === 1) {
      const score = entries[0][1].result?.quality?.qualityScore || 70;
      return { correctness: score, consistency: score, readability: score, security: score, overall: score };
    }

    // 多个结果：综合评估
    const scores = entries.map(([_, r]) => r.result?.quality?.qualityScore || 60);
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    const maxScore = Math.max(...scores);

    return {
      correctness: maxScore,
      consistency: avgScore,
      readability: avgScore,
      security: avgScore,
      overall: Math.round((maxScore + avgScore) / 2)
    };
  }

  _assembleFinalCode(mergedFiles) {
    const parts = [];
    for (const [path, code] of Object.entries(mergedFiles)) {
      parts.push(`// === ${path} ===\n${code}\n`);
    }
    return parts.join('\n');
  }

  /**
   * 生成合并报告。
   */
  generateMergeReport(mergeResult) {
    let report = '═══════════════════════════════════════════\n';
    report += '          多 Agent 合并报告\n';
    report += '═══════════════════════════════════════════\n\n';
    report += `合并策略: ${mergeResult.mergeStrategy}\n`;
    report += `文件数: ${Object.keys(mergeResult.mergedFiles || {}).length}\n`;
    report += `冲突数: ${mergeResult.conflicts?.length || 0}\n`;
    report += `改进数: ${mergeResult.improvements?.length || 0}\n`;
    if (mergeResult.qualityAssessment) {
      report += `\n质量评分:\n`;
      for (const [k, v] of Object.entries(mergeResult.qualityAssessment)) {
        report += `  ${k}: ${v}\n`;
      }
    }
    if (mergeResult.consistencyCheck?.issues?.length > 0) {
      report += `\n⚠️ 一致性问题:\n`;
      for (const issue of mergeResult.consistencyCheck.issues) {
        report += `  - ${issue}\n`;
      }
    }
    report += `\n${mergeResult.notes || ''}\n`;
    return report;
  }
}

module.exports = MergeEngine;
