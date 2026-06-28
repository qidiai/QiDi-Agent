# 启迪 Agent (Qidi Agent) - 版本架构与设计文档

## 一、版本概述

| 属性 | 说明 |
|------|------|
| 项目名称 | 启迪 Agent (Qidi Agent) - 多 AI 编程工具统一编排与协作平台 |
| 版本号 | v1.0.0 |
| 状态 | MVP 功能版 |
| 开发日期 | 2026-06-26 |
| 技术栈 | Node.js + JavaScript (ES6+) |

### 项目定位

启迪 Agent 是一个多 AI 编程工具统一编排与协作平台，支持自动扫描和接入本机已安装的 AI 编程工具（Claude Code、OpenCode、OpenClaw、Ollama 等），将复杂代码任务拆解后分派给不同的 AI 工具并行处理，并进行质量对比和结果汇总。

### 核心价值

- **一键接入**：自动扫描本机 AI 工具，开箱即用
- **多工具协作**：同一任务派发给多个 AI 工具，对比结果择优
- **任务编排**：智能拆解复杂任务，按依赖顺序执行
- **质量保障**：自动审核代码质量，不合格自动返工
- **模型兼容**：支持 Ollama 本地模型、OpenAI API 及多种 AI 编程工具
- **节省 Token**：上下文压缩、缓存复用、智能模型选择

---

## 二、架构设计

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                       用户接口层                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │    CLI       │  │    Web UI    │  │     Python API      │  │
│  │ (命令行)     │  │ (可视化)     │  │ (预留)              │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
└─────────┼─────────────────┼──────────────────────┼──────────────┘
          │                 │                      │
          ▼                 ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                       核心编排层                                 │
│                    TaskOrchestrator                             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  任务拆分器 → 任务调度器 → 质量审核 → 进度规划           │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
          │                 │                      │
          ▼                 ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                       智能体层 (Agents)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │TaskSplitter  │  │CodeWriter    │  │CodeReviewer  │          │
│  │(项目经理)     │  │(代码工程师)   │  │(代码审查员)   │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│  ┌──────────────┐  ┌──────────────┐                             │
│  │   Tester     │  │QualityChecker│                             │
│  │(测试工程师)   │  │(质量审核员)   │                             │
│  └──────────────┘  └──────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
          │                 │                      │
          ▼                 ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                       模型提供商层 (Providers)                   │
│  ┌──────────────────────────────┐  ┌──────────────────────────┐ │
│  │       OllamaProvider         │  │      OpenAIProvider      │ │
│  │   (本地模型 / Ollama)        │  │   (云 API / OpenAI)      │ │
│  └──────────────────────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 分层职责

| 层级 | 职责 | 核心文件 |
|------|------|----------|
| 用户接口层 | 接收用户输入，展示结果 | `src/cli/index.js` |
| 核心编排层 | 任务拆分、调度、审核、规划 | `src/core/TaskOrchestrator.js` |
| 智能体层 | 执行具体任务（写代码、审查等） | `src/agents/*.js` |
| 模型提供商层 | 封装 AI 模型调用接口 | `src/providers/*.js` |
| 工具层 | 文件操作、工具函数 | `src/utils/FileManager.js` |

### 2.3 数据流

```
用户输入任务
    │
    ▼
[TaskSplitter] → 生成子任务列表（含角色、依赖、验收标准）
    │
    ▼
[TaskScheduler] → 按依赖顺序调度执行
    │
    ▼
┌─────────────────────────────────────────────────┐
│  循环：选择就绪任务 → 分配 Agent → 执行 → 审核  │
│  - 就绪条件：所有依赖任务已完成                  │
│  - Agent 选择：根据 task.role 分配              │
│  - 质量审核：QualityChecker 评分               │
│  - 返工机制：不达标自动重试（最多2次）           │
└─────────────────────────────────────────────────┘
    │
    ▼
[结果汇总] → 输出成功率、各任务质量评分、输出文件路径
```

---

## 三、设计思路

### 3.1 多智能体协作模式

采用 **角色分工** 模式，每个智能体专注于自己的职责：

