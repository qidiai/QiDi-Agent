# Qidi Agent 达成 99% 完成度路线图 & 后期发展方向

> 生成时间: 2026-07-04
> 当前完成度: 93.5%
> 目标完成度: 99%
> 文档性质: 99%达成路线图 + 长期发展方向

---

## 一、核心发现：93.5% → 99% 的 6 大差距

经过对全部源码的深度审计，识别出以下 **6 大差距** 是阻碍达到 99% 的关键：

### 差距总览

| # | 差距名称 | 影响范围 | 当前状态 | 99%目标 | 工作量 |
|---|---------|---------|---------|---------|--------|
| G1 | **P0-P3 模块未接入主管线** | 全局 | 模块已创建，但 TaskOrchestrator/TaskExecutor 未调用 | 主管线中实际使用所有模块 | 2天 |
| G2 | **Provider 流式接口缺失** | 流式输出 | Ollama/OpenAI 无 chatStream，仅 Anthropic 有 | 3 个 Provider 全部实现 chatStream | 1天 |
| G3 | **WebUI 未集成新模块** | WebUI | WebUIServer 未接入 SSE/审批/预算/Git | WebUI 全功能集成 | 2天 |
| G4 | **CLI 未暴露新功能** | CLI | 无 test/budget/git/sandbox 子命令 | 完整 CLI 命令体系 | 1天 |
| G5 | **端到端测试覆盖为零** | 质量 | 新增 12 个模块无测试 | 每个模块至少 3 个测试用例 | 2天 |
| G6 | **配置体系统一化** | 运维 | 新模块配置分散，无统一入口 | 统一 enhanced_modules.json | 0.5天 |

---

## 二、G1: P0-P3 模块接入主管线 (最关键)

### 问题

`TaskOrchestrator` 和 `TaskExecutor` 是核心管线，但当前代码中 **完全没有引用** 任何 P0-P3 新模块：

```
// TaskOrchestrator.js 中搜索 testRunner/budgetManager/gitIntegration 等 → 0 匹配
// TaskExecutor.js 中搜索 testRunner/budgetManager/gitIntegration 等 → 0 匹配
```

TUISession 虽然将模块传给了 TaskOrchestrator 的 options，但 TaskOrchestrator 构造函数中并未读取和使用。

### 需要做的接入点

| 接入点 | 文件 | 接入模块 | 接入方式 |
|--------|------|---------|---------|
| 构造函数接收 | `TaskOrchestrator.js` | 全部模块 | `this.testRunner = options.testRunner` 等 |
| 任务执行前 | `TaskExecutor.js` | GitIntegration | `git.createTaskBranch(taskId)` |
| 任务执行前 | `TaskExecutor.js` | ContractValidator | `validator.validateInput(task, context)` |
| 任务执行前 | `TaskExecutor.js` | ApprovalWorkflow | `await approval.requestApproval('pre_execute', ...)` |
| 代码生成后 | `TaskExecutor.js` | BudgetManager | `budget.record('codeWriter', agent, model, input, output)` |
| 代码生成后 | `TaskExecutor.js` | StreamManager | `stream.push({ text, agent })` |
| 质检后 | `TaskExecutor.js` | TestRunner | `await testRunner.runTests(...)` |
| 质检后 | `TaskExecutor.js` | ApprovalWorkflow | `await approval.requestApproval('post_quality', ...)` |
| 质检失败 | `TaskExecutor.js` | GitIntegration | `git.rollback(savepoint)` |
| 合并前 | `TaskExecutor.js` | ContractValidator | `validator.validateOutput(output, contract)` |
| 合并前 | `TaskExecutor.js` | ApprovalWorkflow | `await approval.requestApproval('pre_merge', ...)` |
| 合并后 | `TaskExecutor.js` | GitIntegration | `git.commitChanges(taskId)` |
| 合并后 | `TaskExecutor.js` | VectorMemoryStore | `await vectorMemory.store(text, metadata)` |
| 全程 | `TaskExecutor.js` | RetryManager | 包装 `executeSingleTask` 为 retry.execute() |
| 全程 | `TaskExecutor.js` | SandboxExecutor | 工具执行时使用沙箱 |
| 全程 | `TaskExecutor.js` | BudgetManager | `budget.canProceed()` 检查 + `shouldDegrade()` 降级 |

