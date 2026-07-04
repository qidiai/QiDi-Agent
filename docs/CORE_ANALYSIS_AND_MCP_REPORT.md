# Qidi Agent — 核心功能分析与 MCP 服务实现报告

> 分析日期: 2026-07-03
> 项目版本: 2.0.0

---

## 一、项目概览

**Qidi Agent** 是一个 AI 编程编排引擎，核心理念是：**将复杂任务自动拆分，派发给多个免费 AI 编程工具并行执行，再通过 AI 质检和智能合并，产出可媲美顶级 LLM 的高质量代码——而无需支付昂贵 API 费用。**

### 核心价值主张

| 维度 | 描述 |
|------|------|
| **零成本** | 利用免费模型（Ollama 本地 + 免费云端额度）编排 |
| **隐私保护** | 隐私模式下，敏感代码永不出本地 |
| **多工具协同** | 12+ 外部编程工具适配器，自动扫描接入 |
| **质量保证** | 三层质检（编译+静态分析+AI评分）+ 智能合并 |

---

## 二、核心功能实现状态评估

### 2.1 已完成功能（✅ 生产可用）

| # | 功能模块 | 实现文件 | 完成度 | 说明 |
|---|---------|---------|--------|------|
| 1 | **任务拆分** | `TaskSplitterAgent.js` | ✅ 100% | AI 自动拆分为 3-20 个子任务，标注依赖关系、角色、复杂度 |
| 2 | **任务路由** | `TaskRouter.js` | ✅ 100% | 6 种路由策略：轮询、能力匹配、TopN、手动、广播、同步驱动 |
| 3 | **多工具并行派发** | `MultiAgentDispatcher.js` | ✅ 100% | 7 种模式：parallel/sequential/select/cascade/merge/privacy/quality |
| 4 | **工具自动扫描** | `ToolScanner.js` | ✅ 100% | 自动检测本机已安装的 AI 编程工具 |
| 5 | **三层质检** | `QualityCheckerAgent.js` | ✅ 100% | 编译检查 + 静态分析 + AI 评分 |
| 6 | **AI 智能合并** | `MergeEngine.js` | ✅ 100% | 多路代码合并，冲突解决，质量评估 |
| 7 | **契约拼装** | `ContractAssembler.js` | ✅ 100% | 7 种语言的契约提取、验证、拼装 |
| 8 | **执行模式管理** | `ExecutionModeManager.js` | ✅ 100% | 4 种模式：privacy/quality/efficiency/multi |
| 9 | **Web 管理界面** | `WebUIServer.js` | ✅ 100% | 40+ API 端点，8 个功能页面 |
| 10 | **实验报告系统** | `ExperimentReportGenerator.js` | ✅ 100% | 自动生成报告，支持搜索、历史上下文 |
| 11 | **CLI 工具** | `cli/index.js` | ✅ 100% | 15+ 命令，完整的交互式体验 |
| 12 | **多 Provider 支持** | `providers/` | ✅ 100% | Ollama/OpenAI/DeepSeek/Anthropic |
| 13 | **工具适配器** | `adapters/` | ✅ 100% | 12 个适配器：Claude Code/OpenClaw/AtomCode/Qoder 等 |
| 14 | **Checkpoint 断点续传** | `TaskScheduler.js` | ✅ 100% | 暂停/恢复/checkpoint 保存与恢复 |
| 15 | **缓存与压缩** | `CacheStore.js` / `ContextCompressor.js` | ✅ 100% | 任务缓存 + 上下文压缩 |
| 16 | **工具学习** | `ToolLearning.js` | ✅ 100% | 基于历史执行记录的工具推荐 |
| 17 | **熔断器** | `TaskRouter.js` | ✅ 100% | 工具熔断保护，自动恢复探测 |
| 18 | **MCP 协议支持** | `mcp/MCPServer.js` | ✅ 100% | **本次新增** — 8 个工具 + 4 个资源 + 3 个提示模板 |

### 2.2 未完成功能（❌ 待实现）

| # | 功能 | 优先级 | 实现方案建议 |
|---|------|--------|-------------|
| 1 | **递归拆分** | 中 | 在 `TaskSplitterAgent` 中增加递归逻辑：当子任务复杂度 > high 时，对子任务再次拆分 |
| 2 | **流式输出 + WebSocket** | 高 | 在 `WebUIServer` 中增加 WebSocket 端点，`TaskOrchestrator` 的事件流式推送 |
| 3 | **插件系统** | 中 | 定义插件接口（hook 机制），支持在拆分/执行/质检/合并各阶段注入自定义逻辑 |
| 4 | **团队协作版** | 低 | 增加多用户管理、共享工作空间、任务分配与权限控制 |

### 2.3 核心架构流程图

