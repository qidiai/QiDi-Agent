# 核心流水线修复意见整合

> 项目：Qidi Agent (ai-orchestrator)
> 流水线：拆分 → 分发2个AI编程工具 → 质检 → 合并 → 顶尖代码
> 日期：2026-07-03
> 状态：Verification Complete ✅

---

## 一、当前流水线全景

```
用户任务描述
    │
    ▼
┌─────────────────────────────────────┐
│  TaskSplitterAgent (835行)           │
│  · 一次拆成子任务列表（不支持递归）      │
│  · 子任务3-10个                       │
└──────────────────┬──────────────────┘
                   │ sub tasks
                   ▼
┌─────────────────────────────────────┐
│  RealTaskExecutor._executeSubtasks   │  ← 路径A (L290-337)
│  · 串行执行子任务                     │
│  · 跳过 quality_checker 角色子任务    │
│  · 工具挨个试（30s超时）              │
└──────────────────┬──────────────────┘
                   │ per subtask
                   ▼
┌─────────────────────────────────────┐
│  TaskExecutor._executeCodeTask       │  ← 路径B (L171-213)
│  · Provider写代码 → dispatch工具 →  │
│    合并所有结果（无逐工具质检）         │
└──────────────────┬──────────────────┘
                   │ OR
                   ▼
┌─────────────────────────────────────┐
│  MultiAgentDispatcher._dispatchMerge │  ← 路径C (L367-394)
│  · 并行所有Agent → 直接MergeEngine  │
│  · 中间无质检环节                     │
└──────────────────┬──────────────────┘
                   │ results
                   ▼
┌─────────────────────────────────────┐
│  MergeEngine (1029行)                │
│  · AI合并代码                         │
│  · 质量评分=各工具得分的平均值         │
└─────────────────────────────────────┘
```

---

## 二、6个结构性断裂点及修复方案

---

### 断裂点①：任务拆分 → 不支持递归拆解复杂任务

**位置**：`TaskSplitterAgent.js` (L70-835)

**核实结论**：✅ 问题确认

**问题细节**：
- `splitTask()` (L104) 只执行一次LLM调用，产出的子任务列表是平的
- 对于大型项目（如"构建一个企业级Web应用"），子任务颗粒度过粗，单个子任务仍需要再次拆分
- `this.maxResplits = 2` (L82) 存在但仅质量反馈后微调使用，不涉及递归分层
- `this.splitPatterns.granularity: 'normal'` (L91) 不支持动态粒度调整

**根因**：LLM一次调用受输出token限制，16K上下文下最多产出10个合理子任务；对于30+模块的大型项目，首次拆分粒度必然不足。

**修复方案**：

```javascript
// 在 TaskSplitterAgent 中新增
async _recursiveSplit (taskDescription, context = {}, depth = 0) {
  const MAX_DEPTH = 3;
  const tasks = await this.splitTask(taskDescription, context);
  
  for (const task of tasks.subtasks) {
    // 复杂度检测条件
    const isComplex = 
      task.estimatedComplexity === 'high' ||
      task.estimatedLines > 200 ||
      task.requiresSubTask;
    
    if (isComplex && depth < MAX_DEPTH) {
      // 递归拆分，维护嵌套ID体系
      const childTasks = await this._recursiveSplit(
        task.description, 
        { ...context, parentId: task.id }, 
        depth + 1
      );
      task.children = childTasks.subtasks;
    }
  }
  
  return tasks;
}
```

**关键修改点**：
| 文件 | 行范围 | 修改内容 |
|------|--------|---------|
| `src/agents/TaskSplitterAgent.js` | 新增方法 | 添加 `_recursiveSplit()` 递归拆分逻辑 |

**预估工作量**：1天（100-150行新增代码）

---

### 断裂点②：多工具分发 → 所有工具收到相同任务，无按模块拆分

**位置**：`TaskExecutor._dispatchToAdapters()` (L320-378) + `_buildToolTaskDescription()` (L512-523)