### 实现方案

```
TaskOrchestrator 构造函数:
  this.testRunner = options.testRunner || null
  this.budgetManager = options.budgetManager || null
  this.gitIntegration = options.gitIntegration || null
  this.sandboxExecutor = options.sandboxExecutor || null
  this.approvalWorkflow = options.approvalWorkflow || null
  this.streamManager = options.streamManager || null
  this.vectorMemory = options.vectorMemory || null
  this.contractValidator = options.contractValidator || null
  this.retryManager = options.retryManager || null

TaskExecutor.executeSingleTask(task, context):
  1. → contractValidator.validateInput(task, context)
  2. → approvalWorkflow.requestApproval('pre_execute', ...)
  3. → gitIntegration.createTaskBranch(task.id)
  4. → budgetManager.canProceed(estimatedTokens)
  5. → [缓存检查 → 上下文构建 → 路由 → 工具执行]  (原有逻辑)
  6. → budgetManager.record('codeWriter', ...)
  7. → qualityChecker.review(code) + testRunner.runTests(...)
  8. → contractValidator.validateOutput(output, contract)
  9. → if 质检失败: gitIntegration.rollback()
 10. → approvalWorkflow.requestApproval('post_quality', ...)
 11. → mergeEngine.merge(results)
 12. → gitIntegration.commitChanges(task.id)
 13. → vectorMemory.store(taskDescription, { qualityScore, language, ... })
 14. → approvalWorkflow.requestApproval('post_merge', ...)
```

---

## 三、G2: Provider 流式接口补全

### 问题

| Provider | chat() | chatStream() | 状态 |
|----------|--------|-------------|------|
| OllamaProvider | ✅ | ❌ | 缺失 |
| OpenAIProvider | ✅ | ❌ | 缺失 |
| AnthropicProvider | ✅ | ✅ | 已实现 |

P1-2 的 StreamManager 依赖 `provider.chatStream`，但只有 Anthropic 实现了。BaseAgent 中的流式分支永远不会被 Ollama/OpenAI 触发。

### 需要实现

1. **OllamaProvider.chatStream()**: 使用 Ollama API 的 `stream: true` 参数，解析 NDJSON 流
2. **OpenAIProvider.chatStream()**: 使用 OpenAI API 的 SSE `stream: true`
3. **BaseProvider**: 添加 `chatStream()` 抽象方法 + 默认降级实现（调用 chat 后分块推送）

---

## 四、G3: WebUI 集成新模块

### 问题

`WebUIServer.js` 中搜索 testRunner/budgetManager/approvalWorkflow/SSE 等 → 0 匹配。WebUI 完全没有利用 P0-P3 新模块。

### 需要实现

| 功能 | API 路由 | 模块 |
|------|---------|------|
| 实时流式输出 | `GET /api/tasks/:id/stream` (SSE) | StreamManager |
| 预算仪表盘 | `GET /api/budget` | BudgetManager |
| 审批列表 | `GET /api/approvals` | ApprovalWorkflow |
| 审批操作 | `POST /api/approvals/:id/approve` | ApprovalWorkflow |
| Git 状态 | `GET /api/git/status` | GitIntegration |
| Git 回滚 | `POST /api/git/rollback` | GitIntegration |
| 测试运行 | `POST /api/tests/run` | TestRunner |
| 测试结果 | `GET /api/tests/:id/result` | TestRunner |
| 语义搜索 | `POST /api/memory/search` | VectorMemoryStore |
| MCP 状态 | `GET /api/mcp/servers` | MCPClient |
| 沙箱状态 | `GET /api/sandbox/status` | SandboxExecutor |
| 契约验证 | `POST /api/contract/validate` | ContractValidator |

---

## 五、G4: CLI 命令体系扩展

### 问题

当前 CLI 只有 `run`, `scan`, `report`, `tui`, `chat` 等命令，新模块无 CLI 入口。

### 需要新增的命令

