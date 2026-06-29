/** @module TaskSplitterAgent */
const BaseAgent = require('./BaseAgent');
const ContractAssembler = require('../core/ContractAssembler');
const fs = require('fs');
const path = require('path');

const TASK_SPLITTER_PROMPT = `你是一位资深的AI系统架构师与项目总工程师，专门负责将复杂的编程任务拆解为可执行、可验证的子任务。

你的职责：
1. 深度分析任务需求，识别隐含约束和技术要求
2. 提取全局约束（编程语言、技术栈、平台、框架、代码风格等）
3. 将任务拆分为逻辑清晰、粒度适中的子任务（3-10个）
4. 每个子任务必须有明确的目标、可验收标准和完成指标
5. 标注依赖关系，确保无循环依赖、无遗漏前置条件
6. 为每个子任务分配最合适的角色（architect|code_writer|code_reviewer|tester|quality_checker）
7. 确保所有子任务严格遵循全局约束，且组合后能完整覆盖原始需求
8. 估算每个子任务的复杂度（low|medium|high）和预估工作量

输出格式（严格 JSON，必须完整输出）：
{
  "taskOverview": "任务概述，包含核心目标和关键约束",
  "constraints": {
    "language": "编程语言",
    "techStack": "技术栈",
    "platform": "目标平台",
    "framework": "框架",
    "style": "代码风格",
    "fileExtension": "文件扩展名"
  },
  "subtasks": [
    {
      "id": "T1",
      "title": "子任务标题",
      "description": "详细描述，包含具体实现要求",
      "role": "architect|code_writer|code_reviewer|tester|quality_checker",
      "dependsOn": ["依赖ID"],
      "acceptanceCriteria": "可验证的验收标准",
      "estimatedComplexity": "low|medium|high",
      "estimatedHours": 0.5,
      "requiredContracts": ["需要的函数/类/接口"],
      "producesContracts": ["产出的函数/类/接口"]
    }
  ],
  "dependencyGraph": {
    "T1": ["T2"],
    "T2": ["T3"]
  },
  "coverageCheck": {
    "allRequirementsCovered": true,
    "potentialGaps": ["可能遗漏点"],
    "riskItems": ["风险项"]
  },
  "overallPlan": "整体执行计划，包含关键路径和并行策略",
  "contractAnalysis": {
    "existingContracts": [],
    "newContractsNeeded": [],
    "contractConflicts": []
  }
}

自检要求：
- 检查是否所有原始需求都被覆盖
- 检查依赖关系是否无循环
- 检查是否存在无法执行的孤立子任务
- 检查复杂度估算是否合理
- 检查契约依赖是否完整

注意：只输出 JSON，不要其他文字。`;

class TaskSplitterAgent extends BaseAgent {
  constructor (provider, options = {}) {
    super(provider, {
      name: 'TaskSplitter',
      role: '项目总工程师',
      systemPrompt: TASK_SPLITTER_PROMPT,
      temperature: 0.3,
      ...options
    });
    this.enableSelfCheck = options.enableSelfCheck !== false;
    this.maxSubtasks = options.maxSubtasks || 10;
    this.maxResplits = options.maxResplits || 2;
    this.resplitCount = 0;
    this.enableContractAnalysis = options.enableContractAnalysis !== false;
    this.contractAssembler = options.contractAssembler || new ContractAssembler();
    this.executionHistory = [];
    this.feedbackLoopEnabled = options.feedbackLoopEnabled !== false;
    this.adaptiveThreshold = options.adaptiveThreshold || 3;
    this.strategyAdjustmentFactor = options.strategyAdjustmentFactor || 0.2;
    this.splitPatterns = {
      granularity: 'normal',
      dependencyWeight: 1.0,
      complexityBias: 'balanced'
    };
    this.taskStats = {
      total: 0,
      successful: 0,
      failed: 0,
      averageQuality: 0,
      avgSplitTime: 0
    };
  }

