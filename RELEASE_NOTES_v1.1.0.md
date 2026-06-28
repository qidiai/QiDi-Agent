# QiDi Agent v1.1.0 更新报告

> **发布日期**：2026-06-28  
> **版本**：1.1.0（从 1.0.0 升级）  
> **测试通过率**：53/53（100%）  
> **代码规模**：186 个文件，~47,400 行，JS 21,700 行  
> **变更范围**：安全加固 × P0、WebUI 体验 × P3、文档 × 全量

---

## 📋 概览

v1.1.0 是一次**全栈优化发布**，覆盖从底层安全到前端用户体验的各个层面。本次更新完成了从 NEXT_PLAN.md 上登记的全部 15 项优化任务（P0/P1/P2/P3 全覆盖），包括：

- 🔒 **P0 安全与稳定性**（5 项）：CORS 加固、时序安全认证、速率限制、fire-and-forget 修复、内存泄漏修复
- 🧠 **P1 效率模式闭环**（6 项）：CLI 交互增强、执行模式管理器、任务路由器、契约拼装引擎、MergeEngine、Orchestrator 集成
- 🖥️ **P2 WebUI 全面升级**（4 项）：完整 SPA 前端、文件管理、行号编辑器、统一 API
- 🛠️ **P3 用户体验**（2 项）：文件编辑未保存提示、Multipart 文件上传

---

## 🔒 P0 — 安全与稳定性修复

### 1. CORS 默认值安全加固
| 项目 | 详情 |
|------|------|
| **文件** | `src/core/WebUIServer.js`, `.env.example` |
| **变更** | `CORS_ALLOW_ORIGIN` 默认值从 `*` → `http://localhost:3000` |
| **影响** | 降低生产环境未授权访问面；文档强制要求生产配置具体域名 |

### 2. 认证令牌时序安全
| 项目 | 详情 |
|------|------|
| **文件** | `src/core/WebUIServer.js` |
| **变更** | SHA256 token 比较从 `===` 改为 `crypto.timingSafeEqual()` |
| **影响** | 防御时序攻击，区分「缺令牌」和「令牌无效」日志 |

### 3. 速率限制
| 项目 | 详情 |
|------|------|
| **文件** | `src/core/WebUIServer.js` |
| **变更** | 全局 API 100 次/分钟 + `/api/tasks/execute` 10 次/分钟（`express-rate-limit`） |
| **影响** | 防止 API 滥用和任务队列溢出 |

### 4. 任务执行异步化
| 项目 | 详情 |
|------|------|
| **文件** | `src/core/WebUIServer.js` |
| **变更** | `_executeTask` 内 `setTimeout` fire-and-forget → `async/await` 直接执行；新增 `_runTaskAsync()` |
| **影响** | 消除 `unhandledRejection`，错误正确传播到 HTTP 响应 |

### 5. `_activeTasks` 内存泄漏修复
| 项目 | 详情 |
|------|------|
| **文件** | `src/core/WebUIServer.js` |
| **变更** | Map 上限 100 条 + 定时清理（1h）+ `stop()` 清定时器；新增 `_ensureActiveTaskSlot()` / `_cleanupExpiredTasks()` |
| **影响** | 长时间运行的 WebUI 服务不再无限增长内存占用 |

---

## 🧠 P1 — 效率模式统一调度闭环

### 6. CLI 交互式会话增强
| 项目 | 详情 |
|------|------|
| **文件** | `src/cli/InteractiveSession.js`, `src/cli/index.js` |
| **新增** | 多行输入（`;` 提交 / 空行结束 / `.cancel` 取消）、命令历史持久化（`~/.qidi/history`，200 条）、上下文记忆（最近任务/报告/错误）、Tab 补全（20+ 命令）、`ora` spinner 实时进度条 |
| **新增选项** | `interactive` 命令新增 `--provider` 选项（`ollama` / `openai` / `anthropic`），支持启动时指定默认提供商 |
| **命令集** | `scan`、`tools`、`status`、`mode privacy/quality`、`provider ollama/openai`、`run <任务>`、`tasks`、`reports`、`report <id>`、`context/ctx`、`ls [dir]`、`view <path>`、`pwd`、`history`、`reset`、`clear/cls`、`help/h/?`、`exit/quit/q` |

