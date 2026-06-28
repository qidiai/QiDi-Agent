# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] — 2026-06-28

### Added — P2: 效率模式（⚡ Efficiency Mode）

- **新增第三种执行模式：效率模式** (`src/core/ExecutionModeManager.js`)
  - **核心特性**：复杂任务自动拆解 → 广播分发到所有 AI 编程工具并行执行 → 避免重复造轮子 → 最终质检审核 → AI 智能合并输出
  - 拆分：云端最强模型（最多 20 个子任务）
  - 代码生成：广播并行模式（所有工具同时尝试不同方案）
  - 质检：混合质检（本地 Ollama 快速初筛 + 本地工具链编译/Lint/测试）
  - 合并：混合策略（契约拼装 + AI 智能合并）
  - 路由：broadcast 策略优先
  - 关键词推荐："效率"、"并行"、"分布式"、"多工具"、"大规模"、"复杂任务"、"拆解"、"分发" 等自动推荐
- **前端 UI**：Agent 页面新增 ⚡ 效率 胶囊按钮，与 🔒 隐私 / ✨ 高质量 并列
- **默认首页**：WebUI 打开默认显示 Agent 页面（而非 Dashboard），用户直接进入输入框

### Fixed — P0: WebUI 发送失败（根因修复）

- **任务执行阻塞 HTTP 响应** (`src/core/WebUIServer.js`)
  - **根因**：`_executeTask` 中 `await this._runTaskAsync(...)` 导致整个 HTTP 响应被阻塞，直到任务执行完毕
  - 如果 Ollama 未运行或 DeepSeek 连接超时，前端 `fetch` 会一直挂起，表现为"点击发送无反应"
  - **修复**：改为 `Promise.resolve(this._runTaskAsync(...)).catch(...)`，任务在后台异步执行，HTTP 响应立即返回
  - 前端 `fetch` 在 10-20ms 内收到 `{ success: true, taskId: "..." }`，随后通过轮询获取进度

### Fixed — P0: WebUI 修复

- **OpenAIProvider baseURL 大小写兼容** (`src/providers/OpenAIProvider.js`)
  - 构造函数同时接受 `config.baseUrl` 和 `config.baseURL`，修复 DeepSeek/Groq/智谱等 OpenAI 兼容 provider 的 baseURL 解析失败问题
- **OllamaProvider baseURL 大小写兼容** (`src/providers/OllamaProvider.js`)
  - 同上，同时接受 `config.baseUrl` 和 `config.baseURL`
- **DeepSeek 模型名更新** (`config/agents.json`)
  - `deepseek-coder` → `deepseek-chat`（原模型已废弃）
- **Anthropic 配置补充 baseURL** (`config/agents.json`)
  - 显式添加 `baseURL: "https://api.anthropic.com"`
- **模板气泡被 sidebar 遮挡** (`public/css/style.css`)
  - `.chat-tpl-popover` 从 `position: absolute; z-index: 50` 改为 `position: fixed; z-index: 200`
  - 调整 `left` 定位避免与 sidebar 重叠
- **Agent 页面布局重叠** (`public/css/style.css`)
  - `.chat-page` 移除固定 `height: calc(100vh - 80px)`，改用 flex 自适应，避免与 header 和内容区冲突
- **executeTaskEnhanced 异常处理** (`public/js/app.js`)
  - 增加 try/catch 包裹，提交异常时在控制台输出错误信息

### Fixed — P0: 安全与稳定性修复

- **CORS 默认值安全加固** (`src/core/WebUIServer.js`)
  - `CORS_ALLOW_ORIGIN` 默认值从 `*` 改为 `http://localhost:3000`
  - 文档强调生产环境必须配置为具体域名
- **认证令牌比较时序安全** (`src/core/WebUIServer.js`)
  - SHA256 token 比较改用 `crypto.timingSafeEqual()`，防止时序攻击
  - 区分「缺少令牌」和「令牌无效」两种日志
- **任务执行异步化** (`src/core/WebUIServer.js`)
  - `_executeTask` 内 `setTimeout` fire-and-forget 改为 `async/await` 直接执行
  - 新增 `_runTaskAsync()` 方法，顶层 `unhandledRejection` 兜底