```bash
qidi test <file>           # 运行测试
qidi test --framework pytest --language python
qidi budget                # 查看预算报告
qidi budget --reset        # 重置预算
qidi git status            # Git 状态
qidi git rollback [hash]   # 回滚
qidi git diff              # 查看 diff
qidi sandbox exec <cmd>    # 在沙箱中执行命令
qidi sandbox code <file>   # 在沙箱中执行代码
qidi approval list         # 待审批列表
qidi approval approve <id> # 批准
qidi approval reject <id>  # 拒绝
qidi memory search <query> # 语义搜索
qidi memory stats          # 记忆统计
qidi mcp list              # MCP 服务器列表
qidi mcp connect <name>    # 连接 MCP 服务器
qidi contract validate <file>  # 契约验证
```

---

## 六、G5: 端到端测试

### 问题

新增 12 个模块没有任何测试覆盖，存在回归风险。

### 需要实现的测试

| 测试文件 | 测试模块 | 测试用例数 |
|---------|---------|-----------|
| `test/unit/test_test_runner.js` | TestRunner | 5 (框架检测/pytest执行/JS执行/集成测试/清理) |
| `test/unit/test_mcp_client.js` | MCPClient | 3 (配置加载/工具发现/适配器包装) |
| `test/unit/test_vector_memory.js` | VectorMemoryStore | 4 (存储/搜索/过滤/降级) |
| `test/unit/test_budget_manager.js` | BudgetManager | 4 (记录/阈值/降级/报告) |
| `test/unit/test_retry_manager.js` | RetryManager | 4 (错误分类/延迟计算/参数调整/重试循环) |
| `test/unit/test_git_integration.js` | GitIntegration | 3 (分支/提交/回滚) |
| `test/unit/test_sandbox_executor.js` | SandboxExecutor | 3 (进程执行/安全验证/代码执行) |
| `test/unit/test_approval_workflow.js` | ApprovalWorkflow | 3 (审批请求/批准/拒绝) |
| `test/unit/test_distributed_executor.js` | DistributedExecutor | 2 (本地并行/Master状态) |
| `test/unit/test_contract_validator.js` | ContractValidator | 4 (输入/输出/接口/适配器) |
| `test/integration/test_pipeline_with_enhancements.js` | 管线集成 | 3 (完整流程/质检回滚/预算降级) |
| **合计** | | **38** |

---

## 七、G6: 配置体系统一化

### 问题

新模块的配置散落在各自构造函数中，无统一配置文件。

### 方案

创建 `config/enhanced_modules.json`:

```json
{
  "testRunner": {
    "enabled": true,
    "timeout": 60000,
    "coverageEnabled": true
  },
  "mcpClient": {
    "enabled": true,
    "configPath": "config/mcp_servers.json"
  },
  "vectorMemoryStore": {
    "enabled": true,
    "embeddingModel": "nomic-embed-text",
    "maxItems": 10000
  },
  "budgetManager": {
    "enabled": true,
    "totalBudget": 200000,
    "alarmThreshold": 0.8
  },
  "retryManager": {
    "enabled": true,
    "maxRetries": 3,
    "initialDelay": 1000
  },
  "gitIntegration": {
    "enabled": true,
    "autoCommit": true,
    "autoBranch": true
  },
  "sandboxExecutor": {
    "enabled": true,
    "level": "process"
  },
  "approvalWorkflow": {
    "enabled": true,
    "timeout": 300000,
    "checkpoints": {
      "post_quality": { "enabled": true, "minScore": 60 }
    }
  },
  "distributedExecutor": {
    "enabled": false,
    "mode": "local",
    "maxWorkers": 4
  },
  "contractValidator": {
    "enabled": true,
    "strictMode": false
  }
}
```

---

## 八、99% 达成后的完成度评估

| 层级 | 当前 | G1修复后 | 全部修复后(99%) |
|------|------|---------|----------------|
| 核心管线层 | 96.5% | 99.0% | 99.5% |
| Agent层 | 92.0% | 94.0% | 97.0% |
| 适配器层 | 95.0% | 96.0% | 98.0% |
| 评估与智能层 | 93.0% | 97.0% | 99.0% |
| 生态与工具层 | 88.0% | 95.0% | 98.5% |
| 基础设施层 | 94.0% | 97.0% | 99.0% |
| **综合** | **93.5%** | **96.5%** | **99.0%** |