  async splitTask (taskDescription, context = {}) {
    let projectAnalysis = null;

    if (this.enableContractAnalysis && context.existingFiles) {
      projectAnalysis = await this._analyzeProjectContext(context);
    }

    const complexity = this._analyzeComplexity(taskDescription, projectAnalysis);

    if (this.feedbackLoopEnabled && this.executionHistory.length >= this.adaptiveThreshold) {
      this._adjustStrategyBasedOnFeedback();
    }

    let prompt = `请拆分以下编程任务：\n\n${taskDescription}\n\n`;
    prompt += '【任务复杂度分析参考】\n';
    prompt += `- 文本长度: ${complexity.length} 字\n`;
    prompt += `- 代码块数量: ${complexity.codeBlocks} 个\n`;
    prompt += `- 语言提及数: ${complexity.languages.length} 个（${complexity.languages.join(', ')}）\n`;
    prompt += `- 需求歧义度: ${complexity.ambiguity}（高/中/低）\n`;
    prompt += `- 预估复杂度: ${complexity.level}\n`;
    prompt += `- AST节点数估算: ${complexity.astNodeCount}\n`;
    prompt += `- 依赖深度: ${complexity.dependencyDepth}\n`;
    prompt += `- 已有契约数: ${complexity.existingContractCount}\n\n`;
    prompt += '【当前拆分策略】\n';
    prompt += `- 粒度模式: ${this.splitPatterns.granularity}\n`;
    prompt += `- 依赖权重: ${this.splitPatterns.dependencyWeight}\n`;
    prompt += `- 复杂度偏向: ${this.splitPatterns.complexityBias}\n\n`;
    prompt += '请基于以上复杂度和策略，确定合理的子任务数量和粒度。';

    if (projectAnalysis) {
      prompt += '\n\n【项目契约分析】\n';
      prompt += `- 已有函数: ${projectAnalysis.functions.length} 个\n`;
      prompt += `- 已有类/结构体: ${projectAnalysis.structs.length + projectAnalysis.classes.length} 个\n`;
      prompt += `- 已有接口: ${projectAnalysis.interfaces.length} 个\n`;
      if (projectAnalysis.functions.length > 0) {
        prompt += `- 关键函数: ${projectAnalysis.functions.slice(0, 5).map(f => f.name).join(', ')}${projectAnalysis.functions.length > 5 ? '...' : ''}\n`;
      }
      if (projectAnalysis.dependencies.length > 0) {
        prompt += `- 项目依赖: ${projectAnalysis.dependencies.slice(0, 5).join(', ')}${projectAnalysis.dependencies.length > 5 ? '...' : ''}\n`;
      }
      if (projectAnalysis.missingContracts.length > 0) {
        prompt += `- 需要新增的契约: ${projectAnalysis.missingContracts.join(', ')}\n`;
      }
    }

    if (context.projectInfo) {
      prompt += `\n\n【项目背景】\n${context.projectInfo}`;
    }
    if (context.existingFiles && !projectAnalysis) {
      prompt += `\n\n【现有文件结构】\n${context.existingFiles}`;
    }
    if (context.historicalData) {
      prompt += `\n\n【历史数据参考】\n${context.historicalData}`;
    }

    const result = await this.sendWithRetry(prompt);
    let parsed = this._extractJson(result.content);

    if (!parsed || !parsed.subtasks) {
      return this._fallbackSplit(taskDescription, complexity);
    }

    parsed = this._normalizeResult(parsed, taskDescription);

    if (projectAnalysis) {
      parsed.contractAnalysis = {
        existingContracts: projectAnalysis.functions.map(f => f.name),
        newContractsNeeded: projectAnalysis.missingContracts,
        contractConflicts: []
      };
    }

    if (this.enableSelfCheck) {
      parsed = await this._selfCheck(parsed, taskDescription, context);
    }

    const dependencyCheck = this._validateDependencies(parsed.subtasks);
    if (!dependencyCheck.valid) {
      parsed.subtasks = this._fixCircularDependencies(parsed.subtasks, dependencyCheck.cycles);
    }

    const coverage = this._validateCoverage(parsed.subtasks, taskDescription);
    parsed.coverageCheck = coverage;

    if (coverage.needsResplit && this.enableSelfCheck && this.resplitCount < this.maxResplits) {
      this.resplitCount++;
      return await this._resplitWithFeedback(taskDescription, context, parsed, coverage);
    }

    if (coverage.needsResplit && this.resplitCount >= this.maxResplits) {
      parsed.coverageCheck.riskItems.push('覆盖度验证多次失败，使用当前拆解但建议人工审查');
    }

    this.resplitCount = 0;
    return parsed;
  }