- **速率限制** (`src/core/WebUIServer.js`)
  - 全局 API 限 100次/分钟（`express-rate-limit`）
  - `/api/tasks/execute` 限 10次/分钟
- **_activeTasks 容量控制** (`src/core/WebUIServer.js`)
  - Map 上限 100 条，超限自动淘汰最旧的 completed/failed 条目
  - 定时清理（每 1h 清理超期条目，`stop()` 时清除定时器）
- **Logger 导入方式统一** (`src/core/ContractAssembler.js`, `src/core/WebUIServer.js`)
  - 修复 `const { logger } = require('../utils/Logger')` 导致的 `undefined` 运行时错误
  - 统一为 `const createLogger = require('../utils/Logger'); const logger = createLogger('ModuleName')` 模式

### Added — P1: 任务暂停/恢复/断点续传

- **TaskScheduler 暂停/恢复机制** (`src/core/TaskScheduler.js`)
  - `pause()` — 暂停当前执行循环，等待 `resume()` 调用
  - `resume()` — 恢复暂停的执行循环
  - `isPaused()` — 检查当前是否已暂停
  - 每个任务执行前自动检查暂停状态
  - 事件通知：`schedulerPaused` / `schedulerResumed`
- **Checkpoint 断点续传** (`src/core/TaskScheduler.js`)
  - `saveCheckpoint(runId, tasks, extra)` — 自动保存每个任务完成后的状态
  - `loadCheckpoint(runId)` — 加载指定 checkpoint
  - `listCheckpoints()` — 列出所有可用 checkpoint
  - `deleteCheckpoint(runId)` — 删除指定 checkpoint
  - `cleanOldCheckpoints(maxDays)` — 清理过期 checkpoint（默认 7 天）
  - 自动 checkpoint：每个任务完成后自动保存
- **TaskOrchestrator API** (`src/core/TaskOrchestrator.js`)
  - `orchestrator.pause()` / `orchestrator.resume()` / `orchestrator.isPaused()`
  - `orchestrator.saveCheckpoint()` — 手动保存
  - `orchestrator.restoreCheckpoint(runId)` — 从 checkpoint 恢复
  - `orchestrator.listCheckpoints()` / `deleteCheckpoint()` / `cleanOldCheckpoints()`
  - 事件通知：`taskPaused` / `taskResumed` / `checkpointSaved` / `checkpointRestored`

### Added — P2: ESLint 集成

- **ESLint 代码规范检查** (`.eslintrc.json`, `package.json`)
  - 添加 ESLint 8.x 及 standard 配置
  - 新增 `lint` / `lint:fix` / `lint:ci` 脚本
  - 配置规则：no-console off, semi always, quotes single, eqeqeq warn
  - 忽略目录：node_modules, workspace, output, reports, memory, checkpoints, logs

### Changed — 测试

- **测试通过率**：53/53（100%，等级 S）

### Changed — 配置文件

- **`.env.example`** — CORS 默认值从 `*` 改为 `http://localhost:3000`，注释强调生产必须配置

### Fixed — P3: WebUI 用户体验增强

- **文件编辑未保存提示** (`public/js/app.js` + `public/index.html`)
  - 新增 `filesEditorDirty` 脏标记，编辑时自动触发
  - 编辑器底部状态栏实时显示「⚠️ 有未保存的更改」/「✅ 已保存」
  - 关闭编辑器前有未保存更改时弹出确认对话框
  - Ctrl+S 快捷键保存后更新状态
- **文件上传 Multipart 支持** (`src/core/WebUIServer.js` + `public/js/app.js`)
  - 后端新增 `/api/files/upload` multipart 路由（`multer`，最大 50MB，支持 20 个文件）
  - 后端保留 `/api/files/upload-json` 兼容旧版 JSON 上传
  - 前端改用 `FormData` + `XMLHttpRequest` 实现 multipart 上传
  - 上传进度条实时显示百分比
  - 上传完成后自动清理临时文件

### Added — P1: 效率模式统一调度闭环