### 工作量估算

| 差距 | 优先级 | 工作量 | 建议时间 |
|------|--------|--------|---------|
| G1 主管线接入 | P0-紧急 | 2天 | 立即 |
| G2 Provider流式 | P1-高 | 1天 | 立即 |
| G5 端到端测试 | P1-高 | 2天 | 与G1并行 |
| G3 WebUI集成 | P2-中 | 2天 | G1完成后 |
| G4 CLI扩展 | P2-中 | 1天 | G1完成后 |
| G6 配置统一 | P3-低 | 0.5天 | 最后 |
| **合计** | | **~8.5天** | **2周内** |

---

## 九、后期发展方向 (99% → 未来)

### 方向1: 自适应智能编排 (Adaptive Orchestration)

**愿景**: 系统根据任务特征自动选择最优执行策略，而非用户手动指定。

```
任务输入 → 特征分析 → 策略推荐 → 自动执行
              ↓
    ┌─────────────────────┐
    │ 任务复杂度评估       │
    │ 语言/框架检测        │
    │ 历史相似任务检索     │ ← VectorMemoryStore
    │ 工具能力匹配         │ ← ToolLearning
    │ 预算/时间约束        │ ← BudgetManager
    └─────────────────────┘
              ↓
    ┌─────────────────────┐
    │ 策略: 并行 vs 顺序   │
    │ 工具: 哪些工具参与   │
    │ 模型: 大模型 vs 小模型│
    │ 审批: 是否需要人工   │
    └─────────────────────┘
```

**关键模块**:
- `TaskClassifier` (已存在，需增强): 任务分类与复杂度评估
- `StrategyRecommender` (新建): 基于历史数据推荐执行策略
- `AdaptiveRouter` (新建): 动态调整路由策略

### 方向2: 多模态代码理解 (Multi-Modal Code Understanding)

**愿景**: 不仅能生成代码，还能理解架构图、UI 截图、API 文档。

```
输入: [架构图 PNG] + [API 文档 PDF] + [需求描述]
  ↓
多模态解析:
  - 图像 → 架构组件识别
  - PDF → API 端点提取
  - 文本 → 需求理解
  ↓
统一表示 → 代码生成
```

**关键模块**:
- `ImageAnalyzer` (新建): 架构图/UI截图分析
- `DocumentParser` (新建): PDF/Word/Markdown 文档解析
- `UnifiedRepresentation` (新建): 多模态输入统一表示

### 方向3: 持续学习与自我进化 (Continuous Self-Evolution)

**愿景**: 系统从每次执行中学习，持续优化自身能力。

```
执行任务 → 结果评估 → 经验提取 → 知识更新
                          ↓
    ┌─────────────────────────────────┐
    │ 代码模式学习: 哪些模式更可靠     │
    │ 工具偏好学习: 哪个工具擅长什么   │ ← ToolLearning (已存在)
    │ 错误模式学习: 常见错误及修复     │ ← VectorMemoryStore (已存在)
    │ 审查策略学习: 审查重点在哪里     │ ← CodeReviewerAgent (已增强)
    │ 合并策略学习: 什么合并策略最优   │ ← MergeEngine (已存在)
    └─────────────────────────────────┘
                          ↓
    下次执行时自动应用学到的经验
```

**关键模块**:
- `ExperienceExtractor` (新建): 从执行结果中提取可复用经验
- `PatternLibrary` (新建): 代码模式库
- `SelfEvolutionEngine` (新建): 定期自我评估与优化

### 方向4: 插件生态系统 (Plugin Ecosystem)

**愿景**: 第三方开发者可以开发插件扩展系统能力。

```
核心系统 (稳定API)
  ├── 内置适配器 (13个)
  ├── MCP 生态 (消费方) ← MCPClient (已实现)
  ├── 自定义适配器插件
  ├── 自定义 Agent 插件
  ├── 自定义 Provider 插件
  └── 自定义质检规则插件
```