  async _analyzeProjectContext (context) {
    try {
      const codeBlocks = [];

      if (context.existingFiles) {
        const files = context.existingFiles.split('\n').filter(f => f.trim());
        for (const filePath of files) {
          try {
            if (fs.existsSync(filePath)) {
              const content = fs.readFileSync(filePath, 'utf-8');
              const ext = path.extname(filePath).slice(1);
              codeBlocks.push({
                code: content,
                language: ext || 'text',
                filePath
              });
            }
          } catch (e) {}
        }
      }

      if (codeBlocks.length === 0) return null;

      const contracts = await this.contractAssembler.extractContracts(codeBlocks);

      const allFunctions = [];
      const allStructs = [];
      const allClasses = [];
      const allInterfaces = [];
      const dependencies = new Set();

      for (const contract of contracts) {
        allFunctions.push(...(contract.functions || []));
        allStructs.push(...(contract.structs || []));
        allClasses.push(...(contract.classes || []));
        allInterfaces.push(...(contract.interfaces || []));
        if (contract.includes) contract.includes.forEach(d => dependencies.add(d));
        if (contract.imports) contract.imports.forEach(d => dependencies.add(d));
      }

      return {
        functions: allFunctions,
        structs: allStructs,
        classes: allClasses,
        interfaces: allInterfaces,
        dependencies: [...dependencies],
        missingContracts: []
      };
    } catch (e) {
      return null;
    }
  }