```
用户输入任务
     │
     ▼
┌─────────────────────┐
│  TaskSplitterAgent  │  ← AI 拆分为 3-20 个子任务
│  (本地/云端)         │
└──────────┬──────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
┌─────────┐ ┌─────────┐ ┌─────────┐
│ 工具 A   │ │ 工具 B   │ │ 工具 C   │  ← TaskRouter 路由分发
│ (碎片)   │ │ (碎片)   │ │ (碎片)   │
└────┬────┘ └────┬────┘ └────┬────┘
     └─────┬─────┘
           ▼
┌─────────────────────┐
│ QualityCheckerAgent │  ← 三层质检
│ (编译+静态+AI评分)    │
└──────────┬──────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
┌──────────────┐  ┌──────────────────┐
│ MergeEngine  │  │ ContractAssembler │  ← 智能合并 / 契约拼装
│ (AI 合并)     │  │ (隐私模式)        │
└──────┬───────┘  └────────┬─────────┘
       └────────┬──────────┘
                ▼
        高质量完整代码
```

---

## 三、MCP 服务实现详情

### 3.1 什么是 MCP

**MCP (Model Context Protocol)** 是 Anthropic 于 2024 年 11 月推出的开放标准，旨在统一大型语言模型（LLM）与外部数据源和工具之间的通信协议。MCP 使用 **JSON-RPC 2.0** 作为通信格式，支持 **stdio** 和 **HTTP/SSE** 两种传输方式。

### 3.2 实现架构

```
MCP 客户端 (Claude Desktop / Cursor / VS Code)
         │
    stdio (JSON-RPC 2.0)
         │
         ▼
┌─────────────────────────┐
│   MCPServer.js          │
│   (src/mcp/MCPServer.js)│
├─────────────────────────┤
│  Tools (8个)            │
│  ├─ run_task            │ → TaskOrchestrator
│  ├─ scan_tools          │ → ToolScanner
│  ├─ list_agents         │ → MultiAgentDispatcher
│  ├─ list_modes          │ → ExecutionModeManager
│  ├─ recommend_mode      │ → ExecutionModeManager
│  ├─ list_reports        │ → ExperimentReportGenerator
│  ├─ get_report          │ → ExperimentReportGenerator
│  └─ get_health          │ → ToolHealthChecker
│                         │
│  Resources (4个)        │
│  ├─ qidi://config       │ → config/agents.json
│  ├─ qidi://modes        │ → ExecutionModeManager
│  ├─ qidi://reports      │ → ReportGenerator
│  └─ qidi://tools        │ → ToolScanner
│                         │
│  Prompts (3个)          │
│  ├─ task_split          │ → 任务拆分模板
│  ├─ code_review         │ → 代码审查模板
│  └─ multi_tool_dispatch │ → 多工具派发模板
└─────────────────────────┘
```

### 3.3 暴露的 MCP 工具

| 工具名 | 功能 | 核心参数 |
|--------|------|---------|
| `run_task` | 执行代码任务（拆分→派发→质检→合并） | `task`(必填), `mode`, `provider`, `workspace` |
| `scan_tools` | 扫描本机 AI 编程工具 | `connect`(是否自动连接) |
| `list_agents` | 列出所有 Agent 及状态 | 无 |
| `list_modes` | 列出所有执行模式 | 无 |
| `recommend_mode` | 智能推荐执行模式 | `task`(必填) |
| `list_reports` | 列出实验报告 | `count` |
| `get_report` | 获取报告详情 | `id`(必填) |
| `get_health` | 系统健康状态 | 无 |

### 3.4 启动方式

```bash
# 方式 1：通过 CLI 命令
qidi mcp

# 方式 2：直接运行
node src/mcp/index.js

# 方式 3：自定义参数
qidi mcp -m privacy -p ollama -w ./workspace
```

### 3.5 客户端配置示例

#### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "qidi-agent": {
      "command": "node",
      "args": ["C:/path/to/ai-orchestrator/src/mcp/index.js"],
      "env": {
        "MODEL_PROVIDER": "ollama",
        "OLLAMA_MODEL": "qwen2.5:7b"
      }
    }
  }
}
```

#### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "qidi-agent": {
      "command": "node",
      "args": ["./src/mcp/index.js"],
      "env": {
        "MODEL_PROVIDER": "ollama"
      }
    }
  }
}
```

### 3.6 测试验证结果

```
✅ Initialize 握手成功!
   Server: qidi-agent-mcp v1.0.0
   Protocol: 2024-11-05

✅ tools/list 响应成功!
   工具数量: 8

✅ resources/list 成功!
   资源数量: 4

✅ prompts/list 成功!
   提示模板数量: 3

✅ prompts/get (task_split) 成功!
✅ resources/read (qidi://modes) 成功!
```