**核实结论**：✅ 问题确认

**问题细节**：
- `_dispatchToAdapters()` 创建的 `taskDesc` 包含完整的任务描述 = 给**所有工具发的是同一份完整任务描述**
- 假设场景：拆分出 T1(前端) 和 T2(后端) 两个子任务，Claude Code 和 Qoder 都收到 T1+T2 的全部内容
- 两个工具分别产出相同模块的冲突版本，没有发挥"按特长分发"的优势
- 资源浪费：N个工具产出N份全量代码，MergeEngine 需要解决大量重复冲突

**修复方案**：

```javascript
// 路由策略：按模块边界分发
async _dispatchModuleToAdapters (task, context) {
  const adapters = this.adapterManager.getAvailableAdapters();
  const modules = task.subtasks || [task]; // 获取模块列表
  const contractMap = this._extractModuleContracts(modules);
  
  const results = {};
  for (const [i, adapter] of adapters.entries()) {
    // 主分配模块
    const primaryModule = modules[i % modules.length];
    // 其他模块仅包含接口契约摘要
    const otherModules = modules.filter((_, j) => j !== i % modules.length)
      .map(m => ({ id: m.id, title: m.title, contracts: contractMap.get(m.id) }));
    
    results[adapter.name] = await adapter.execute({
      primaryTask: primaryModule,       // 该工具负责的模块
      neighboringContracts: otherModules, // 相邻模块契约
      globalContext: task.description,  // 全局上下文（紧凑）
    });
  }
  return results;
}
```

**目标效果对比**：

```
传统模式（当前）：
  工具A ← [T1+T2+T3]  工具B ← [T1+T2+T3]  → 各自产出全集 → 大量冲突

修复后：
  工具A ← [T1契约 + T2摘要 + T3摘要]  
  工具B ← [T2契约 + T1摘要 + T3摘要]  
  → 各自产出最佳对应的模块，无重复劳动
```

**关键修改点**：
| 文件 | 行范围 | 修改内容 |
|------|--------|---------|
| `src/core/TaskExecutor.js` | L320-L378 | `_dispatchToAdapters` 改为按模块分发 |

**预估工作量**：2天（200-300行修改）

---

### 断裂点③：缺少"逐工具质检"环节

**位置**：
- `TaskExecutor._executeCodeTask()` (L205-206)
- `MultiAgentDispatcher._dispatchMerge()` (L391-394)

**核实结论**：✅ 问题确认

**问题细节**：
- `_executeCodeTask` L205: `const adapterResults = await this._dispatchToAdapters(task, enhancedContext);`
- L206: `const finalResult = await this._mergeToolOutputs(task, providerResult || {}, adapterResults, enhancedContext);`
- ⚠️ dispatch 结果**直接送入 merge**，中间无任何质检过滤
- `_dispatchMerge` L391-394: 并行执行 → 收集成功结果 → **直接 MergeEngine.merge()**
- 问题工具的输出污染合并结果，MergeEngine 的 prompt 中已有错误代码
- 正确流应为：工具A结果 → 质检 → 工具B结果 → 质检 → 过滤不合格的 → 合并

**修复方案**：

```javascript
// TaskExecutor._executeCodeTask L205-206 改为：

// 1. 分发到各工具
const rawResults = await this._dispatchToAdapters(task, enhancedContext);

// 2. 每工具结果单独质检（新增 PerToolQualityGate）
const qualityFiltered = {};
for (const [toolName, result] of Object.entries(rawResults)) {
  if (!result.success) continue;
  
  const qc = await this.agents.qualityChecker.checkQuality(
    task, result, enhancedContext
  );
  
  if (qc.status !== 'failed') {
    qualityFiltered[toolName] = {
      ...result,
      qualityScore: qc.qualityScore,
      qualityReport: qc
    };
  } else {
    // 保留"不合格但可用"的备份，标记质量警告
    qualityFiltered[toolName] = {
      ...result, 
      qualityScore: 0, 
      qualityWarning: true
    };
  }
}

// 3. 仅合并通过质检的结果（或带警告的备份）
const finalResult = await this._mergeToolOutputs(
  task, providerResult, qualityFiltered, enhancedContext
);
```