  _analyzeComplexity (taskDescription, projectAnalysis = null) {
    const length = taskDescription.length;
    const codeBlocks = (taskDescription.match(/```/g) || []).length / 2;
    const languages = this._extractLanguages(taskDescription);
    const keywords = ['实现', '开发', '构建', '系统', '架构', '集成', '模块', '接口', '数据库', 'API', '微服务', '算法', '优化', '重构', '安全', '性能', '多线程', '服务器', '路由', '中间件', '日志', '缓存', '并发', '分布式', '高可用'];
    const keywordCount = keywords.filter(k => taskDescription.includes(k)).length;
    const ambiguity = keywordCount > 8 ? 'high' : keywordCount > 4 ? 'medium' : 'low';

    let level = 'low';
    if (length > 500 || keywordCount >= 5) {
      level = 'high';
    } else if (length > 200 || keywordCount >= 3) {
      level = 'medium';
    }

    const astNodeCount = this._estimateASTNodes(taskDescription);
    const dependencyDepth = projectAnalysis ? Math.min(5, Math.ceil(projectAnalysis.functions.length / 5)) : 1;
    const existingContractCount = projectAnalysis
      ? projectAnalysis.functions.length + projectAnalysis.structs.length + projectAnalysis.classes.length
      : 0;

    return {
      length,
      codeBlocks,
      languages,
      ambiguity,
      keywordCount,
      level,
      astNodeCount,
      dependencyDepth,
      existingContractCount
    };
  }

  _estimateASTNodes (text) {
    const functionPattern = /(function|def|fn|int|void|char|float|double|static|extern)\s+\w+\s*\(/g;
    const classPattern = /class\s+\w+/g;
    const structPattern = /struct\s+\w+/g;
    const interfacePattern = /interface\s+\w+/g;

    const funcCount = (text.match(functionPattern) || []).length;
    const classCount = (text.match(classPattern) || []).length;
    const structCount = (text.match(structPattern) || []).length;
    const interfaceCount = (text.match(interfacePattern) || []).length;

    return funcCount * 5 + classCount * 10 + structCount * 8 + interfaceCount * 6;
  }

  _extractLanguages (text) {
    const langPatterns = [
      { pattern: /javascript|js/i, name: 'JavaScript' },
      { pattern: /typescript|ts/i, name: 'TypeScript' },
      { pattern: /python|py/i, name: 'Python' },
      { pattern: /java/i, name: 'Java' },
      { pattern: /go/i, name: 'Go' },
      { pattern: /c\+\+|cpp/i, name: 'C++' },
      { pattern: /c语言/i, name: 'C' },
      { pattern: /rust|rs/i, name: 'Rust' },
      { pattern: /html/i, name: 'HTML' },
      { pattern: /css/i, name: 'CSS' },
      { pattern: /react/i, name: 'React' },
      { pattern: /vue/i, name: 'Vue' },
      { pattern: /node\.js|node/i, name: 'Node.js' }
    ];
    const found = [];
    for (const { pattern, name } of langPatterns) {
      if (pattern.test(text)) found.push(name);
    }
    return [...new Set(found)];
  }

  _fallbackSplit (taskDescription, complexity) {
    const language = complexity.languages[0] || 'python';
    const subtasks = [];

    if (complexity.level === 'low') {
      subtasks.push({
        id: 'T1',
        title: '实现任务',
        description: taskDescription,
        role: 'code_writer',
        dependsOn: [],
        acceptanceCriteria: '代码实现正确，可编译运行',
        estimatedComplexity: 'low',
        estimatedHours: 0.5,
        requiredContracts: [],
        producesContracts: []
      });
    } else if (complexity.level === 'medium') {
      subtasks.push(
        { id: 'T1', title: '设计数据结构与接口', description: '设计核心数据结构和API接口', role: 'architect', dependsOn: [], acceptanceCriteria: '接口定义清晰，数据结构设计合理', estimatedComplexity: 'medium', estimatedHours: 1, requiredContracts: [], producesContracts: ['核心数据结构', 'API接口'] },
        { id: 'T2', title: '核心逻辑实现', description: taskDescription, role: 'code_writer', dependsOn: ['T1'], acceptanceCriteria: '代码实现正确，通过基本测试', estimatedComplexity: 'medium', estimatedHours: 2, requiredContracts: ['核心数据结构', 'API接口'], producesContracts: ['核心函数'] },
        { id: 'T3', title: '代码审查与测试', description: '审查代码质量，设计测试用例', role: 'code_reviewer', dependsOn: ['T2'], acceptanceCriteria: '无严重问题，测试用例覆盖核心功能', estimatedComplexity: 'low', estimatedHours: 1, requiredContracts: ['核心函数'], producesContracts: [] }
      );
    } else {
      subtasks.push(
        { id: 'T1', title: '需求分析与架构设计', description: '分析需求，设计系统架构', role: 'architect', dependsOn: [], acceptanceCriteria: '架构设计文档，模块划分清晰', estimatedComplexity: 'medium', estimatedHours: 1, requiredContracts: [], producesContracts: ['架构设计'] },
        { id: 'T2', title: '接口与数据结构设计', description: '设计API接口和核心数据结构', role: 'architect', dependsOn: ['T1'], acceptanceCriteria: '接口定义完整，数据结构设计合理', estimatedComplexity: 'medium', estimatedHours: 1, requiredContracts: ['架构设计'], producesContracts: ['数据结构', 'API接口'] },
        { id: 'T3', title: '核心模块实现', description: '实现主要业务逻辑', role: 'code_writer', dependsOn: ['T2'], acceptanceCriteria: '核心功能正确，可编译运行', estimatedComplexity: 'high', estimatedHours: 3, requiredContracts: ['数据结构', 'API接口'], producesContracts: ['核心模块'] },
        { id: 'T4', title: '辅助模块实现', description: '实现工具类、辅助函数', role: 'code_writer', dependsOn: ['T2'], acceptanceCriteria: '辅助功能完整，与核心模块配合正常', estimatedComplexity: 'medium', estimatedHours: 2, requiredContracts: ['数据结构'], producesContracts: ['辅助模块'] },
        { id: 'T5', title: '代码审查', description: '全面审查代码质量和规范', role: 'code_reviewer', dependsOn: ['T3', 'T4'], acceptanceCriteria: '无严重问题，代码风格一致', estimatedComplexity: 'medium', estimatedHours: 1, requiredContracts: ['核心模块', '辅助模块'], producesContracts: [] },
        { id: 'T6', title: '测试设计与执行', description: '设计测试用例，验证功能', role: 'tester', dependsOn: ['T3', 'T4'], acceptanceCriteria: '测试覆盖核心功能，通过率>90%', estimatedComplexity: 'medium', estimatedHours: 1.5, requiredContracts: ['核心模块', '辅助模块'], producesContracts: [] },
        { id: 'T7', title: '质量检查与验收', description: '最终质量检查，确保符合约束', role: 'quality_checker', dependsOn: ['T5', 'T6'], acceptanceCriteria: '所有约束通过，质量评分>80分', estimatedComplexity: 'low', estimatedHours: 0.5, requiredContracts: [], producesContracts: [] }
      );
    }

    const constraints = {
      language: language.toLowerCase(), techStack: 'console', platform: 'windows', framework: 'None', style: 'standard', fileExtension: language.toLowerCase()
    };

    return {
      taskOverview: taskDescription,
      constraints,
      subtasks,
      dependencyGraph: this._buildDependencyGraph(subtasks),
      coverageCheck: { allRequirementsCovered: true, potentialGaps: ['需人工确认覆盖度'], riskItems: [] },
      overallPlan: '基于复杂度分析自动生成的执行计划',
      contractAnalysis: { existingContracts: [], newContractsNeeded: [], contractConflicts: [] }
    };
  }

  _normalizeResult (parsed, taskDescription) {
    if (!parsed.constraints) {
      const languageMatch = taskDescription.match(/(C语言|C\+\+|Python|JavaScript|Java|Go|Rust|TypeScript|HTML|CSS)/i);
      parsed.constraints = {
        language: languageMatch ? languageMatch[0].toLowerCase() : 'python',
        techStack: 'console',
        platform: 'windows',
        framework: 'None',
        style: 'standard',
        fileExtension: languageMatch ? languageMatch[0].toLowerCase() : 'py'
      };
    }
    if (!parsed.dependencyGraph) {
      parsed.dependencyGraph = this._buildDependencyGraph(parsed.subtasks);
    }
    if (!parsed.coverageCheck) {
      parsed.coverageCheck = { allRequirementsCovered: true, potentialGaps: [], riskItems: [] };
    }
    if (!parsed.contractAnalysis) {
      parsed.contractAnalysis = { existingContracts: [], newContractsNeeded: [], contractConflicts: [] };
    }

    for (const t of parsed.subtasks) {
      if (!t.requiredContracts) t.requiredContracts = [];
      if (!t.producesContracts) t.producesContracts = [];
    }

    return parsed;
  }

  async _selfCheck (parsed, originalTask, context) {
    const checkPrompt = `请检查以下任务分解是否完整、合理：\n\n原始任务：${originalTask}\n\n分解结果：\n${JSON.stringify(parsed.subtasks, null, 2)}\n\n请回答：\n1. 是否所有原始需求都被覆盖？\n2. 依赖关系是否合理？\n3. 是否有遗漏或冗余的子任务？\n4. 复杂度估算是否合理？\n5. 契约依赖是否完整？\n\n输出JSON格式：{ "covered": true, "issues": ["问题1"], "suggestions": ["建议1"] }`;

    try {
      const checkResult = await this.sendOnce(checkPrompt, { temperature: 0.2 });
      const checkParsed = this._extractJson(checkResult.content);
      if (checkParsed && !checkParsed.covered) {
        parsed.coverageCheck = {
          ...parsed.coverageCheck,
          allRequirementsCovered: false,
          potentialGaps: checkParsed.issues || ['自检发现覆盖不足']
        };
      }
    } catch (e) {
    }
    return parsed;
  }

  _validateDependencies (subtasks) {
    const graph = {};
    const inDegree = {};
    const idSet = new Set(subtasks.map(t => t.id));

    for (const t of subtasks) {
      graph[t.id] = t.dependsOn || [];
      inDegree[t.id] = inDegree[t.id] || 0;
      for (const dep of t.dependsOn || []) {
        if (!idSet.has(dep)) {
          return { valid: false, error: `依赖ID ${dep} 不存在`, cycles: [] };
        }
        inDegree[t.id]++;
      }
    }

    const visited = new Set();
    const recStack = new Set();
    const cycles = [];

    const dfs = (node, path) => {
      visited.add(node);
      recStack.add(node);
      path.push(node);

      for (const neighbor of graph[node] || []) {
        if (!visited.has(neighbor)) {
          dfs(neighbor, path);
        } else if (recStack.has(neighbor)) {
          const cycleStart = path.indexOf(neighbor);
          cycles.push(path.slice(cycleStart).concat([neighbor]));
        }
      }
      recStack.delete(node);
      path.pop();
    };

    for (const id of idSet) {
      if (!visited.has(id)) dfs(id, []);
    }

    return { valid: cycles.length === 0, cycles };
  }

  _fixCircularDependencies (subtasks, cycles) {
    for (const cycle of cycles) {
      const lastTask = subtasks.find(t => t.id === cycle[cycle.length - 2]);
      if (lastTask && lastTask.dependsOn) {
        const toRemove = cycle[cycle.length - 1];
        lastTask.dependsOn = lastTask.dependsOn.filter(d => d !== toRemove);
      }
    }
    return subtasks;
  }

  _validateCoverage (subtasks, originalTask) {
    const issues = [];
    const complexity = this._analyzeComplexity(originalTask);

    const noCriteria = subtasks.filter(t => !t.acceptanceCriteria || t.acceptanceCriteria.length < 5);
    if (noCriteria.length > 0) {
      issues.push(`${noCriteria.length} 个子任务缺少验收标准 (${noCriteria.map(t => t.id).join(', ')})`);
    }

    const referenced = new Set();
    const hasDependencies = new Set();
    for (const t of subtasks) {
      if (t.dependsOn && t.dependsOn.length > 0) {
        hasDependencies.add(t.id);
        t.dependsOn.forEach(d => referenced.add(d));
      }
    }
    const orphanTasks = subtasks.filter(t => !referenced.has(t.id) && !hasDependencies.has(t.id) && subtasks.length > 1);
    if (orphanTasks.length > 0) {
      issues.push(`${orphanTasks.length} 个子任务是孤立节点 (${orphanTasks.map(t => t.id).join(', ')})`);
    }

    const unreasonableTime = subtasks.filter(t => {
      if (t.estimatedComplexity === 'high' && t.estimatedHours < 2) return true;
      if (t.estimatedComplexity === 'medium' && t.estimatedHours < 0.5) return true;
      return false;
    });
    if (unreasonableTime.length > 0) {
      issues.push(`${unreasonableTime.length} 个子任务复杂度与工时不匹配 (${unreasonableTime.map(t => t.id).join(', ')})`);
    }

    const minTasks = complexity.level === 'low' ? 1 : complexity.level === 'medium' ? 3 : 5;
    const maxTasks = complexity.level === 'low' ? 3 : complexity.level === 'medium' ? 8 : 12;
    if (subtasks.length < minTasks) {
      issues.push(`子任务数量过少 (${subtasks.length} < ${minTasks})`);
    }
    if (subtasks.length > maxTasks) {
      issues.push(`子任务数量过多 (${subtasks.length} > ${maxTasks})`);
    }

    const validRoles = ['architect', 'code_writer', 'code_reviewer', 'tester', 'quality_checker'];
    const noRole = subtasks.filter(t => !t.role || !validRoles.includes(t.role));
    if (noRole.length > 0) {
      issues.push(`${noRole.length} 个子任务缺少有效角色 (${noRole.map(t => t.id).join(', ')})`);
    }

    if (complexity.level === 'high') {
      const hasArchitect = subtasks.some(t => t.role === 'architect');
      const hasQualityChecker = subtasks.some(t => t.role === 'quality_checker');
      if (!hasArchitect) issues.push('复杂任务缺少架构设计阶段');
      if (!hasQualityChecker) issues.push('复杂任务缺少最终质量检查阶段');
    }

    const allContracts = new Set();
    const producedContracts = new Set();
    for (const t of subtasks) {
      if (t.requiredContracts) t.requiredContracts.forEach(c => allContracts.add(c));
      if (t.producesContracts) t.producesContracts.forEach(c => producedContracts.add(c));
    }
    const missingContracts = [...allContracts].filter(c => !producedContracts.has(c) && c);
    if (missingContracts.length > 0) {
      issues.push(`契约依赖不完整：缺少 ${missingContracts.join(', ')}`);
    }

    const coverageRatio = Math.round((1 - issues.length / 9) * 100);
    const needsResplit = issues.length >= 2 || coverageRatio < 60;

    return {
      allRequirementsCovered: issues.length === 0,
      coverageRatio,
      potentialGaps: issues,
      riskItems: issues.length > 2 ? ['多项结构校验未通过，建议人工审查'] : [],
      needsResplit,
      issueCount: issues.length
    };
  }

  _buildDependencyGraph (subtasks) {
    const graph = {};
    for (const t of subtasks) {
      graph[t.id] = t.dependsOn || [];
    }
    return graph;
  }

  async _resplitWithFeedback (taskDescription, context, previousResult, coverage) {
    const feedbackPrompt = `之前的任务拆解存在以下问题，请重新拆解：

原始任务：${taskDescription}

上一次拆解的问题：
${coverage.potentialGaps.map(g => `- ${g}`).join('\n')}

请重新拆解上述任务，确保：
1. 每个子任务都有明确的验收标准（至少5个字符）
2. 子任务数量适中（根据复杂度合理，一般3-8个）
3. 依赖关系清晰，无孤立节点
4. 每个子任务有明确的角色（architect/code_writer/code_reviewer/tester/quality_checker）
5. 复杂度估算与工时匹配（high>=2h, medium>=0.5h）
6. 如果是复杂任务，应包含architect和quality_checker角色
7. 契约依赖完整（requiredContracts能被其他子任务的producesContracts覆盖）

输出格式（严格 JSON）：
{
  "taskOverview": "任务概述",
  "constraints": { "language": "...", "techStack": "...", ... },
  "subtasks": [
    { "id": "T1", "title": "...", "description": "...", "role": "...", "dependsOn": [], "acceptanceCriteria": "...", "estimatedComplexity": "...", "estimatedHours": ..., "requiredContracts": [], "producesContracts": [] }
  ],
  "dependencyGraph": { "T1": ["T2"], ... },
  "coverageCheck": { "allRequirementsCovered": true, "potentialGaps": [], "riskItems": [] },
  "overallPlan": "整体执行计划",
  "contractAnalysis": { "existingContracts": [], "newContractsNeeded": [], "contractConflicts": [] }
}

注意：只输出 JSON，不要其他文字。`;

    try {
      const result = await this.sendOnce(feedbackPrompt, { temperature: 0.2 });
      let parsed = this._extractJson(result.content);

      if (!parsed || !parsed.subtasks) {
        previousResult.coverageCheck.riskItems.push('重拆失败，AI返回格式无效');
        return previousResult;
      }

      parsed = this._normalizeResult(parsed, taskDescription);

      const newCoverage = this._validateCoverage(parsed.subtasks, taskDescription);
      parsed.coverageCheck = newCoverage;

      if (newCoverage.needsResplit && this.resplitCount >= this.maxResplits) {
        parsed.coverageCheck.riskItems.push(`重拆${this.resplitCount}次后仍不理想，建议人工审查`);
      }

      return parsed;
    } catch (e) {
      previousResult.coverageCheck.riskItems.push(`重拆异常: ${e.message}`);
      return previousResult;
    }
  }

  recordExecution (taskId, subtaskId, result) {
    this.executionHistory.push({
      taskId,
      subtaskId,
      success: result.success,
      qualityScore: result.qualityScore,
      estimatedComplexity: result.estimatedComplexity,
      actualTime: result.actualTime,
      timestamp: Date.now()
    });

    this._updateTaskStats(result);
  }

  _updateTaskStats (result) {
    this.taskStats.total++;
    if (result.success) {
      this.taskStats.successful++;
    } else {
      this.taskStats.failed++;
    }

    if (result.qualityScore) {
      this.taskStats.averageQuality = Math.round(
        (this.taskStats.averageQuality * (this.taskStats.total - 1) + result.qualityScore) / this.taskStats.total
      );
    }

    if (result.actualTime) {
      this.taskStats.avgSplitTime = Math.round(
        (this.taskStats.avgSplitTime * (this.taskStats.total - 1) + result.actualTime) / this.taskStats.total
      );
    }
  }

  suggestAdjustment (taskDescription, previousResult) {
    const failedSubtasks = previousResult.subtasks.filter(t =>
      this.executionHistory.some(e => e.subtaskId === t.id && !e.success)
    );

    if (failedSubtasks.length === 0) return null;

    return {
      needsAdjustment: true,
      failedSubtasks: failedSubtasks.map(t => t.id),
      suggestion: `以下子任务执行失败，建议重新拆解或调整：${failedSubtasks.map(t => t.title).join(', ')}`,
      adjustmentType: this._determineAdjustmentType(failedSubtasks, previousResult)
    };
  }

  _determineAdjustmentType (failedSubtasks, previousResult) {
    const failureRate = failedSubtasks.length / previousResult.subtasks.length;

    if (failureRate >= 0.5) return 'redesign';
    if (failureRate >= 0.3) return 'merge';
    if (failedSubtasks.some(t => t.estimatedComplexity === 'high')) return 'split';

    return 'adjust';
  }

  _adjustStrategyBasedOnFeedback () {
    const recentHistory = this.executionHistory.slice(-this.adaptiveThreshold);
    const successRate = recentHistory.filter(e => e.success).length / recentHistory.length;
    const avgQuality = recentHistory.reduce((sum, e) => sum + (e.qualityScore || 0), 0) / recentHistory.length;

    const adjustments = [];

    if (successRate < 0.5) {
      adjustments.push(...this._handleLowSuccessRate(recentHistory));
    } else if (avgQuality < 60) {
      adjustments.push(...this._handleLowQuality(recentHistory));
    } else if (successRate > 0.8 && avgQuality > 80) {
      adjustments.push(...this._handleHighPerformance(recentHistory));
    }

    if (adjustments.length > 0) {
      const adjustmentLog = adjustments.map(a => `${a.field}: ${a.old} -> ${a.new}`).join(', ');
      console.log(`[TaskSplitter] 策略调整: ${adjustmentLog}`);
    }
  }

  _handleLowSuccessRate (recentHistory) {
    const adjustments = [];
    const failedComplexities = recentHistory
      .filter(e => !e.success)
      .map(e => e.estimatedComplexity);

    const highFailRate = failedComplexities.filter(c => c === 'high').length / failedComplexities.length;

    if (highFailRate > 0.5) {
      adjustments.push({ field: 'granularity', old: this.splitPatterns.granularity, new: 'finer' });
      this.splitPatterns.granularity = 'finer';
    }

    adjustments.push({ field: 'dependencyWeight', old: this.splitPatterns.dependencyWeight, new: this.splitPatterns.dependencyWeight + 0.2 });
    this.splitPatterns.dependencyWeight = Math.min(2.0, this.splitPatterns.dependencyWeight + 0.2);

    return adjustments;
  }

  _handleLowQuality (recentHistory) {
    const adjustments = [];

    if (this.splitPatterns.complexityBias !== 'conservative') {
      adjustments.push({ field: 'complexityBias', old: this.splitPatterns.complexityBias, new: 'conservative' });
      this.splitPatterns.complexityBias = 'conservative';
    }

    return adjustments;
  }

  _handleHighPerformance (recentHistory) {
    const adjustments = [];

    if (this.splitPatterns.granularity === 'finer') {
      adjustments.push({ field: 'granularity', old: this.splitPatterns.granularity, new: 'normal' });
      this.splitPatterns.granularity = 'normal';
    }

    if (this.splitPatterns.dependencyWeight > 1.0) {
      adjustments.push({ field: 'dependencyWeight', old: this.splitPatterns.dependencyWeight, new: Math.max(1.0, this.splitPatterns.dependencyWeight - 0.1) });
      this.splitPatterns.dependencyWeight = Math.max(1.0, this.splitPatterns.dependencyWeight - 0.1);
    }

    return adjustments;
  }

  getStrategyReport () {
    return {
      splitPatterns: { ...this.splitPatterns },
      taskStats: { ...this.taskStats },
      executionHistory: this.executionHistory.slice(-10),
      feedbackEnabled: this.feedbackLoopEnabled,
      adjustmentThreshold: this.adaptiveThreshold
    };
  }

  resetStrategy () {
    this.splitPatterns = {
      granularity: 'normal',
      dependencyWeight: 1.0,
      complexityBias: 'balanced'
    };
    this.taskStats = {
      total: 0,
      successful: 0,
      failed: 0,
      averageQuality: 0,
      avgSplitTime: 0
    };
    this.executionHistory = [];
  }

  async adaptiveResplit (taskDescription, previousResult, executionResults) {
    if (!this.feedbackLoopEnabled) {
      return await this.splitTask(taskDescription, {
        historicalData: JSON.stringify(executionResults)
      });
    }

    const adjustment = this.suggestAdjustment(taskDescription, previousResult);
    if (!adjustment) return previousResult;

    const feedbackPrompt = `之前的任务拆解执行效果不佳，请基于反馈重新拆解。

原始任务：${taskDescription}

上一次拆解结果：
${JSON.stringify(previousResult.subtasks.map(t => ({ id: t.id, title: t.title, estimatedComplexity: t.estimatedComplexity })), null, 2)}

执行反馈：
${JSON.stringify(executionResults, null, 2)}

调整建议：${adjustment.suggestion}
调整类型：${adjustment.adjustmentType}

请根据以下策略重新拆解：
- 粒度模式: ${this.splitPatterns.granularity}
- 依赖权重: ${this.splitPatterns.dependencyWeight}
- 复杂度偏向: ${this.splitPatterns.complexityBias}

输出格式（严格 JSON）：
{
  "taskOverview": "任务概述",
  "constraints": { "language": "...", "techStack": "...", ... },
  "subtasks": [
    { "id": "T1", "title": "...", "description": "...", "role": "...", "dependsOn": [], "acceptanceCriteria": "...", "estimatedComplexity": "...", "estimatedHours": ..., "requiredContracts": [], "producesContracts": [] }
  ],
  "dependencyGraph": { "T1": ["T2"], ... },
  "coverageCheck": { "allRequirementsCovered": true, "potentialGaps": [], "riskItems": [] },
  "overallPlan": "整体执行计划",
  "contractAnalysis": { "existingContracts": [], "newContractsNeeded": [], "contractConflicts": [] }
}

注意：只输出 JSON，不要其他文字。`;

    try {
      const result = await this.sendOnce(feedbackPrompt, { temperature: 0.2 });
      let parsed = this._extractJson(result.content);

      if (!parsed || !parsed.subtasks) {
        return previousResult;
      }

      parsed = this._normalizeResult(parsed, taskDescription);
      const coverage = this._validateCoverage(parsed.subtasks, taskDescription);
      parsed.coverageCheck = coverage;

      return parsed;
    } catch (e) {
      return previousResult;
    }
  }
}

module.exports = TaskSplitterAgent;