其他 CLI 命令也进行了强化：
- `qidi scan --connect --save` — 扫描 + 自动连接 + 保存
- `qidi connect --auto` / `qidi connect -t <tool>` — 自动/指定工具连接
- `qidi agents --enable/--disable <name>` — 启用/禁用 Agent
- `qidi reports [-c N]` — 列出最近 N 个报告
- `qidi report <id>` — 查看指定报告
- `qidi config --show / --level debug` — 配置查看/日志级别
- `qidi logs [--clean]` — 日志统计/清理
- `qidi web [-p <port>]` — 启动 WebUI
- `qidi version` — 版本信息
- `qidi update --changelog` — 查看更新日志

### 7. 执行模式管理器
| 项目 | 详情 |
|------|------|
| **文件** | `src/core/ExecutionModeManager.js` |
| **新增** | 隐私模式（本地 Ollama，代码不离开本地）/ 高质量模式（云端 API）；动态切换、对比、关键词推荐 |

### 8. 任务路由器
| 项目 | 详情 |
|------|------|
| **文件** | `src/core/TaskRouter.js` |
| **新增** | 4 种路由策略：轮询、能力匹配、手动、广播；路由统计与验证 |

### 9. 契约拼装引擎
| 项目 | 详情 |
|------|------|
| **文件** | `src/core/ContractAssembler.js` |
| **新增** | 多语言契约提取（C / Python / JS / TS / Go / Rust）；多渠道契约合并与冲突检测；本地 Ollama 辅助提取 |

### 10. MergeEngine 合并引擎
| 项目 | 详情 |
|------|------|
| **文件** | `src/agents/MergeEngine.js` |
| **新增** | 多结果分组合并与去重 |

### 11. TaskOrchestrator 集成
| 项目 | 详情 |
|------|------|
| **文件** | `src/core/TaskOrchestrator.js` |
| **新增** | 统一调度入口（输入→模式→拆分→分派→质检→输出）；事件驱动进度追踪（`splitting`/`taskSplit`/`taskStart_sub`/`taskComplete_sub`/`reportGenerated`）；报告持久化 |

---

## 🖥️ P2 — WebUI 全面升级

### 12. 完整 SPA 前端
| 项目 | 详情 |
|------|------|
| **文件** | `public/index.html` + `public/js/app.js` + `public/css/style.css` |
| **新增** | 任务执行面板（输入框+模式选择+路由配置+实时日志）、报告查看面板（搜索+详情+Markdown 渲染）、模型选择表单 |

### 13. 文件管理
| 项目 | 详情 |
|------|------|
| **文件** | `public/index.html` + `src/core/WebUIServer.js` |
| **新增** | 树形目录浏览、文件查看/编辑/删除/下载、行号编辑器（textarea + gutter 同步滚动）、统一 `/api/files/*` API |

### 14. Anthropic Provider 完善
| 项目 | 详情 |
|------|------|
| **文件** | `src/providers/AnthropicProvider.js` |
| **变更** | 角色映射从简单 user/assistant 改为完整的 Anthropic Messages API 结构（system → content block、tool → tool_result、tool_use → tool_use） |

### 15. 统一 Logger 推广
| 项目 | 详情 |
|------|------|
| **文件** | `src/utils/Logger.js` + 各核心模块 |
| **变更** | WebUIServer / ToolScanner / ContractAssembler 全面采用 `logger` 替代 `console`；CLI 交互输出保留 `console.log` |

---

## 🛠️ P3 — WebUI 用户体验增强

### 16. 文件编辑未保存提示
| 项目 | 详情 |
|------|------|
| **文件** | `public/js/app.js` + `public/index.html` |
| **新增** | `filesEditorDirty` 脏标记、底部状态栏「⚠️ 有未保存的更改」/「✅ 已保存」、关闭编辑器时弹出确认、Ctrl+S 保存后更新状态 |

### 17. 文件上传 Multipart 支持
| 项目 | 详情 |
|------|------|
| **文件** | `src/core/WebUIServer.js` + `public/js/app.js` |
| **新增** | 后端 `/api/files/upload` multipart 路由（`multer`，最大 50MB，20 个文件）；前端 `FormData` + `XMLHttpRequest` 上传 + 实时进度条；上传后自动清理临时文件 |

---

## 🧠 P4 — 对话记忆与先聊后执行

### 18. Agent 上下文记忆管理
| 项目 | 详情 |
|------|------|
| **文件** | `src/core/WebUIServer.js`, `src/utils/TokenCounter.js`, `public/js/app.js`, `public/index.html`, `public/css/style.css` |
| **新增** | TokenCounter 集成（中×1.5/英×1/代码×0.5 估算），24K 上下文预算（`MAX_CHAT_CONTEXT_TOKENS`），超预算自动截断最早对话（保留首条+最新）；前端进度条实时显示 token 占用（<70%绿/70-90%橙/>90%红） |