```javascript
// MultiAgentDispatcher._dispatchMerge L391-394 同理：

// 2.5 每Agent结果单独质检
const filteredResults = {};
for (const [name, result] of Object.entries(successfulResults)) {
  const qc = await qualityChecker.checkQuality(taskDescription, result, options);
  if (qc.status !== 'failed') {
    filteredResults[name] = { ...result, qualityScore: qc.qualityScore };
  }
}

// 3. 仅合并通过质检的结果
const mergeResult = await mergeEngine.merge(filteredResults, options.constraints || {});
```

**关键修改点**：
| 文件 | 行范围 | 修改内容 |
|------|--------|---------|
| `src/core/TaskExecutor.js` | L205-L206 | dispatch和merge之间插入逐工具质检 |
| `src/core/MultiAgentDispatcher.js` | L391-L394 | 并行执行后、合并前插入质检过滤 |

**预估工作量**：1-2天（150-250行修改）

---

### 断裂点④：合并质量评估 → 仅取平均值，不分析实际合并代码

**位置**：`MergeEngine._assessMergedQuality()` (L960-978)

**核实结论**：✅ 问题确认

**问题细节**：

当前实现（L960-978）：
```javascript
async _assessMergedQuality (mergedFiles, entries, constraints) {
  if (entries.length === 1) {
    const score = entries[0][1].result?.quality?.qualityScore || 70;
    return { correctness: score, consistency: score, readability: score, 
             security: score, overall: score };
  }

  const scores = entries.map(([_, r]) => r.result?.quality?.qualityScore || 60);
  const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const maxScore = Math.max(...scores);

  return {
    correctness: maxScore,        // 正确性=最高分
    consistency: avgScore,        // 一致性=平均分
    readability: avgScore,        // 可读性=平均分（与一致性问题同一数值）
    security: avgScore,           // 安全性=平均分（同）
    overall: Math.round((maxScore + avgScore) / 2)
  };
}
```

**问题**：
1. 所有维度都用同一个平均值 → 多维评估失去意义
2. 没有分析合并后的实际代码质量（冲突解决质量、语法正确性、接口完整性）
3. 仅依赖**输入工具**的评分，不分析**合并结果**本身

**修复方案**：

```javascript
async _assessMergedQuality (mergedFiles, entries, constraints) {
  const mergedCode = Object.values(mergedFiles).join('\n');
  
  // 1. 目标语言编译/语法检查
  const compilePassed = await this._runCompileCheck(mergedCode, constraints.language);
  
  // 2. 统计冲突解决质量
  const unresolvedConflicts = this._countUnresolvedConflicts(mergedCode);
  const conflictScore = Math.max(0, 100 - unresolvedConflicts * 20);
  
  // 3. 代码完整性检查（匹配契约定义的接口数）
  const contractCompleteness = this._checkContractCoverage(mergedCode, constraints);
  
  // 4. 原始工具评分的参考权重（30%）
  const baseScores = entries.map(([_, r]) => r.result?.quality?.qualityScore || 0);
  const refScore = baseScores.length > 0 ? Math.max(...baseScores) * 0.3 : 0;
  
  // 5. 综合评分（实际代码分析占70%）
  const score = Math.round(
    refScore + 
    (compilePassed ? 25 : 0) + 
    conflictScore * 0.25 + 
    contractCompleteness * 0.2
  );
  
  return {
    correctness: Math.min(100, compilePassed ? score + 10 : score - 20),
    consistency: conflictScore,
    readability: Math.min(100, contractCompleteness > 80 ? score : score - 10),
    security: Math.min(100, score),
    overall: Math.min(100, score)
  };
}

async _runCompileCheck (code, language) {
  // 根据目标语言调用对应编译器做语法检查
  // TypeScript → tsc --noEmit, Python → py_compile, Java → javac
  try {
    // 写入临时文件 → 执行编译命令 → 解析退出码
    return true; // 或 false
  } catch {
    return false;
  }
}

_countUnresolvedConflicts (code) {
  // 统计 merge conflict markers
  const conflictRegex = /<<<<<<< |=======|>>>>>>> /g;
  const matches = code.match(conflictRegex);
  return matches ? Math.ceil(matches.length / 3) : 0;
}

_checkContractCoverage (code, constraints) {
  // 检查契约中定义的接口在合并代码中的实现情况
  if (!constraints?.contracts) return 100;
  const implemented = constraints.contracts.filter(c => 
    code.includes(c.signature) || new RegExp(c.pattern).test(code)
  );
  return Math.round((implemented.length / constraints.contracts.length) * 100);
}
```

