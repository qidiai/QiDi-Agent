[English](./README.md) | [简体中文](./README.zh-CN.md)

# Qidi Agent — 多模型编排，零成本达到顶级模型水准

<p align="center">
  <b>🔒 隐私 · 💰 免费高质量 · 🤖 8 工具并行 · 📋 契约拼装</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D16-brightgreen" alt="Node.js">
  <img src="https://img.shields.io/badge/test-53%2F53%20%28100%25%29-brightgreen" alt="Tests">
</p>

<p align="center">
  <a href="./CONTRIBUTING.md">🤝 贡献指南</a> ·
  <a href="./CODE_OF_CONDUCT.md">📜 行为准则</a> ·
  <a href="./CHANGELOG.md">📋 更新日志</a> ·
  <a href="./LICENSE">⚖️ MIT 许可证</a>
</p>

---

**Qidi** 是一个 AI 编程编排引擎：把复杂任务自动拆分，派发给多个免费的编程 AI 并行实现，再合并成一份完整的高质量代码。

**核心理念**：单个免费模型能力有限，但多个模型各做自己擅长的部分，通过编排+质检+合在一起，最终产出质量可以接近甚至达到国际前 10 大模型的水平——而不需要付它们高昂的 API 费用。

---

## 一分钟开跑

```bash
npm install
npx qidi scan                                   # 自动扫描本机 AI 工具
npx qidi run "用Python写一个Web服务器" --mode privacy   # 隐私模式
npx qidi run "写一个贪吃蛇游戏" --mode quality         # 高质量模式
npx qidi web                                           # Web 管理界面
```

---

## 两个核心模式

### 🔒 隐私模式 — 敏感代码不出本地
任务拆分、质量检查全由本地 Ollama 完成。云端 AI 工具始终只拿到**碎片化的函数签名**（`function processPayment(orderId)`），看不到完整业务逻辑。适合需要合规的场景。

### ✨ 高质量模式 — 多廉价模型协同达到顶级水准
你可以在高质量模式下用多个**免费或廉价**的云端模型（DeepSeek、GLM、Groq 等免费额度）并行实现代码，再通过 AI 质检+智能合并，最终产出质量接近 Claude Opus / GPT-4 等顶级付费模型。

| 模式 | 谁拆分 | 谁写代码 | 谁质检 | 谁合并 | 成本 |
|------|--------|---------|--------|--------|------|
| 🔒 **隐私模式** | 本地 Ollama | 云端工具（各拿一个碎片） | 本地 Ollama | 本地契约拼装 | 零 |
| ✨ **高质量模式** | 云端模型 | 云端工具（按能力匹配） | 云端 AI | AI 智能合并 | 各工具免费+少量 API 费用 |

```
                               ┌─────────────────┐
  "写一个网页爬虫" ───────────→│   任务拆分器     │
                               └────────┬────────┘
                              ┌─────────┼─────────┐
                              ▼         ▼         ▼
                        ┌──────────┐ ┌──────────┐ ┌──────────┐
                        │ 免费模型A │ │ 免费模型B │ │ 免费模型C │
                        │ (爬取部分)│ │ (解析部分)│ │ (存储部分)│
                        └────┬─────┘ └────┬─────┘ └────┬─────┘
                              └─────────┼─────────┘
                                        ▼
                               ┌─────────────────┐
                               │   AI 质检+合并   │ ──→ 一份高质量完整代码
                               └─────────────────┘
```

## 支持的工具

**LLM Provider**（做拆分/质检/合并）：Ollama、OpenAI、Anthropic Claude、DeepSeek、Groq、智谱 GLM

**外部编程工具**（写代码）：Claude Code、Open Code、OpenClaw、Qoder、Hermes Agent、AtomCode、Mimo Code、Trae CN

> 自动扫描本机已安装的工具，也可手动接入新工具。

## CLI 命令

```bash
qidi run   "用Python写一个爬虫"                   # 单任务：扫描+派发+合并
qidi multi "实现一个前端页面" --mode parallel      # 多 Agent 并行（7种模式）
qidi scan                                           # 扫描本机 AI 编程工具
qidi connect <tool>                                 # 连接指定工具
qidi agents --check                                 # 查看 Agent 状态
qidi web                                            # 启动 Web 管理界面
qidi version                                        # 查看版本
qidi logs                                           # 查看日志
```

### 7 种派发模式

```bash
qidi multi -t "任务" -m parallel    # 并行派发
qidi multi -t "任务" -m sequential  # 顺序派发
qidi multi -t "任务" -m select      # 选最优结果
qidi multi -t "任务" -m cascade     # 级联（前一结果喂给下一个）
qidi multi -t "任务" -m merge       # 全部产出合并
qidi multi -t "任务" -m privacy     # 隐私模式（本地拆分+质检+契约拼装）
qidi multi -t "任务" -m quality     # 高质量模式（云端拆分+质检+AI合并）
```

## 路由策略

| 策略 | 说明 |
|------|------|
| `round_robin` | 轮询分发，每个工具只执行部分任务 |
| `capability` | 根据语言/框架/复杂度智能匹配最佳工具 |
| `manual` | 通过路由表精确控制每个任务类型去向 |
| `broadcast` | 所有工具都执行（传统模式） |

## Web UI

启动后访问 http://localhost:3000