### 19. 会话双层持久化
| 项目 | 详情 |
|------|------|
| **文件** | `src/core/WebUIServer.js`, `public/js/app.js` |
| **新增** | 前端 localStorage（`qidi_chat_history`，刷新自动恢复）+ 后端文件 `{configDir}/chat_memory/{sessionId}.json`；新增 `GET/POST /api/chat/sessions` 和 `GET/DELETE /api/chat/sessions/:id` 会话 API |

### 20. 先聊后执行交互模式
| 项目 | 详情 |
|------|------|
| **文件** | `public/js/app.js`, `src/core/WebUIServer.js` |
| **新增** | 对话引导模式：用户先与 Agent 自然语言沟通需求，确认理解无误后再点击「执行任务」触发实际执行（严禁直接发送即执行）；每个聊天请求携带 `sessionId`，服务端自动创建或续接会话 |

---

## 💣 P0 修复

### 21. Provider 透传修复
| 项目 | 详情 |
|------|------|
| **文件** | `src/core/WebUIServer.js`, `src/core/RealTaskExecutor.js` |
| **根因** | WebUIServer 创建 RealTaskExecutor 时未传入 `provider`，导致 AgentFactory.createAll(undefined) → 所有 6 个 Agent 的 provider 均为 undefined → TaskSplitterAgent 调用 `this.provider.chat()` 崩溃 |
| **修复** | 从 AgentHub 首个启用 Agent 获取 `provider` 并显式传入 RealTaskExecutor |
| **影响** | 任务拆分、代码生成、质检、合并等全链路 Agent 均获正常工作 provider |

### 22. CLI 工具授权复用
| 项目 | 详情 |
|------|------|
| **文件** | `src/core/RealTaskExecutor.js` |
| **根因** | RealTaskExecutor._scanTools() 创建独立的 ToolScanner 实例，不继承 WebUI 已注册的授权工具 |
| **修复** | 新增 `toolScanner` 参数透传，_scanTools() 优先复用 WebUI 已授权工具，无外部工具时回退自扫 |
| **影响** | CLI 端不再重复弹出工具授权确认，WebUI 配置的模型和工具自动同步到执行链路 |

---

## 🆕 其他变更

### 23. Agent 身份统一为 QIDI Agent
| 项目 | 详情 |
|------|------|
| **文件** | `src/core/WebUIServer.js`（系统提示词） |
| **变更** | 系统提示词统一使用「QIDI Agent（启迪智能体）」作为正式名称，禁止使用「千问」等模型代称；用户可通过自然语言（如「从现在起你是 Python 专家」）设定临时身份 |

---

## 📊 测试与质量

| 指标 | 数值 |
|------|------|
| **测试总数** | 53 |
| **通过率** | 100%（53/53） |
| **测试耗时** | ~120ms |
| **覆盖模块** | 模块导入(4/4)、Provider(6/6)、TaskRouter(12/12)、ExecutionModeManager(10/10)、ContractAssembler(9/9)、MergeEngine(3/3)、TaskOrchestrator(5/5)、Adapters(3/3)、CLI(1/1) |
| **等级** | S |

---

## 📦 新增依赖

| 包名 | 用途 | 版本 |
|------|------|------|
| `express-rate-limit` | API 速率限制 | — |
| `multer` | Multipart 文件上传 | — |
| `ora` | CLI 进度 spinner | — |

---

## 📝 文档更新

| 文件 | 变更 |
|------|------|
| `CHANGELOG.md` | 新增 P0/P1/P2/P3 全量章节 |
| `docs/NEXT_PLAN.md` | 15 项任务全部标记 ✅ |
| `.env.example` | CORS 默认值、安全说明 |

---

## ⚠️ 注意事项

1. **CORS 默认值变更**：从 `*` 改为 `http://localhost:3000`，生产环境需在 `.env` 中显式配置 `CORS_ALLOW_ORIGIN`
2. **multer 路由顺序**：`/api/files/upload` 在 `express.json()` 之前注册，避免 multipart 解析冲突
3. **临时文件目录**：`tmp/uploads/` 会在首次上传时自动创建

---

## 🔄 升级指南

```bash
# 1. 拉取最新代码
git pull origin main

# 2. 安装新依赖
npm install

# 3. 配置环境变量（如需要）
cp .env.example .env
# 编辑 .env 中的 CORS_ALLOW_ORIGIN 等配置

# 4. 运行测试确认
npm test

# 5. 启动服务
npm run web    # WebUI
npm run cli    # CLI 交互
```

---

**维护者**：QiDi Agent Team  
**下次发布**：关注 Cursor / Windsurf 适配器开发（P2）