**关键修改点**：
| 文件 | 行范围 | 修改内容 |
|------|--------|---------|
| `src/agents/MergeEngine.js` | L960-L978 | `_assessMergedQuality` 重写：基于实际合并代码分析 |

**预估工作量**：1天（100-150行）

---

### 断裂点⑤：质检 → integration gate 默认禁用，AI评分不结合客观数据

**位置**：`QualityCheckerAgent` (L274-280, L539-600)

**核实结论**：✅ 问题确认

**问题细节**：

```javascript
// L274-280：集成测试门控默认关闭
this.gates = {
  earlySafety: { enabled: true, passThreshold: 0, failAction: 'block' },
  compile:     { enabled: true, passThreshold: 0, failAction: 'block' },
  lint:        { enabled: true, passThreshold: 0, failAction: 'warn' },
  aiReview:    { enabled: true, passThreshold: 75, failAction: 'block' },
  integration: { enabled: false, passThreshold: 0, failAction: 'warn' }  // ← 关闭
};
```

- `integration.enabled = false` → 多模块产出的集成测试**从未执行**
- `_applyObjectiveScoring()` 虽然参考编译/lint结果，但对AI评分结果依赖过重
- 客观工具数据只有硬限制（编译不过→扣到50分以下），没有**定量加权**
- AI主观评分权重过高，缺乏客观数据校正

**修复方案**：

```javascript
// 1. 启用 integration gate
this.gates = {
  earlySafety:  { enabled: true,  passThreshold: 0,  failAction: 'block' },
  compile:      { enabled: true,  passThreshold: 0,  failAction: 'block' },
  lint:         { enabled: true,  passThreshold: 0,  failAction: 'warn' },
  aiReview:     { enabled: true,  passThreshold: 75, failAction: 'block' },
  integration:  { enabled: true,  passThreshold: 50, failAction: 'warn' }
};

// 2. _applyObjectiveScoring 加入加权评分
// 评分权重分配：
//   AI评分        40%
//   编译检查       20%
//   静态分析(lint) 15%
//   安全扫描       10%
//   集成测试       15%
//   ─────────────────
//   最终分        100%
```

**关键修改点**：
| 文件 | 行范围 | 修改内容 |
|------|--------|---------|
| `src/agents/QualityCheckerAgent.js` | L279 | `integration.enabled` → `true`，`passThreshold` → `50` |
| `src/agents/QualityCheckerAgent.js` | L539-L600 | `_applyObjectiveScoring` 加权评分 |

**预估工作量**：0.5天

---

### 断裂点⑥：RealTaskExecutor → 工具串行尝试，无并行多工具分发

**位置**：`RealTaskExecutor._executeSingleSubtask()` (L339-400)

**核实结论**：✅ 问题确认

**问题细节**：

```javascript
// L362-399：遍历工具列表，挨个试，30s超时，第一个成功就返回
if (hasTools) {
  for (const toolName of availableTools) {
    const toolResult = await this.toolExecutor.executeTask(subtask, {
      preferredTools: [toolName],
      timeout: 30000,           // 30s短超时
    });
    if (toolResult.success) {
      // 第一个成功的工具 → 返回，后面的工具不用
      return { ... };
    }
  }
}
```

