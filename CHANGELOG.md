# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.2.0] — 2026-06-29

### Added — P0: 工具学习系统（择优匹配）

- **ToolLearning 模块** (`src/core/ToolLearning.js`)
  - **执行历史记录**：记录每次工具执行的成功率、质量评分、耗时
  - **工具画像分析**：
    - 按语言统计成功率和平均质量
    - 按任务类型统计表现
    - 按复杂度统计表现
    - 按角色统计表现
  - **擅长领域识别**：自动分析每个工具的强项和弱项
  - **择优匹配推荐**：
    - 根据历史学习，对不同工具加减分
    - 推荐最佳工具及原因说明
  - **学习数据持久化**：自动保存到 `config/tool_learning/history.json`
  - **API 接口**：
    - `recordExecution(toolName, taskInfo, result)` — 记录执行结果
    - `getToolRecommendation(taskInfo, availableTools)` — 获取最佳工具推荐
    - `getToolLearningStats()` — 获取学习统计
    - `getToolLearningProfiles()` — 获取所有工具画像摘要
    - `resetToolLearning()` — 重置学习数据

- **TaskRouter 集成学习加成** (`src/core/TaskRouter.js`)
  - `_calculateCapabilityScore` 新增第3个参数 `toolName`
  - 学习加成范围：-10 到 +10 分
  - 能力匹配路由自动应用学习加成
  - **API**：`setToolLearning(toolLearning)` — 设置学习模块

- **TaskOrchestrator 集成学习反馈** (`src/core/TaskOrchestrator.js`)
  - 初始化 ToolLearning 实例
  - 任务完成后自动记录执行结果到学习系统
  - 新增 API：`getToolLearningStats()`、`getToolLearningProfiles()`、`getToolRecommendation()`、`resetToolLearning()`

### Added — P0: 系统提示词智能升级

- **增强回答策略** (`src/core/WebUIServer.js`)
  - 新增「先理解用户意图，再回答」原则
  - 新增「复杂问题先拆解」原则
  - 新增「不确定时诚实告知用户」原则
  - 新增「定期总结进度和下一步计划」原则
  - **身份要求细化**：
    - 不主动提及底层模型名
    - 只有用户明确问及时才如实回答具体模型名
  - 回答更专业、更有条理

### Fixed — P0: 导入路径修复

- **CacheStore 导入路径** (`src/core/TaskOrchestrator.js`)
  - 修复 `require('./CacheStore')` → `require('../utils/CacheStore')`

### Changed — v1.3.0 内容（保留）

---

## [1.3.0] — 2026-06-29

### Added — P0: 熔断器模式（Circuit Breaker）— 借鉴 cc-switch

- **TaskRouter 熔断器集成** (`src/core/TaskRouter.js`)
  - **三种状态**：Closed（正常）→ Open（熔断）→ HalfOpen（恢复探测）
  - **双重触发机制**：
    - 连续失败计数（默认 3 次）→ 触发熔断
    - 错误率阈值（默认 >60%，且请求数 ≥10）→ 触发熔断
  - **智能恢复策略**：
    - 熔断后等待超时（默认 60 秒）→ 进入半开状态
    - 半开状态仅允许 1 个探测请求
    - 探测成功 → 切换回 Closed（重置统计）
    - 探测失败 → 重新进入 Open（延长等待时间）
  - **路由感知**：轮询策略自动跳过熔断工具，半开工具需通过探测验证
  - **API 接口**：
    - `recordTaskResult(toolName, success, errorMessage)` — 记录工具执行结果
    - `getCircuitBreakerStats(toolName)` — 获取单个工具熔断器状态
    - `getAllCircuitBreakerStats()` — 获取所有工具熔断器状态
    - `resetCircuitBreaker(toolName)` — 重置指定工具熔断器
    - `resetAllCircuitBreakers()` — 重置所有熔断器
    - `allowHalfOpenProbe(toolName)` — 检查半开工具是否允许探测
    - `checkAndUpdateState(toolName)` — 检查并更新熔断器状态（超时恢复）
  - **配置选项**：`failureThreshold`（3）、`successThreshold`（2）、`timeoutSeconds`（60）、`errorRateThreshold`（0.6）、`minRequests`（10）

### Added — P0: 模型感知参数优化（Thinking Optimizer）— 借鉴 cc-switch