- **CLI 交互式会话增强** (`src/cli/InteractiveSession.js`)
  - 多行输入模式（`;` 提交 / 空行结束 / `.cancel` 取消）
  - 命令历史持久化（`~/.qidi/history`，最多 200 条）
  - 上下文记忆：最近任务、最近报告 ID、上次错误/结果
  - Tab 补全（20+ 命令）
  - 任务实时进度条（`ora` spinner）
  - 快捷命令：`scan`、`status`、`tools`、`mode`、`provider`、`run`、`tasks`、`reports`、`report <id>`、`context`、`ls`、`view`、`pwd`、`history`、`reset`、`clear`

- **执行模式管理器** (`src/core/ExecutionModeManager.js`)
  - 隐私模式（本地 Ollama，代码不离开本地）
  - 高质量模式（云端 API，更优拆分和质检）
  - 模式动态切换、对比、关键词推荐

- **任务路由器** (`src/core/TaskRouter.js`)
  - 4 种路由策略：轮询（round_robin）、能力匹配（capability）、手动（manual）、广播（broadcast）
  - 路由统计与验证

- **契约拼装引擎** (`src/core/ContractAssembler.js`)
  - 多语言契约提取：C、Python、JavaScript、TypeScript、Go、Rust
  - 多渠道契约合并与冲突检测
  - 本地 Ollama 辅助契约提取（隐私模式）

- **MergeEngine** (`src/agents/MergeEngine.js`)
  - 多结果分组合并与去重

- **TaskOrchestrator 集成** (`src/core/TaskOrchestrator.js`)
  - 统一调度入口：用户输入 → 模式选择 → 智能拆分 → 工具分派 → 质检合并 → 输出
  - 事件驱动进度追踪（`splitting`、`taskSplit`、`taskStart_sub`、`taskComplete_sub`、`reportGenerated`）
  - 报告持久化与加载

### Added — P2: WebUI 全面升级

- **WebUI 服务器** (`src/core/WebUIServer.js`)
  - 完整 SPA 前端（`public/index.html` + `public/js/app.js` + `public/css/style.css`）
  - 文件管理页面（`#page-files`）：树形目录浏览、文件查看/编辑/删除/下载
  - 行号编辑器（textarea + gutter 同步滚动）
  - 文件上传/下载 API（`/api/files/*`）
  - 任务执行面板：输入框 + 模式选择 + 路由配置 + 实时日志
  - 报告查看面板：搜索、详情、Markdown 渲染
  - 模型选择表单（`#model-form`）

- **CORS + 认证** (`src/core/WebUIServer.js`)
  - `CORS_ALLOW_ORIGIN` 环境变量控制允许的来源（默认 `*`）
  - `WEBUI_AUTH_PASSWORD` 环境变量配置密码认证（SHA256 哈希校验）
  - `X-WebUI-Token` 请求头验证
  - `ALLOWED_IPS` 白名单支持

### Added — P2: Anthropic Provider 完善

- **AnthropicProvider** (`src/providers/AnthropicProvider.js`)
  - 完善角色映射：`system` → content block、`tool` → tool_result block、`tool_use` → tool_use block
  - `chatCompletion` 和 `chatStream` 方法统一映射逻辑
  - 支持 Anthropic Messages API 完整结构

### Added — P2: 统一 Logger 推广

- **Logger 模块** (`src/utils/Logger.js`) 已在以下位置推广使用：
  - `src/core/WebUIServer.js` — 启动日志、错误日志改用 `logger`
  - `src/core/ToolScanner.js` — 扫描失败、连接失败改用 `logger.warn`
  - `src/core/ContractAssembler.js` — 契约提取失败、本地模型初始化改用 `logger`
  - CLI 进度输出保留 `console.log`（终端交互界面）

### Changed — 配置文件

- **`.env.example`** 新增环境变量：
  - `CORS_ALLOW_ORIGIN` — WebUI CORS 允许来源
  - `WEBUI_AUTH_PASSWORD` — WebUI 认证密码
  - `ALLOWED_IPS` — IP 白名单

### Changed — 文档