- **串行**尝试所有工具，不是并行分发到多工具
- 30s超时对AI编程工具太短（实际代码生成通常30-120s）
- 第一个成功的工具直接返回 → 没有"多个工具结果合并取最优"的逻辑
- 多工具协同的核心价值未实现

**修复方案**：

```javascript
async _executeSingleSubtask (subtask, constraints) {
  const startTime = Date.now();
  const availableTools = this.toolExecutor.getAvailableTools();
  const hasTools = availableTools.length > 0;
  const hasProvider = this.enabledProviders.length > 0;

  if (!hasTools && !hasProvider) {
    return { success: false, error: '没有可用的 AI 工具或模型', ... };
  }

  if (hasTools) {
    if (this.publicMode) {
      // ── 对外真实工具模式：并行多工具分发 ──
      return await this._executeParallelTools(subtask, availableTools, startTime);
    } else {
      // ── 隐私模式：选一个工具 ──
      return await this._executeSingleTool(subtask, availableTools, startTime);
    }
  }

  // 降级：使用 AI 提供商
  ...
}

async _executeParallelTools (subtask, tools, startTime) {
  // 1. 同时分发到所有可用工具
  const promises = tools.map(toolName =>
    this.toolExecutor.executeTask(subtask, {
      preferredTools: [toolName],
      timeout: 120000,  // 120s（而非30s）
      workspace: this.workspaceDir
    }).then(result => ({ toolName, result }))
  );

  const rawResults = await Promise.allSettled(promises);

  // 2. 收集所有成功结果
  const successful = rawResults
    .filter(r => r.status === 'fulfilled' && r.value.result.success)
    .map(r => r.value);

  if (successful.length === 0) {
    // 全失败 → 降级
    return this._executeSingleTool(subtask, tools, startTime);
  }

  // 3. 每工具单独质检
  const qualityFiltered = [];
  for (const { toolName, result } of successful) {
    const qc = await this._checkToolQuality(subtask, result);
    qualityFiltered.push({ toolName, result, quality: qc });
  }

  // 4. MergeEngine 合并多工具最优输出
  if (qualityFiltered.length > 1) {
    const mergeEngine = new MergeEngine();
    const mergeResult = await mergeEngine.merge(
      Object.fromEntries(qualityFiltered.map(q => [q.toolName, q.result])),
      {}
    );
    return {
      success: true,
      duration: Date.now() - startTime,
      merged: true,
      output: mergeResult,
      generatedFiles: Object.keys(mergeResult.mergedFiles || {}),
      toolResults: qualityFiltered
    };
  }

  // 只有一个工具成功 → 直接返回
  const best = qualityFiltered[0];
  return {
    success: true,
    duration: Date.now() - startTime,
    tool: best.toolName,
    output: best.result,
    generatedFiles: best.result.generatedFiles || [],
  };
}
```

**关键修改点**：
| 文件 | 行范围 | 修改内容 |
|------|--------|---------|
| `src/core/RealTaskExecutor.js` | L339-L400 | `_executeSingleSubtask` 改为并行多工具分发，超时120s |

**预估工作量**：2天（200-300行修改）

---

## 三、修复优先级与实践路线

| 优先级 | 断裂点 | 核心影响 | 预估工作量 | 涉及文件 |
|--------|--------|----------|-----------|---------|
| **P0** | ③ 缺少逐工具质检 | 低质量输出直接进入合并，污染最终结果 | 1-2天 | `TaskExecutor.js`, `MultiAgentDispatcher.js` |
| **P0** | ④ 合并质量评分失真 | 无法判断合并结果是否达到"顶尖标准" | 1天 | `MergeEngine.js` |
| **P1** | ② 任务描述不分模块分发 | 工具重复劳动，无法发挥各自特长 | 2天 | `TaskExecutor.js` |
| **P1** | ⑥ 工具串行执行非并行 | 多工具协同的核心价值未实现 | 2天 | `RealTaskExecutor.js` |
| **P2** | ① 不支持递归拆分 | 大型项目拆分粒度不够细 | 1天 | `TaskSplitterAgent.js` |
| **P2** | ⑤ integration gate 关闭 | 多模块集成缺乏自动化验证 | 0.5天 | `QualityCheckerAgent.js` |