| 角色 | 职责 | 提示词策略 | 温度参数 |
|------|------|------------|----------|
| TaskSplitter | 任务拆解 | 结构化输出 JSON | 0.3（严格） |
| CodeWriter | 代码编写 | 代码块输出 | 0.7（创造性） |
| CodeReviewer | 代码审查 | 结构化评分 JSON | 0.2（严格） |
| Tester | 测试设计 | 测试用例 JSON | 0.4（平衡） |
| QualityChecker | 质量审核 | 评分与建议 JSON | 0.3（严格） |

### 3.2 任务依赖管理

子任务之间通过 `dependsOn` 字段建立依赖关系：

```json
{
  "subtasks": [
    {
      "id": "T1",
      "title": "设计数据结构",
      "role": "architect",
      "dependsOn": []
    },
    {
      "id": "T2",
      "title": "实现核心逻辑",
      "role": "code_writer",
      "dependsOn": ["T1"]
    },
    {
      "id": "T3",
      "title": "代码审查",
      "role": "code_reviewer",
      "dependsOn": ["T2"]
    }
  ]
}
```

调度器通过 `_getReadyTasks()` 方法找出所有依赖已完成的就绪任务。

### 3.3 质量保障机制

每个子任务完成后，QualityChecker 进行审核：

1. **评分**：0-100 分
2. **状态判断**：
   - `completed`：通过，继续下一个任务
   - `needs_revision`：需要返工，重新执行当前任务（最多2次）
   - `failed`：失败，记录错误

### 3.4 模型抽象设计

采用 **工厂模式** + **策略模式**：

- **ProviderFactory**：根据配置创建对应的模型提供商
- **BaseProvider**：定义统一接口（`chat`, `generate`, `checkConnection`）
- **OllamaProvider / OpenAIProvider**：实现各自的 API 调用逻辑

### 3.5 代码保存机制

CodeWriter 生成的代码块会自动保存到工作目录：

```
workspace/
└── output/
    ├── T1/
    │   ├── result_1.py
    │   └── result_2.js
    └── T2/
        └── result_1.css
```

---

## 四、已完成功能

### 4.1 功能清单

| 模块 | 功能 | 状态 | 说明 |
|------|------|------|------|
| CLI | `run` 命令 | ✅ 完成 | 运行代码任务 |
| CLI | `check` 命令 | ✅ 完成 | 检查 AI 模型连接 |
| CLI | `list` 命令 | ✅ 完成 | 列出工作目录文件 |
| Providers | OllamaProvider | ✅ 完成 | 支持本地 Ollama |
| Providers | OpenAIProvider | ✅ 完成 | 支持 OpenAI API |
| Providers | ProviderFactory | ✅ 完成 | 工厂模式创建 |
| Agents | TaskSplitter | ✅ 完成 | 任务拆解 |
| Agents | CodeWriter | ✅ 完成 | 代码编写 |
| Agents | CodeReviewer | ✅ 完成 | 代码审查 |
| Agents | Tester | ✅ 完成 | 测试设计 |
| Agents | QualityChecker | ✅ 完成 | 质量审核 |
| Core | TaskOrchestrator | ✅ 完成 | 任务编排核心 |
| Utils | FileManager | ✅ 完成 | 文件读写管理 |
| Config | .env.example | ✅ 完成 | 配置模板 |

### 4.2 未完成功能（待实现）

| 模块 | 功能 | 优先级 |
|------|------|--------|
| Web UI | 可视化看板 | 高 |
| Python | Python 服务端 | 中 |
| Agents | 更多角色（运维、文档） | 中 |
| Git | Git 集成 | 中 |
| Multi-Model | 多模型并行对比 | 低 |

### 4.3 当前完成程度

```
整体进度：████████████░░░░░░░░ 60%

模块进度：
├── CLI 层：██████████████████ 100%
├── Core 层：██████████████████ 100%
├── Agents 层：██████████████████ 100%
├── Providers 层：██████████████████ 100%
├── Utils 层：██████████████████ 100%
├── Web UI 层：░░░░░░░░░░░░░░░░ 0%
└── Python 服务：░░░░░░░░░░░░░░░░ 0%
```

---