---

## 四、核心功能实现路径指南

### 4.1 要让核心功能完整运行，需要以下条件

#### 必需条件

1. **安装 Node.js >= 16**
2. **安装 Ollama 并拉取模型**
   ```bash
   # 安装 Ollama: https://ollama.com
   ollama pull qwen2.5:7b    # 拆分/质检模型
   ollama pull qwen2.5:3b    # 小模型（可选，用于简单任务）
   ```
3. **安装项目依赖**
   ```bash
   npm install
   ```
4. **配置环境变量** (`.env`)
   ```
   MODEL_PROVIDER=ollama
   OLLAMA_MODEL=qwen2.5:7b
   OLLAMA_MODEL_SMALL=qwen2.5:3b
   # 可选：云端 API（高质量模式）
   # OPENAI_API_KEY=sk-xxx
   # DEEPSEEK_API_KEY=sk-xxx
   # ANTHROPIC_API_KEY=sk-ant-xxx
   ```

#### 可选条件（增强功能）

5. **安装外部 AI 编程工具**（任选）
   - Claude Code、OpenClaw、AtomCode、Qoder 等
   - 运行 `qidi scan` 自动检测
6. **配置 `config/agents.json`**
   - 启用/禁用特定 Agent
   - 配置模型参数

### 4.2 核心功能运行流程

```bash
# 1. 扫描工具
qidi scan --connect

# 2. 隐私模式执行（零成本，本地完成）
qidi run "写一个贪吃蛇游戏" -m privacy

# 3. 高质量模式（云端 AI 参与）
qidi run "实现一个 REST API" -m quality -p deepseek

# 4. 多 Agent 并行
qidi multi "构建一个全栈应用" -m parallel

# 5. Web 管理界面
qidi web

# 6. MCP 服务器（接入 AI 客户端）
qidi mcp
```

### 4.3 扩展开发指南

#### 添加新的工具适配器

```javascript
// 1. 创建 src/adapters/MyToolAdapter.js
const BaseToolAdapter = require('./BaseToolAdapter');
class MyToolAdapter extends BaseToolAdapter {
  constructor() {
    super({ name: 'my-tool', displayName: 'My Tool', command: 'mytool' });
  }
  async detect() { /* 检测工具是否安装 */ }
  async connect() { /* 连接工具 */ }
  async _runToolCommand(task, options) { /* 执行任务 */ }
}

// 2. 在 src/adapters/index.js 中注册
```

#### 添加新的 LLM Provider

```javascript
// 1. 创建 src/providers/MyProvider.js
// 2. 在 src/providers/index.js 的 switch 中添加 case
// 3. 在 config/agents.json 中配置
```

---

## 五、文件结构

```
src/
├── mcp/                    ← MCP 服务（本次新增）
│   ├── MCPServer.js        MCP 服务器核心实现
│   ├── index.js            MCP 入口文件
│   ├── test_mcp.js         基础测试脚本
│   └── test_mcp_full.js    完整测试脚本
├── core/                   核心编排
│   ├── TaskOrchestrator.js   任务编排器（门面）
│   ├── TaskRouter.js         任务路由引擎
│   ├── TaskExecutor.js       任务执行器
│   ├── TaskScheduler.js      任务调度器
│   ├── ContractAssembler.js  契约拼装引擎
│   ├── ExecutionModeManager.js 执行模式管理
│   ├── MultiAgentDispatcher.js 多 Agent 分派
│   ├── ToolScanner.js        工具扫描器
│   └── WebUIServer.js        Web UI 服务器
├── agents/                 AI Agent
│   ├── TaskSplitterAgent.js  任务拆分
│   ├── CodeWriterAgent.js    代码编写
│   ├── QualityCheckerAgent.js 质量检查
│   └── MergeEngine.js        合并引擎
├── adapters/               工具适配器（12个）
├── providers/              LLM 提供商（4个）
├── cli/                    命令行
└── utils/                  工具类
```

---

## 六、结论

Qidi Agent 的核心功能已基本完整实现，覆盖了从任务拆分到代码合并的完整生命周期。本次新增的 MCP 服务支持使其能够无缝接入 Claude Desktop、Cursor 等 AI 客户端，大大扩展了使用场景。

**核心优势：**
- 零成本编排（Ollama 本地 + 免费云端）
- 隐私保护（碎片化分发 + 本地拼装）
- 多工具协同（12 个适配器 + 6 种路由策略）
- 质量保证（三层质检 + AI 合并）

**后续建议：**
1. 优先实现流式输出 + WebSocket（提升用户体验）
2. 增加递归拆分（支持更复杂的任务）
3. 完善 MCP 服务的 HTTP/SSE 传输模式（支持远程部署）