- **BaseAgent 模型优化配置** (`src/agents/BaseAgent.js`)
  - **三路径分发策略**：
    - **skip**（跳过思考）：haiku 轻量模型，温度 0.3，禁用 thinking
    - **adaptive**（自适应思考）：sonnet/opus/gpt4 系列，温度 0.5-0.7，启用 thinking，budgetTokens 32000
    - **legacy**（标准思考）：gpt3/qwen/llama/mistral 系列，温度 0.5-0.6，启用 thinking，budgetTokens 16384
  - **模型家族检测**：支持 haiku、sonnet、opus、gpt4、gpt3、qwen、llama、mistral 自动识别
  - **智能重试温度**：根据模型家族动态调整重试温度序列
  - **API 接口**：
    - `detectModelFamily(modelName)` — 检测模型所属家族
    - `getModelOptimization(modelName)` — 获取模型优化配置
    - `buildOptimizedOptions(modelName, options)` — 构建优化后的请求选项
  - **sendWithRetry 增强**：自动检测模型类型，应用最优参数配置

### Added — P0: 输出自修复（Output Rectifier）— 借鉴 cc-switch

- **QualityCheckerAgent 代码块修复** (`src/agents/QualityCheckerAgent.js`)
  - **不完整代码块修复**：检测并提取缺少结束标记的代码块
  - **语言自动检测**：基于语法特征自动识别 C/Python/JavaScript/C++ 语言
  - **JSON 自动修复**：
    - 移除 markdown 代码块标记
    - 移除 thinking 标签
    - 提取 JSON 边界（从第一个 `{` 到最后一个 `}`）
    - 修复未闭合字符串
    - 修复缺失逗号
    - 修复尾部逗号
  - **API 接口**：
    - `_repairCodeBlocks(text)` — 修复代码块缺失
    - `_repairJson(text)` — 修复 JSON 格式错误
    - `_extractJsonWithRepair(text)` — 优先使用修复后提取
  - **集成点**：`_extractCode()` 和 `_runAIReview()` 自动使用修复逻辑

### Added — P0: CLI 初始化向导

- **交互式启动流程优化** (`src/cli/InteractiveSession.js`)
  - **多步骤初始化向导**：
    - 本地模式：步骤1→步骤2→步骤3（模式→提供商→扫描）
    - 云端模式：步骤1→步骤2→步骤3→步骤4→步骤5（模式→提供商→模型→API Key→扫描）
  - **高效模式支持**：新增 efficiency 模式，优先选择响应快的模型
  - **模式标签更新**：`_cmdMode` 和 `_cmdStatus` 支持三种模式显示
  - **启动界面显示当前配置**：模式、提供商、模型信息

- **自定义模型配置**：
  - **国际主流模型**：
    - OpenAI：GPT-4o、GPT-4o mini、GPT-4 Turbo、GPT-3.5 Turbo、GPT-4
    - Anthropic：Claude 3.5 Sonnet、Claude 3 Opus、Claude 3 Sonnet、Claude 3 Haiku
  - **国内主流模型**：
    - 字节跳动 豆包：Pro、Lite、Code
    - 百度千帆（文心一言）：ERNIE 4.0、ERNIE 3.5、ERNIE 4.0 Turbo
    - 阿里通义千问：2.5 72B、2.5 14B、2.5 7B、Code 7B
    - DeepSeek：Chat、R1.5、Coder、Coder V2
    - Moonshot（月之暗面）：8K、32K、128K
    - MiniMax：ABAB6、ABAB5.5
  - 支持输入自定义模型名称和 API Base URL
  - 自动设置环境变量和默认 Base URL

- **API Key 输入优化**：
  - 密码输入隐藏（不显示输入内容）
  - 自动验证 API Key 有效性
  - 提示获取地址

- **大文本自动文件上传**（类似 Kimi 网页版）：
  - 输入内容超过 2000 字符时自动保存为 `task_input_<timestamp>.txt` 文件
  - 避免 CLI 输入长度限制
  - 文件保存在 workspace 目录，方便后续引用

### Changed — v1.2.0 内容（保留）

---

## [1.2.0] — 2026-06-29

### Added — P1: 被拒计数器与人工审批回退

