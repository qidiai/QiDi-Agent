# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-26

### Added

- **核心编排引擎**：TaskOrchestrator 完整任务生命周期管理（拆分→执行→质检→合并→报告）
- **双执行模式**：隐私模式（本地 Ollama 拆分/质检）+ 高质量模式（云端 AI 拆分/质检/合并）
- **任务路由引擎**：4 种策略 — round_robin / capability / manual / broadcast
- **契约拼装引擎**：ContractAssembler 支持 7 语言（C/Python/JS/TS/Java/Go/Rust）静态契约提取 + AI 辅助补充
- **代码合并引擎**：MergeEngine 多 Agent 产出合并 + 冲突检测 + 质量评估
- **8 个工具适配器**：Claude Code / Open Code / OpenClaw / Qoder / Hermes Agent / AtomCode / Mimo Code / Trae CN
- **3 个 LLM Provider**：Ollama / OpenAI（兼容 DeepSeek/Groq/GLM）/ Anthropic Claude
- **5 个 AI Agent**：TaskSplitter / CodeWriter / CodeReviewer / Tester / QualityChecker
- **Web 管理界面**：8 页面（Dashboard / 编程控制台 / 工具管理 / 模型管理 / 路由配置 / Token 统计 / 报告中心 / 任务管理）
- **CLI 命令**：run / multi / scan / connect / agents / reports / report / context / web
- **7 种多 Agent 派发模式**：parallel / sequential / select / cascade / merge / privacy / quality
- **工具类**：CacheStore / ContextCompressor / TokenCounter / ModelRouter / MemoryStore / ExperimentReportGenerator
- **自动工具扫描**：ToolScanner 自动检测本机已安装的 AI 编程工具
- **实验报告系统**：自动生成/搜索/对比实验报告
- **会话记忆**：MemoryStore 跨任务历史上下文

### Security

- 路径穿越防护：Web UI `/api/files/view` 使用 `path.resolve` + `startsWith` 边界校验
- 命令注入防护：BaseToolAdapter `_runCommand` 默认 `shell:false` + `escapeShellArg` 参数转义
- 敏感数据保护：`.gitignore` 覆盖 `.env` / `cache/` / `memory/` / `workspace/` / `reports/`

### Fixed

- AnthropicProvider.chat 变量遮蔽：内层 `options` 改名 `reqOptions`
- OpenAIProvider._request 双重 reject：添加 `settled` 守卫确保 Promise 单次 settle
- ContractAssembler._mergeExtracted 字段漏合并：从 3 字段扩展到 9 字段（structs/types/exports/traits/enums/modules）
- ContractAssembler TypeScript 契约提取：interfaces/types 数组未初始化导致 push 异常
- ContractAssembler Go 函数正则：不匹配指针返回类型 `*Service`
- .env.example 缺 Anthropic API 配置项

### Tests

- 综合测试套件：53/53 通过（100%，等级 S）
- 覆盖：模块导入 / Provider / TaskRouter / ExecutionModeManager / ContractAssembler / MergeEngine / TaskOrchestrator / Adapters / CLI / 配置

[1.0.0]: https://github.com/qidi/ai-orchestrator/releases/tag/v1.0.0