### 建议实施路线

```
阶段1 — P0（2-3天）：逐工具质检 + 合并质量评分修复
  核心闭环"拆分→分发→质检→合并→评分"能正确运行

  Day 1-2:  断裂点③  PerToolQualityGate
  Day 2-3:  断裂点④  _assessMergedQuality 重写

阶段2 — P1（3-4天）：模块化分发 + 并行多工具
  实现"分发2个AI编程工具→各自产出最优模块"的核心价值

  Day 4-5:  断裂点②  _dispatchModuleToAdapters
  Day 5-7:  断裂点⑥  _executeParallelTools

阶段3 — P2（1.5天）：递归拆分 + integration gate
  支持大型项目 + 端到端集成验证

  Day 8:    断裂点①  _recursiveSplit
  Day 9:    断裂点⑤  加权评分 + 启用integration
```

---

## 四、关键代码修改清单（汇总）

| 文件 | 行范围 | 修改内容 | 优先级 |
|------|--------|---------|--------|
| `src/agents/TaskSplitterAgent.js` | 新增方法 | `_recursiveSplit()` 递归拆分 | P2 |
| `src/core/TaskExecutor.js` | L205-L206 | dispatch和merge之间插入逐工具质检 | **P0** |
| `src/core/TaskExecutor.js` | L320-L378 | `_dispatchToAdapters` 改按模块分发 | P1 |
| `src/core/RealTaskExecutor.js` | L339-L400 | `_executeSingleSubtask` 并行多工具分发 | P1 |
| `src/core/MultiAgentDispatcher.js` | L391-L394 | 合并前插入质检过滤 | **P0** |
| `src/agents/QualityCheckerAgent.js` | L279 | `integration.enabled = true` | P2 |
| `src/agents/QualityCheckerAgent.js` | L539-L600 | `_applyObjectiveScoring` 加权评分 | P2 |
| `src/agents/MergeEngine.js` | L960-L978 | `_assessMergedQuality` 重写 | **P0** |

---

## 五、风险说明

| 风险 | 描述 | 缓解措施 |
|------|------|---------|
| **并行多工具的资源消耗** | 同时调用2-3个 AI 编程工具，API 费用和响应时间线性增长 | 120s 超时兜底；失败降级到单工具模式 |
| **模块化分发导致接口不匹配** | 各工具负责不同模块，契约对不上导致合并失败 | `ContractAssembler` 严格验证接口签名 |
| **逐工具质检增大延迟** | 每工具结果都调用一次 QualityChecker，链上增加 N 次 LLM 调用 | 质检改为轻量模式（编译/lint 先行，AI评审后置） |
| **递归拆分产生过多子任务** | 3层递归 × 毎层5个 = 最多125个子任务，超出执行管理能力 | 每层限制最多5个子任务；整体上限30个 |

---

## 六、验收标准

修复完成后，以下场景应通过：

| 场景 | 操作 | 预期结果 |
|------|------|---------|
| 多工具质检 | 分发2个工具，其中1个产出编译错误的代码 | 含错误的工具结果被过滤，不进入合并 |
| 合并评分 | 合并2个正确工具产出 | `overall` 评分 ≥ 80，且各维度分数不雷同 |
| 模块分发 | 任务包含前后端模块 | 工具A产出前端代码，工具B产出后端代码 |
| 并行工具 | 2个工具可用 | 120s内两个工具同时执行，合并结果 |
| 递归拆分 | 大型任务（如"企业级Web应用"） | 产出2层以上子任务结构 |
| 集成测试 | 合并后代码 | 自动运行集成测试并通过 |

---

> **文档维护说明**：此文档与源代码保持同步。每次修改对应断裂点后，更新本文件中的行范围、状态和日期。