- **RejectionCounter 安全网机制** (`src/core/TaskOrchestrator.js`)
  - 自动追踪连续失败次数，超过阈值（默认 3 次）时暂停执行
  - 触发 `humanApprovalRequired` 事件，等待人工确认后继续
  - **API 接口**：
    - `confirmHumanApproval(reason)` — 确认人工审批，重置计数器
    - `skipHumanApproval()` — 跳过审批，继续执行
    - `getRejectionCounterStatus()` — 获取计数器状态
    - `setRejectionThreshold(threshold)` — 设置阈值（1-10）
    - `enableRejectionCounter()` / `disableRejectionCounter()` — 启用/禁用
  - **配置**：通过 `maxConsecutiveFailures` 选项自定义阈值
  - **触发条件**：子任务执行失败、质量评分低于阈值、任务状态标记为 failed

### Added — P1: Auto模式自动决策

- **autoDecideMode 智能模式选择** (`src/core/ExecutionModeManager.js`)
  - **两阶段决策**：关键词推荐 + 历史性能评估
  - **历史性能覆盖**：基于各模式的成功率（60%权重）和平均质量（40%权重）综合评分
  - 当候选模式历史数据不足（<3次）时，直接使用关键词推荐结果
  - 当候选模式表现良好（成功率≥80%且质量≥75）时，保留推荐
  - 否则自动切换到历史表现更好的模式
  - **API 接口**：
    - `autoDecideMode(taskDescription, options)` — 自动决定并切换模式
    - `recordTaskResult(mode, success, qualityScore)` — 记录任务结果用于学习
    - `getModeStatistics()` — 获取各模式统计（成功率、平均质量、使用次数）
    - `getAutoModeStatus()` — 获取自动模式完整状态
    - `setAutoModeEnabled(enabled)` — 启用/禁用自动模式
    - `resetStatistics()` — 重置历史统计
  - **模式历史追踪**：每次模式切换记录 `{ timestamp, from, to }`
  - **统计数据**：各模式独立维护 `{ total, success, avgQuality, successRate }`

### Added — P2: 早期安全门（Early Safety Gate）

- **高危操作检测** (`src/agents/QualityCheckerAgent.js`)
  - 在编译门之前执行，作为第一道安全防线
  - **检测规则**（可独立启用/禁用）：
    - `fileDeletion`（高危）：检测 `rm`、`unlink`、`fs.unlink`、`fs.rm` 等文件删除操作
    - `permissionElevation`（高危）：检测 `sudo`、`chmod`、`chown`、`setuid` 等权限提升操作
    - `sensitiveData`（高危）：检测 `password=`、`api_key`、`secret=`、`token=` 等敏感信息硬编码
    - `networkAccess`（中危）：检测 `http://`、`https://`、`fetch()`、`axios`、`socket` 等网络请求
    - `systemCommands`（中危）：检测 `exec()`、`spawn()`、`child_process`、`shell` 等系统命令执行
  - **严重等级**：高危操作直接阻断（质量分 20），中危操作警告
  - **可配置性**：支持通过 `earlySafetyRules` 自定义检测规则
  - **集成**：作为渐进质量门控的第一道门（earlySafety → compile → lint → aiReview → integration）

### Added — P2: Agent 智能闭环增强

- **BaseAgent 结构化输出保障** (`src/agents/BaseAgent.js`)
  - JSON Schema 输出验证和自动修复
  - 多温度重试机制（0.7→0.2→0.5）
  - Thinking Chain 支持（`<thinking>` 标签提取）

- **TaskSplitterAgent 策略自适应** (`src/agents/TaskSplitterAgent.js`)
  - 基于执行历史动态调整拆分粒度、依赖权重、复杂度偏向
  - 低成功率时自动调细粒度、增加依赖权重
  - 高质量时自动放宽策略
  - **API**：`getStrategyReport()`、`resetStrategy()`、`adaptiveResplit()`

- **MergeEngine AST级合并** (`src/agents/MergeEngine.js`)
  - 三路合并算法（基于契约提取的智能合并）
  - 语义冲突检测（支持 C/C++/JavaScript/Python）
  - 合并后验证（编译检查、语法检查、契约一致性检查）
  - 回退合并策略

### Changed — 测试

- **测试通过率**：53/53（100%，等级 S）
- **冒烟测试**：31/31 通过

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