## 五、冒烟测试实验结果

### 5.1 测试环境

| 属性 | 值 |
|------|------|
| 操作系统 | Windows 10 (PowerShell 5) |
| Node.js 版本 | v24.14.1 |
| npm 版本 | 10.9.0 |
| 测试时间 | 2026-06-26 19:42:46 |

### 5.2 测试用例

| 序号 | 测试名称 | 状态 | 耗时 |
|------|----------|------|------|
| 01 | 项目结构完整性 | ✅ PASS | 1ms |
| 02 | 模块导入测试 - providers | ✅ PASS | 15ms |
| 03 | 模块导入测试 - agents | ✅ PASS | 5ms |
| 04 | 模块导入测试 - core | ✅ PASS | 5ms |
| 05 | 模块导入测试 - utils | ✅ PASS | 1ms |
| 06 | FileManager 功能测试 | ✅ PASS | 87ms |
| 07 | ProviderFactory 创建 OllamaProvider | ✅ PASS | 1ms |
| 08 | ProviderFactory 创建 OpenAIProvider | ✅ PASS | 0ms |
| 09 | AgentFactory 创建所有 Agent | ✅ PASS | 1ms |
| 10 | TaskOrchestrator 初始化测试 | ✅ PASS | 0ms |
| 11 | CLI 命令行接口测试 | ✅ PASS | 27ms |
| 12 | 配置文件模板检查 | ✅ PASS | 1ms |
| 13 | package.json 依赖检查 | ✅ PASS | 0ms |

### 5.3 测试结果汇总

| 属性 | 值 |
|------|------|
| 总测试数 | 13 |
| 通过数 | 13 |
| 失败数 | 0 |
| 通过率 | 100% |
| 总耗时 | ~144ms |

### 5.4 测试报告文件

- **报告路径**：`test/reports/smoke_test_1782474166988.json`
- **报告格式**：JSON

### 5.5 实验结论

1. **所有核心模块导入正常**：providers、agents、core、utils 四大模块均可正常导入
2. **FileManager 功能完整**：文件读写、存在检查、列表获取、树结构展示均正常
3. **ProviderFactory 工作正常**：可正确创建 OllamaProvider 和 OpenAIProvider
4. **AgentFactory 工作正常**：可创建所有 5 种角色的 Agent
5. **TaskOrchestrator 初始化正常**：可正常初始化并获取状态
6. **CLI 命令注册正常**：run、check、list 三个命令均已正确注册
7. **配置模板完整**：所有必要配置项均已包含
8. **依赖检查通过**：package.json 包含所有必要依赖

**结论**：AI Orchestrator v0.1.0 的核心功能模块已通过冒烟测试，可以正常运行。

---

## 六、使用说明

### 6.1 安装依赖

```bash
cd ai-orchestrator
npm install
```

### 6.2 配置环境

```bash
copy .env.example .env
```

编辑 `.env` 文件，配置模型提供商：

```ini
# 使用 Ollama（推荐）
MODEL_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b

# 或使用 OpenAI API
# MODEL_PROVIDER=openai
# OPENAI_API_KEY=your-api-key
```

### 6.3 检查连接

```bash
node src/cli/index.js check
```

### 6.4 运行任务

```bash
node src/cli/index.js run -t "写一个斐波那契数列的 Python 函数"
```

### 6.5 查看工作目录

```bash
node src/cli/index.js list
```

---

## 七、后续规划

### 7.1 短期目标（v0.2.0）

- [ ] Web 可视化界面
- [ ] 实时任务进度展示
- [ ] 任务历史记录
- [ ] 支持任务暂停/取消

### 7.2 中期目标（v0.3.0）

- [ ] Python 服务端
- [ ] 更多 Agent 角色（运维工程师、文档工程师）
- [ ] Git 集成（自动提交、PR 审查）
- [ ] 多模型并行（同任务多模型对比）

### 7.3 长期目标（v1.0.0）

- [ ] 桌面应用
- [ ] 插件系统（自定义 Agent）
- [ ] 任务模板库
- [ ] 团队协作功能

---

## 八、v1.0.0 新增模块（2026-06-28）

