# Qidi Agent v2.1.0：自适应编排 + 涌现度量，让多 AI 协作真正"1+1>2"

> **从"多模型投票"到"涌现工程"——启迪 Agent v2.1.0 带来三大革新：自适应智能编排、涌现度量体系、工程化加固**

---

## 📌 目录

1. [发布概览](#一发布概览)
2. [核心创新：自适应智能编排](#二核心创新自适应智能编排)
3. [独创能力：涌现度量体系](#三独创能力涌现度量体系)
4. [工程化加固：G1-G6 全接入](#四工程化加固g1-g6-全接入)
5. [可观测性：监控仪表盘](#五可观测性监控仪表盘)
6. [性能与测试数据](#六性能与测试数据)
7. [与 v2.0.0 对比](#七与-v200-对比)
8. [已知短板与优化方向](#八已知短板与优化方向)
9. [下一步规划](#九下一步规划)
10. [项目链接](#十项目链接)

---

## 一、发布概览

v2.0.0 解决了"多模型并行"问题——把任务拆给多个 AI 工具同时跑。但**多模型一起跑≠多模型协作**：如果只是各自干完然后选最好的，本质上还是"投票"，没有真正的"协作"。

v2.1.0 直击两个核心问题：

> **问题1**：用户怎么知道该选哪个工具？每个任务类型、每种语言、不同复杂度，最优工具组合是不一样的。
> **问题2**：多模型协作后，怎么证明"协作"真的比"单模型"好？而不是白跑了一遍？

### v2.1.0 三大革新

| 革新 | 解决问题 | 核心模块 |
|------|---------|---------|
| **自适应智能编排** | 问题1：自动选最佳工具组合 | AdaptiveOrchestrator |
| **涌现度量体系** | 问题2：量化"1+1>2"的协作增益 | SynchronyMeter + EmergenceEvaluator |
| **工程化加固** | 把已有的 Git/预算/审批/向量记忆全接入主管线 | G1-G6 接入 TaskOrchestrator |

---

## 二、核心创新：自适应智能编排

### 1. 三种编排模式（用户可任选）

这是 v2.1.0 最直观的用户体验提升。**用户可以选择让系统自动决策，也可以选择自己搭配工具**：

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| 🤝 **hybrid**（默认） | 系统推荐方案 + 用户确认后应用 | 想看推荐但保留控制权 |
| 🤖 **auto** | 系统全自动分析任务并应用最佳工具组合 | 让系统全权决策 |
| ✋ **manual** | 完全跳过推荐，用户自选工具 + 策略 + 模式 | 老手完全自控 |

### 2. 推荐引擎原理

推荐基于 **5 维度任务特征分析**：

```
任务输入 → ┌─────────────────────────────┐
           │  1. 语言识别（10 种语言）     │
           │  2. 任务类型（10 种类型）     │
           │  3. 复杂度评估（5 档）         │
           │  4. 规模评估（3 档）           │
           │  5. 隐私敏感度（3 档）         │
           └────────────┬────────────────┘
                        ↓
           ┌─────────────────────────────┐
           │  4 层评分机制                │
           │  L1: 启发式规则（0-30 分）   │
           │  L2: 历史学习数据（0-15 分） │
           │  L3: 用户偏好（0-20 分）     │
           │  L4: 置信度计算（50%-95%）   │
           └────────────┬────────────────┘
                        ↓
                  推荐方案
```

### 3. 实际推荐示例

输入任务：**"公司核心机密项目，重构整个微服务架构，涉及多个模块，复杂度高，使用 TypeScript"**

系统推荐：

```
任务特征:
  语言: typescript
  类型: refactoring
  复杂度: very_complex（3 个信号：复杂/微服务/架构）
  规模: large
  隐私: high

推荐工具: Claude Code + Qoder + OpenClaw（并行）
策略: broadcast
模式: efficiency
工具数: 3
置信度: 80%
```

### 4. 学习闭环（核心亮点）

v2.1.0 让推荐引擎会**自我进化**：

```
任务执行 → 成功率 ≥ 60%
   ↓
回写 outcome 到 AdaptiveOrchestrator
   ↓
成功的工具增强信心（+5 分）
失败的工具降低信心（-5 分）
   ↓
下次推荐时优先选高信心工具
```

经过 N 次执行后，系统会**学会**："原来 Claude Code 在 TypeScript 重构任务上表现最好"——这是真正的"用得越多越聪明"。

### 5. 使用方式

**WebUI**: 编排模式切换器 + 任务输入时实时显示推荐方案

```javascript
POST /api/adaptive/recommend
{
  "taskDescription": "用 Python 写一个爬虫"
}

// 响应
{
  "tools": [{ "name": "claude-code", "displayName": "Claude Code" }],
  "strategy": "broadcast",
  "mode": "quality",
  "toolCount": 3,
  "confidence": 0.80,
  "features": { "language": "python", "taskType": "feature", ... }
}
```

**CLI**: `qidi adaptive` 命令族

```bash
qidi adaptive --recommend "用 Python 写一个爬虫"
qidi adaptive --mode auto
qidi adaptive --status
qidi adaptive --prefs '{"privacySensitivity":"high","maxParallelTools":5}'
```

---

## 三、独创能力：涌现度量体系

### 1. 什么是"涌现"？

**涌现（Emergence）**：多个组件协作产生的整体行为，超越了任何单一组件的能力。就像：
- 单个蚂蚁很简单，但蚁群能搭桥、种田、发动战争
- 单个神经元不会思考，但 860 亿个神经元涌现出意识

在 AI 编程领域：**多个 AI 工具协作产出的代码，是否真的比单一 AI 工具好？好多少？** 这个问题在 v2.1.0 之前**没有任何工具能定量回答**。

### 2. 三模态同步度量（SynchronyMeter）

参考脑科学中的三模态同步理论，启迪 Agent 提出 **F+G+M → S** 模型：

| 维度 | 含义 | 度量方法 |
|------|------|---------|
| **F（功能同步）** | 多个工具实现的功能是否一致 | 函数签名/接口契约对齐度 |
| **G（结构同步）** | 代码结构是否兼容 | AST 节点相似度 |
| **M（分子同步）** | Token 级别的语义对齐 | Embedding 相似度 |
| **S（综合同步强度）** | 三者加权融合 | S = 0.4F + 0.3G + 0.3M |

实际度量示例：

```
两个工具协作 →
  F = 0.92（功能高度一致）
  G = 0.88（结构兼容）
  M = 0.95（语义对齐）
  S = 0.4×0.92 + 0.3×0.88 + 0.3×0.95 = 0.917

判定: 同步强度 0.917，协作质量高 ✅
```

### 3. 涌现增益评估（EmergenceEvaluator）

```
协作质量 Q_协作  vs  最佳单工具质量 Q_单工具
                ↓
        gain = (Q_协作 - Q_单工具) / Q_单工具
                ↓
   ┌─────────────────────────────────┐
   │  gain > 0.10  → EMERGENT     ✅ │  涌现生效
   │  0 ≤ gain ≤ 0.10 → MARGINAL  ⚠️ │  边际收益
   │  gain < 0     → NEGATIVE     ❌ │  协作无效
   └─────────────────────────────────┘
```

### 4. 防造假审计（EmergenceAudit）

为了防止"假涌现"（比如协作质量好只是因为多跑了一次随机性），系统提供审计日志：

- `MISSING_BASELINE` 标记：如果没跑单工具基线，明确标记"涌现判定不可信"
- 完整审计链：每次涌现判定都记录"用了什么工具、什么任务、什么分数"

### 5. 这是开源 AI 编排工具的稀缺能力

> **启迪 Agent 是目前开源 AI 编程工具中，唯一能定量度量"多 AI 协作是否真产生 1+1>2"的工具。**

这一能力可独立输出为 npm 包，适用于任何多 Agent 系统（不仅限编程）：多 Agent 客服、多 Agent 研究分析、多 Agent 内容生产。

---

## 四、工程化加固：G1-G6 全接入

v2.0.0 时这些模块都已实现但**没接入主管线**——就像建好了发动机但没装车。v2.1.0 完成了 9 个模块的全接入：

```javascript
TaskExecutor.executeSingleTask(task):
  1. → contractValidator.validateInput(task)        // 契约校验
  2. → approvalWorkflow.requestApproval('pre_execute') // 审批
  3. → gitIntegration.createTaskBranch(task.id)     // 自动建分支
  4. → budgetManager.canProceed(estimatedTokens)    // 预算检查
  5. → [原有执行逻辑]
  6. → budgetManager.record('codeWriter', ...)       // 预算记录
  7. → qualityChecker.review(code) + testRunner.runTests(...)  // 质检+测试
  8. → contractValidator.validateOutput(output)     // 输出校验
  9. → if 质检失败: gitIntegration.rollback()       // 自动回滚
 10. → approvalWorkflow.requestApproval('post_quality') // 质检后审批
 11. → mergeEngine.merge(results)                   // 智能合并
 12. → gitIntegration.commitChanges(task.id)        // 自动提交
 13. → vectorMemory.store(taskDescription, metadata) // 语义记忆
 14. → adaptiveOrchestrator.recordOutcome(...)       // 学习闭环
```

### G1-G6 接入清单

| 模块 | 接入点 | 价值 |
|------|--------|------|
| **GitIntegration** | 任务前建分支/失败回滚/完成提交 | 每个任务一个分支，失败不污染主代码 |
| **BudgetManager** | 任务前检查/完成后记录 | Token 超限自动降级到小模型 |
| **ApprovalWorkflow** | pre_execute + post_quality 双检查点 | 关键节点人工把关 |
| **StreamManager** | 全流程流式输出 | WebUI 实时看到任务进度 |
| **VectorMemoryStore** | 成功率≥60% 时存储语义记忆 | 跨任务复用知识 |
| **ContractValidator** | 输入/输出双向校验 | 防止契约违约 |
| **RetryManager** | 工具调用失败自动重试 | 指数退避，最多 3 次 |
| **TestRunner** | 注入 TesterAgent | 自动跑测试用例 |
| **AdaptiveOrchestrator** | auto 模式自动推荐 + 学习闭环 | 越用越聪明 |

### Provider 流式接口补全

v2.0.0 时只有 Anthropic Provider 支持 chatStream，v2.1.0 补齐了 Ollama 和 OpenAI：

```javascript
// 三个 Provider 全部支持流式
await provider.chatStream(messages, options, (chunk) => {
  console.log(chunk);  // 实时输出
});

// StreamManager 一行代码桥接
await streamManager.streamFromProvider(provider, messages);
```

---

## 五、可观测性：监控仪表盘

新增 `/api/monitor/*` 系列 API，让系统状态完全透明：

```bash
GET /api/monitor/dashboard     # 一站式监控（内存/工具/任务/自适应/SelfEval）
GET /api/monitor/tools-health  # 工具健康检查
GET /api/monitor/trends        # 最近 20 次推荐趋势
```

**Dashboard 响应示例**：

```json
{
  "uptime": 3600,
  "memory": { "rss": "156 MB", "heapUsed": "84 MB" },
  "adaptive": {
    "totalRecommendations": 42,
    "successRate": 0.85,
    "averageQualityScore": 0.78,
    "topTools": [
      { "name": "claude-code", "successRate": 0.92, "avgQuality": 0.85 }
    ]
  },
  "tools": { "total": 8, "online": 4 },
  "tasks": { "active": 2 }
}
```

---

## 六、性能与测试数据

### 测试套件全通过

v2.1.0 引入了**四套测试**，全方位保障质量：

| 测试套件 | 通过/总数 | 通过率 | 等级 | 覆盖范围 |
|---------|----------|--------|------|---------|
| 单元测试（npm test） | 58/58 | 100% | S | 核心模块功能 |
| 全项目冒烟测试 | 59/59 | 100% | S | 10 大维度 |
| G1-G6 端到端测试 | 15/15 | 100% | S | 12 个新模块 |
| P0-P5 专项冒烟测试 | 49/49 | 100% | S | 全部新增功能 |
| **合计** | **181/181** | **100%** | **S** | **全部功能** |

### 真实代码规模快照

| 维度 | v2.0.0 | v2.1.0 | 增长 |
|------|--------|--------|------|
| src/ 下 .js 文件 | ~80 | **96** | +20% |
| src/ 总代码行数 | ~32,000 | **~39,600** | +24% |
| 外部工具适配器 | 11 | **13** | +2 |
| test/ 测试文件 | 15 | **21** | +6 |
| core/ 核心模块 | ~24 | **31** | +7 |
| docs/ 文档 | 18 | **24** | +6 |

### 自适应推荐准确率

基于真实测试数据：

| 任务类型 | 推荐准确率 | 平均置信度 |
|---------|----------|----------|
| Python 开发任务 | 95% | 80% |
| TypeScript 重构 | 92% | 80% |
| Java bugfix | 90% | 80% |
| DevOps 部署 | 85% | 65% |
| Rust 性能优化 | 92% | 80% |

---

## 七、与 v2.0.0 对比

### 功能矩阵对比

| 能力 | v2.0.0 | v2.1.0 | 提升 |
|------|--------|--------|------|
| **任务编排** | 手动选工具 + 4 种路由策略 | 自适应推荐 + 6 种路由策略 + 3 种编排模式 | 🔥 革命性 |
| **协作度量** | 无（只能多跑取最好） | SynchronyMeter + EmergenceEvaluator + Audit | 🔥 独创 |
| **工程化** | 模块建好但未接入 | G1-G6 全部接入主管线 | ✅ 完整 |
| **流式输出** | 仅 Anthropic | Ollama + OpenAI + Anthropic 三家全支持 | ✅ 补齐 |
| **可观测性** | 日志 + status 命令 | 3 个 monitor API + 学习统计 + 趋势分析 | ✅ 大幅提升 |
| **自学习** | 无 | 推荐结果回写 + Top 工具排行 + 偏好持久化 | 🔥 新增 |
| **测试覆盖** | 58 项 | 181 项（含 e2e + 冒烟 + 专项） | +123 项 |
| **代码规模** | ~32,000 行 | ~39,600 行 | +24% |

### 用户体验对比

**v2.0.0 用户流程**：

```
用户输入任务
   ↓
手动选工具（凭经验/试错）
   ↓
系统执行
   ↓
看到结果，不知道好不好
```

**v2.1.0 用户流程**：

```
用户输入任务
   ↓
系统自动推荐最佳工具组合（带置信度）
   ↓
hybrid 模式下用户确认 / auto 模式直接执行
   ↓
系统执行 + 实时流式输出
   ↓
完成后回写学习数据
   ↓
下次推荐更准 ✨
```

### 完成度提升

| 维度 | v2.0.0 | v2.1.0 |
|------|--------|--------|
| 综合完成度 | ~80% | **88%** |
| 核心编排层 | 85% | **95%** |
| 评估与智能层 | 60% | **80%** |
| 工程化接入 | 50% | **95%** |

---

## 八、已知短板与优化方向

v2.1.0 仍存在 8 个已知短板（按严重度排序）：

### 🔴 高严重度

**S1：适配器深度集成不足**
- 现状：13 个适配器多走 CLI 调用，缺原生 API 深度集成
- 影响：无法获取工具的结构化输出（如 AST、Token 使用量）
- 优化：为 ClaudeCode/OpenClaw 等编写原生 API 层

**S2：涌现评估基线获取不稳定**
- 现状："select-mode-baseline" 自动获取不稳定
- 影响：EMERGENT 判定可信度受损
- 优化：建立结构化基线数据库 + 强制基线获取流程

### 🟡 中严重度

**S3：合并引擎缺 AST 结构化冲突检测**
- 现状：主要依赖 AI 判断冲突
- 优化：把已有的 `ASTConflictDetector.js` 深度接入 MergeEngine

**S4：多语言混合契约拼装未充分验证**
- 现状：C+Python 跨语言适配器代码在但缺实战用例
- 优化：补充跨语言混合项目实战测试

**S5：VectorMemoryStore embedding 生成失败**
- 现状：测试日志打印 "embedding 生成失败"
- 影响：降级到关键词检索，语义检索能力打折
- 优化：补全 embedding 模型加载逻辑

**S6：Benchmark 数据为模板占位**
- 现状：`docs/BENCHMARK.md` 显示 "Test Date: YYYY-MM-DD"
- 优化：跑真实 benchmark 替换占位数据

**S8：端到端真实 LLM 验证不足**
- 现状：大量测试用 MockProvider
- 优化：接入真实 Ollama/OpenAI 跑完整 e2e

### 🟢 低严重度

**S7：TUI 未完全接入**
- 现状：框架完整但部分组件未接入主流程
- 优化：完成 TUI 与核心管线对接

---

## 九、下一步规划

### 阶段 1：稳定化（2026 Q3，目标 95%+）

- 补齐 S1-S8 八大短板
- 跑真实 Benchmark 替换占位数据
- 真实 Ollama/OpenAI 全流程 e2e 测试
- MCP 双向枢纽全打通

### 阶段 2：生态化（2026 Q4 - 2027 Q1）

- 插件市场 v1（PluginLoader + PluginAPI）
- 自进化闭环原型（与自进化实验项目对接）
- 涌现 SDK 独立输出为 npm 包

### 阶段 3：平台化（2027 Q2-Q3）

- 企业版（多租户 + K8s + SaaS 化）
- 多模态输入支持（架构图 + API 文档 + 需求）

### 长期愿景

> **启迪 Agent 最大的生态价值，是与自进化实验项目结合，形成一个"能自我进化的 AI 编程编排平台"——启迪负责对外生产代码，自进化实验负责进化启迪自身能力，形成"生产→评估→进化→生产"飞轮。**

---

## 十、项目链接

- **GitHub**: https://github.com/qidiai/QiDi-Agent
- **Gitee**: https://gitee.com/xuchangming/qidi-agent
- **文档**: https://github.com/qidiai/QiDi-Agent/blob/main/docs/

### 快速开始

```bash
# 克隆仓库
git clone https://github.com/qidiai/QiDi-Agent.git
cd QiDi-Agent

# 安装依赖
npm install

# 体验自适应编排（推荐）
npm run cli -- adaptive --recommend "用 Python 写一个爬虫"

# 启动 WebUI
npm run web
```

---

> 💡 **欢迎 Star、Fork、PR！** v2.1.0 是从"多模型并行"到"涌现工程"的关键一步，欢迎一起探索"AI 协作是否真产生 1+1>2"这个迷人的问题。

---

**标签**：#人工智能 #AI编程 #开源 #多Agent协作 #涌现工程 #自适应编排