**关键设计**:
- `PluginLoader` (新建): 统一插件加载机制
- `PluginAPI` (新建): 插件开发SDK
- `PluginMarketplace` (新建): 插件仓库与分发

### 方向5: 云原生部署 (Cloud-Native Deployment)

**愿景**: 支持 K8s 部署，弹性扩缩容，多租户隔离。

```
┌───────────────────────────────────┐
│         Kubernetes Cluster         │
│  ┌──────────┐  ┌──────────┐      │
│  │ Master   │  │ Master   │      │
│  │ Pod #1   │  │ Pod #2   │      │
│  └────┬─────┘  └────┬─────┘      │
│       │              │             │
│  ┌────┴──────────────┴─────┐      │
│  │    Worker Pod Pool      │      │
│  │  ┌───┐ ┌───┐ ┌───┐    │      │  ← DistributedExecutor (已实现)
│  │  │W1 │ │W2 │ │W3 │    │      │
│  │  └───┘ └───┘ └───┘    │      │
│  └─────────────────────────┘      │
│  ┌─────────────────────────┐      │
│  │  Shared Storage (PVC)   │      │
│  │  ┌─────┐ ┌──────────┐  │      │
│  │  │Git  │ │Vector DB │  │      │  ← VectorMemoryStore (已实现)
│  │  └─────┘ └──────────┘  │      │
│  └─────────────────────────┘      │
└───────────────────────────────────┘
```

**关键模块**:
- `K8sAdapter` (新建): K8s 部署适配器
- `SharedStorageManager` (新建): 多 Pod 共享存储
- `TenantIsolator` (新建): 多租户隔离

### 方向6: 安全合规增强 (Security & Compliance)

**愿景**: 企业级安全合规，支持代码审计、数据脱敏、访问控制。

```
┌─────────────────────────────┐
│       Security Layer         │
│  ┌─────────────────────┐    │
│  │ 代码脱敏: API Key    │    │
│  │ 敏感数据检测         │    │
│  │ 代码审计日志         │    │  ← SandboxExecutor (已实现)
│  │ 权限控制 (RBAC)      │    │  ← ApprovalWorkflow (已实现)
│  │ 合规检查 (GDPR/等保) │    │
│  └─────────────────────┘    │
└─────────────────────────────┘
```

---

## 十、发展路线图时间线

```
2026 Q3 (7-9月)
├── 99% 达成 (G1-G6, 2周)
├── 自适应智能编排原型 (方向1)
└── 端到端测试覆盖 >80%

2026 Q4 (10-12月)
├── 持续学习与自我进化 (方向3)
├── 插件生态系统 v1 (方向4)
└── Web Dashboard 完善 (G3)

2027 Q1 (1-3月)
├── 多模态代码理解 (方向2)
├── 云原生部署支持 (方向5)
└── 安全合规增强 (方向6)

2027 Q2+ (4月+)
├── 插件市场上线
├── 多租户 SaaS 版本
└── 开源社区生态
```

---

## 十一、结论

### 达成 99% 的关键路径

**最核心的一步是 G1（主管线接入）**——目前 P0-P3 的 12 个模块虽然全部实现，但未接入 `TaskOrchestrator` / `TaskExecutor` 主管线，相当于"建好了发动机但没有装到车上"。完成 G1 后完成度将跃升至 ~96.5%，再完成 G2-G6 即可达 99%。

### 99% ≠ 100% 的原因

剩余的 1% 包含：
- 极端边界情况处理（如 OOM、磁盘满、网络分区）
- 全语言全覆盖（如 Kotlin、Swift、Scala 等小众语言）
- 性能极致优化（向量搜索从 O(n) 到 O(log n)）
- 完善的文档体系（API 文档、架构文档、运维手册）

这些属于"长尾"工作，投入产出比低，建议在 99% 后按需迭代。

### 后期发展的核心思路

> **不是做更多功能，而是让系统更聪明。**

1. 从"用户指定策略" → "系统推荐策略"（自适应编排）
2. 从"单次执行" → "持续学习进化"（自我进化）
3. 从"代码生成" → "多模态理解"（多模态）
4. 从"单体工具" → "插件生态"（插件化）
5. 从"本地运行" → "云原生弹性"（云原生）