| 页面 | 功能 |
|------|------|
| Dashboard | 系统状态概览 |
| Programming Console | 编程控制台（选择模式、执行任务） |
| Tool Management | 工具扫描、连接、启用/禁用 |
| Model Management | 配置 AI 模型、API Key |
| Smart Routing | 配置路由策略、手动路由表 |
| Token Statistics | Token 使用统计 |
| Report Center | 查看报告、搜索、对比 |
| Task Management | 任务历史 |

## 项目结构

```
src/
├── core/         核心编排：TaskOrchestrator · TaskRouter · ContractAssembler · ExecutionModeManager
├── agents/       AI Agent：TaskSplitterAgent · QualityCheckerAgent · MergeEngine
├── adapters/     8 个外部工具适配器
├── providers/    LLM 提供商：OllamaProvider · OpenAIProvider · AnthropicProvider
├── cli/          命令行入口
└── utils/        工具类：缓存 · Token 计数 · 上下文压缩 · 日志 · 版本管理 · 实验报告
```

## 配置

将 `.env.example` 复制为 `.env`：

```bash
OLLAMA_MODEL=qwen2.5:7b        # 本地拆分/质检模型
OLLAMA_MODEL_SMALL=qwen2.5:3b  # 本地小模型
OPENAI_API_KEY=sk-xxx           # OpenAI（高质量模式）
ANTHROPIC_API_KEY=sk-ant-xxx    # Claude（高质量模式）
DEEPSEEK_API_KEY=sk-xxx         # DeepSeek（高质量模式）
```

编辑 `config/agents.json` 配置模型：

```json
{
  "defaultAgent": "ollama",
  "agents": {
    "ollama": {
      "enabled": true,
      "config": { "baseURL": "http://localhost:11434", "model": "qwen2.5:7b" }
    },
    "anthropic": {
      "enabled": false,
      "config": { "apiKey": "${ANTHROPIC_API_KEY}", "model": "claude-3-5-sonnet-20240620" }
    },
    "deepseek": {
      "enabled": false,
      "config": { "apiKey": "${DEEPSEEK_API_KEY}", "baseURL": "https://api.deepseek.com/v1" }
    }
  }
}
```

## 隐私保护原理

1. **拆分在本机**：任务分解逻辑完全本地运行，原始需求不发往任何云端
2. **工具各拿碎片**：每个云端工具只拿到自己模块的函数签名，看不到其他模块
3. **质检可选本地**：隐私模式下使用本地 Ollama 打分，代码不离开电脑
4. **拼装在本机**：收集各模块代码后直接在本地组装运行

## 适用场景

| 场景 | 隐私模式 | 高质量模式 |
|------|---------|-----------|
| 隐私敏感项目（代码不能全发云端） | ⭐⭐⭐⭐⭐ | ⭐ |
| 复杂多模块项目 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 代码审查 / 质量提升 | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 简单脚本 / 单文件 | ⭐⭐⭐⭐ | ⭐⭐ |
| 算法竞赛（多模型投票） | ⭐⭐⭐ | ⭐⭐⭐⭐ |

## 硬件要求

| 配置 | 最低 | 推荐 |
|------|------|------|
| 内存 | 8GB | 32GB+ |
| 显存 | 4GB | 12GB+ |
| 磁盘 | 任意 | SSD |

> 💡 低配也能跑——所有功能在 16GB 内存 + 6GB 显存上测试通过。

## 测试

```bash
npm test      # 31 个冒烟测试，100% 通过
```

## 路线图

- [x] 任务拆分 + 接口契约
- [x] 多工具并行派发（7 种模式）
- [x] 自动扫描本机 AI 工具
- [x] 三层质检（编译 + 扫描 + AI 评分）
- [x] AI 多路代码合并
- [x] 实验报告系统
- [x] Web 管理界面
- [x] 两种执行模式（隐私/高质量）
- [x] Anthropic Claude Provider
- [x] 契约拼装引擎
- [x] 版本管理与日志系统
- [ ] 递归拆分（大任务层层分解）
- [ ] 流式输出 + WebSocket
- [ ] MCP 协议支持
- [ ] 插件系统
- [ ] 团队协作版

## 贡献

欢迎提 Issue 和 PR。

```bash
# 开发模式
npm install
npm test           # smoke test
npm run web        # 启动 Web UI

# 添加新工具适配器
# 1. 创建 src/adapters/YourToolAdapter.js
# 2. 继承 BaseToolAdapter
# 3. 实现 detect() / connect() / execute()
# 4. 在 src/adapters/index.js 中注册
```

## ⚠️ 法律声明

本工具调用第三方 AI 编程工具（Claude Code、Qoder、OpenCode 等）进行代码生成。

**使用条款**：
- 使用本工具产生的代码责任由使用者自负
- 请遵守各工具的使用条款和 EULA
- 本项目不对因使用导致的任何法律问题负责

**用户确认机制**：
- 扫描工具时：每个工具需用户确认是否启用
- 执行任务时：显示将使用的工具列表，用户确认后执行
- 可使用 `--auto-confirm` 参数跳过确认（自动模式）

## License

MIT © 2026 Qidi AI

---

<p align="center">
  <i>免费模型编排 → 顶级代码质量。敏感代码 → 永不出本地。</i>
</p>