- **`docs/API.md`** — 补充 WebUI API 端点文档（文件管理、任务执行、报告查询）
- **`docs/ARCHITECTURE.md`** — 更新架构图，反映新增模块（ExecutionModeManager、TaskRouter、ContractAssembler、MergeEngine）
- **`docs/NEXT_PLAN.md`** — 更新 P1/P2 状态，标记已完成项
- **`docs/OPERATION_GUIDE.md`** — 补充 WebUI 使用说明

### Removed — 清理

- 删除过期实验报告（`reports/exp_*.md` 系列）
- 清理 `src/cli/index.js` 中冗余命令注册

### Added — P4: 对话记忆与持久化

- **TokenCounter token估算集成** (`src/utils/TokenCounter.js`, `src/core/WebUIServer.js`)
  - 中文按字符数×1.5、英文按词数×1、代码按字符数×0.5 估算 token 消耗
  - 精确追踪每次 API 调用的 prompt/completion/total token 数
- **24K 上下文预算与自动截断** (`src/core/WebUIServer.js`)
  - `MAX_CHAT_CONTEXT_TOKENS = 24000`，预留 ~8K 给模型回复
  - 超出预算时自动移除最早对话（保留首条 user 消息和最新消息），循环截断至预算内
- **会话双层持久化** (`src/core/WebUIServer.js`, `public/js/app.js`)
  - 前端：`localStorage`（`qidi_chat_history`），刷新后自动恢复
  - 后端：文件存储至 `{configDir}/chat_memory/{sessionId}.json`
  - 新增会话管理 API：`GET/POST /api/chat/sessions`、`GET/DELETE /api/chat/sessions/:id`
  - 前端上下文用量指示器，进度条实时显示 token 占用百分比

### Added — 先聊后执行交互模式

- **对话引导**：用户先通过自然语言与 Agent 沟通需求，确认理解无误后再触发执行
- **会话 ID 追踪**：每个聊天请求携带 `sessionId`，服务端自动创建或续接会话

### Fixed — P0: Agent 执行链路修复

- **Provider 透传** (`src/core/WebUIServer.js`, `src/core/RealTaskExecutor.js`)
  - **根因**：`WebUIServer._runTaskAsync()` 创建 `RealTaskExecutor` 时未传入 `provider`，导致 `AgentFactory.createAll(undefined)` → 所有 Agent provider 为 undefined → TaskSplitterAgent 崩溃
  - **修复**：从 AgentHub 的首个启用 Agent 获取 `provider`，显式传入 RealTaskExecutor
  - **影响**：任务拆分/代码生成/质检/合并等全部 6 个 Agent 均获得正常工作 provider
- **CLI 工具授权复用** (`src/core/RealTaskExecutor.js`)
  - **根因**：`RealTaskExecutor._scanTools()` 创建独立 `ToolScanner` 实例，无视 WebUI 已注册的工具
  - **修复**：新增 `toolScanner` 参数透传，`_scanTools()` 优先复用 WebUI 的已授权工具列表
  - **影响**：CLI 端不再重复弹出工具授权确认

### Changed — Agent 身份统一

- **AI 身份钉死为 QIDI Agent**：系统提示词统一使用「QIDI Agent（启迪智能体）」作为正式名称，无论底层调用何种模型（Ollama/OpenAI/Anthropic），对外身份始终保持一致
- **用户自定义身份**：支持通过自然语言（如「从现在起你是 Python 专家」）设定临时身份

---

## [1.0.0] — 2026-06-28

### Added
- 多 AI 编程工具统一编排平台
- 8 个工具适配器：Claude Code、Open Code、OpenClaw、Qoder、Hermes Agent、AtomCode、Mimo Code、Trae CN
- Provider 工厂：Ollama、OpenAI、Anthropic
- TaskOrchestrator 核心编排器
- CLI 命令注册与基础交互
- 基础 WebUI（任务输入 + 结果展示）
- 单元测试套件（53 项，100% 通过）
- Dockerfile + .dockerignore
- GitHub Actions CI 配置
- 端到端测试（Ollama）

---

**发布日期**：2026-06-28  
**维护者**：QiDi Agent Team