### 8.1 InteractiveSession（交互式编程会话）

**文件**：`src/cli/InteractiveSession.js`

独立封装的交互式 REPL，替代原 `interactive` 命令内联的 readline 逻辑。

**职责**：
- 多行任务输入（`;` 触发，空行/`;` 提交，`.cancel` 取消）
- 命令历史持久化（`~/.qidi/history`，最多 200 条，readline 原生支持 ↑↓ 翻阅）
- 上下文记忆持久化（`~/.qidi/session.json`：最近任务、最近报告 ID）
- Tab 命令补全
- 软中断 Ctrl+C（首次取消当前输入/任务，二次退出）
- 任务实时进度（订阅 TaskOrchestrator 事件，spinner 动态更新文案）
- 产出文件预览（任务完成后列出 workspace 中的代码文件）
- 内嵌文件查看 `view <path>`（带行号，限 200 行）
- 命令快捷方式：`scan`/`status`/`tools`/`mode`/`provider`/`tasks`/`reports`/`report`/`context`/`ls`/`view`/`pwd`/`history`/`reset`/`clear`

**与其他模块的关系**：
- 依赖 `TaskOrchestrator` 执行任务
- 依赖 `ToolScanner` + `AdapterFactory` 扫描工具
- 依赖 `ProviderFactory` 获取模型提供商
- 依赖 `FileManager` 进行文件列表/查看
- 不修改任何核心模块，仅作为 CLI 表层封装

### 8.2 文件管理 REST API

**文件**：`src/core/WebUIServer.js`（新增 `_resolveSafe` / `_listFiles` / `_readFile` / `_writeFile` / `_renameFile` / `_deleteFile` / `_makeDir` / `_walkDir` / `_detectLang`）

**设计原则**：
- **统一入口**：所有文件操作走 `/api/files/*`，废弃散落的私有路径
- **安全优先**：`_resolveSafe` 强制路径必须 resolve 后仍在 `workspaceDir` 内，防穿越
- **二进制感知**：`_readFile` 检测 NUL 字节，二进制以 base64 传输，前端只读
- **语言检测**：`_detectLang` 按扩展名映射语言，供前端高亮
- **原文件路由兼容**：`/api/files/view` 复用 `_resolveSafe`，保持旧前端可用

**REST 端点**：`GET /api/files`、`GET /api/files/read`、`POST /api/files/write`、`POST /api/files/rename`、`POST /api/files/delete`、`POST /api/files/mkdir`、`POST /api/files/upload`、`GET /api/files/download`、`GET /api/files/view`（兼容）

### 8.3 文件管理前端页面

**文件**：`public/index.html`（新增 `#page-files`）、`public/js/app.js`（新增 `files*` 系列函数）、`public/css/style.css`（新增 `.files-list` / `.code-editor` / `.upload-drop-zone` / `.template-tag` 等）

**能力**：
- 路径导航栏 + 递归开关 + 文件计数
- 左栏文件列表（文件夹/文件图标、大小、点击进入或打开）
- 右栏带行号编辑器（Tab 缩进、Ctrl+S 保存、二进制只读）
- 新建文件/新建目录/上传/下载/删除（删除二次确认）
- 编程控制台的产出文件卡片新增"✏️ 编辑"按钮可跳转本页

### 8.4 编程控制台增强

**文件**：`public/index.html`（重写 `#page-console`）、`public/js/app.js`（新增 `updateTaskEditor` / `applyTemplate` / `toggleMultiline` / `handleUploadedFiles` / `saveTaskToWorkspace` / `copyOutput` / `downloadAllOutputFiles` 等）

**新增能力**：
- 带行号的任务编辑器（Tab 缩进、行列/字数实时提示）
- 快捷任务模板（6 个常用任务一键填充）
- 文件上传区（拖拽 + 点击，写入 `uploads/`）
- 多行模式切换
- 从工作目录载入已有文件作为任务上下文
- "存为任务"保存到 `tasks/task_<ts>.md`
- 执行结果"复制"按钮
- 产出文件"全部下载"

---

*文档生成时间：2026-06-28*
*项目版本：v1.0.0*
