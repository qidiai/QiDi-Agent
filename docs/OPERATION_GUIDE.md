# 启迪 Agent (Qidi) 操作指令大全

> 版本 v1.0.0 | 更新日期 2026-06-28

---

## 一、快速启动

```bash
# 安装依赖
npm install

# 扫描本机 AI 工具
npx qidi scan

# 执行任务（隐私模式，默认）
npx qidi run -t "用Python写一个Web服务器"

# 执行任务（高质量模式）
npx qidi run -t "写一个贪吃蛇游戏" --mode quality

# 启动 Web UI
npx qidi web

# 显示命令指南
npx qidi help
```

---

## 二、全部命令一览

| 命令 | 说明 | 常用示例 |
|------|------|---------|
| `run` | 运行单个代码任务 | `qidi run -t "任务" --mode privacy` |
| `multi` | 多 Agent 并行分派 | `qidi multi -t "任务" -m parallel` |
| `interactive` | 交互式编程界面（REPL） | `qidi interactive --mode quality` |
| `scan` | 扫描本机 AI 编程工具 | `qidi scan --connect --save` |
| `connect` | 连接 AI 编程工具 | `qidi connect --auto` |
| `agents` | 查看/管理 Agent | `qidi agents --check` |
| `check` | 检查 AI 模型连接 | `qidi check -p ollama` |
| `list` | 列出工作目录文件 | `qidi list -d 3` |
| `reports` | 列出实验报告 | `qidi reports -c 20` |
| `report` | 查看指定报告 | `qidi report <id>` |
| `context` | 查看历史上下文 | `qidi context -c 5` |
| `config` | 配置管理 | `qidi config --show` |
| `web` | 启动 Web UI | `qidi web -p 8080` |
| `logs` | 查看日志 | `qidi logs --clean` |
| `version` | 显示版本信息 | `qidi version` |
| `update` | 检查更新 | `qidi update --changelog` |
| `help` | 显示命令指南 | `qidi help` |

---

## 三、命令详细说明

### 3.1 `run` — 运行单个代码任务

```bash
qidi run -t "任务描述" [选项]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-t, --task <desc>` | 任务描述 | — |
| `-m, --mode <mode>` | 执行模式：`privacy` \| `quality` | `privacy` |
| `-p, --provider <name>` | 模型提供商：`ollama` \| `openai` \| `anthropic` | `ollama` |
| `-w, --workspace <dir>` | 工作目录 | `./workspace` |
| `-v, --verbose` | 显示详细日志 | 关闭 |

**示例**：
```bash
# 隐私模式（本地拆分+质检，代码不出本地）
qidi run -t "用Python写一个合并两个有序数组的函数"

# 高质量模式（云端最强模型拆分+质检+AI合并）
qidi run -t "写一个贪吃蛇游戏" --mode quality

# 指定 OpenAI 作为拆分/质检 Provider
qidi run -t "实现一个REST API" --mode quality -p openai

# 详细日志
qidi run -t "写一个爬虫" --verbose
```

---

### 3.2 `multi` — 多 Agent 并行分派

```bash
qidi multi -t "任务描述" [选项]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-t, --task <desc>` | 任务描述 | — |
| `-m, --mode <mode>` | 分派模式（见下表） | `parallel` |
| `-a, --agents <list>` | 指定 Agent 列表（逗号分隔） | 全部 |
| `-w, --workspace <dir>` | 工作目录 | `./workspace` |
| `-v, --verbose` | 显示详细日志 | 关闭 |

**7 种分派模式**：

| 模式 | 说明 |
|------|------|
| `parallel` | 并行派发，所有工具同时执行 |
| `sequential` | 顺序派发，逐个执行 |
| `select` | 选最优结果 |
| `cascade` | 级联（前一结果喂给下一个） |
| `merge` | 全部产出合并 |
| `privacy` | 隐私模式（本地拆分+质检+契约拼装） |
| `quality` | 高质量模式（云端拆分+质检+AI合并） |

**示例**：
```bash
qidi multi -t "实现一个前端页面" -m parallel
qidi multi -t "写一个微服务" -m privacy
qidi multi -t "实现算法" -m cascade -a "claude-code,qoder"
```

---

### 3.3 `scan` — 扫描本机 AI 编程工具

```bash
qidi scan [选项]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-s, --save` | 保存扫描结果到配置文件 | 关闭 |
| `-c, --connect` | 扫描后自动连接 | 关闭 |

**示例**：
```bash
qidi scan                    # 仅扫描
qidi scan --connect          # 扫描并自动连接
qidi scan --connect --save   # 扫描+连接+保存配置
```

**支持的 AI 工具**：Claude Code · Open Code · OpenClaw · Qoder · Hermes Agent · AtomCode · Mimo Code · Trae CN

---

### 3.4 `connect` — 连接 AI 编程工具

```bash
qidi connect [选项]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-a, --auto` | 自动接入所有已发现的工具 | 关闭 |
| `-t, --tool <name>` | 连接指定工具 | — |
| `-s, --scan` | 先扫描再连接 | 关闭 |

**示例**：
```bash
qidi connect --auto          # 自动连接所有已发现工具
qidi connect -t claude-code  # 连接指定工具
qidi connect --scan          # 先扫描再连接
```

---

### 3.5 `agents` — 查看/管理 Agent

```bash
qidi agents [选项]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-l, --list` | 列出所有 Agent | 关闭 |
| `-e, --enable <name>` | 启用 Agent | — |
| `-d, --disable <name>` | 禁用 Agent | — |
| `-c, --check` | 检查所有 Agent 连接状态 | 关闭 |

**示例**：
```bash
qidi agents                  # 查看 Agent 状态
qidi agents --list           # 列出所有 Agent
qidi agents --check          # 检查连接状态
qidi agents --enable claude-code   # 启用
qidi agents --disable qoder        # 禁用
```

---

### 3.6 `check` — 检查 AI 模型连接

```bash
qidi check [选项]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-p, --provider <name>` | 模型提供商 | `ollama` |

**示例**：
```bash
qidi check                   # 检查 Ollama 连接
qidi check -p openai         # 检查 OpenAI 连接
qidi check -p anthropic      # 检查 Anthropic 连接
```

---

### 3.7 `list` — 列出工作目录文件

```bash
qidi list [选项]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-w, --workspace <dir>` | 工作目录 | `./workspace` |
| `-d, --depth <n>` | 显示深度 | `3` |

**示例**：
```bash
qidi list                    # 查看工作目录结构
qidi list -d 5               # 显示更深层级
qidi list -w ./my-project    # 指定目录
```

---

### 3.8 `reports` — 列出实验报告

```bash
qidi reports [选项]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-c, --count <n>` | 显示数量 | `10` |

**示例**：
```bash
qidi reports                 # 查看最近 10 份报告
qidi reports -c 20           # 查看最近 20 份
```

---

### 3.9 `report` — 查看指定报告

```bash
qidi report <id>
```

| 参数 | 说明 |
|------|------|
| `<id>` | 报告 ID |

**示例**：
```bash
qidi report exp_1782583048043
```

---

### 3.10 `context` — 查看历史上下文

```bash
qidi context [选项]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-c, --count <n>` | 显示最近报告数量 | `3` |

**示例**：
```bash
qidi context                 # 查看最近 3 份报告的上下文
qidi context -c 10           # 查看最近 10 份
```

---

### 3.11 `config` — 配置管理

```bash
qidi config [选项]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-s, --show` | 显示当前配置 | 关闭 |
| `-l, --level <level>` | 日志级别：`debug` \| `info` \| `warn` \| `error` | — |

**示例**：
```bash
qidi config --show           # 显示当前配置
qidi config --level debug    # 设置调试日志
```

---

### 3.12 `web` — 启动 Web UI 管理界面

```bash
qidi web [选项]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-p, --port <port>` | 端口号 | `3000` |
| `-H, --host <host>` | 主机地址 | `127.0.0.1` |
| `-w, --workspace <dir>` | 工作目录 | `./workspace` |

**示例**：
```bash
qidi web                     # 启动 Web UI (http://localhost:3000)
qidi web -p 8080             # 指定端口
qidi web -H 0.0.0.0          # 允许外部访问（注意安全）
```

**Web UI 页面**：

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

---

### 3.13 `help` — 显示命令指南

```bash
qidi help
```

输出完整的命令指南，包含所有命令、选项和示例。

---

## 四、执行模式详解

### 🔒 隐私模式 (privacy)

```
任务拆分 → 本地 Ollama（代码不离开本地）
代码生成 → 云端工具各拿碎片（路由分发）
质量检查 → 本地 Ollama 打分（4维）
代码合并 → 契约拼装
```

**适用场景**：敏感代码、合规要求、公司核心代码

### ✨ 高质量模式 (quality)

```
任务拆分 → 云端 API（DeepSeek/Claude 等最强模型）
代码生成 → 云端工具各拿碎片（能力匹配路由）
质量检查 → 云端 AI 打分（6维）
代码合并 → AI 智能合并
```

**适用场景**：追求最佳代码质量、开源项目、非敏感业务

---

## 五、路由策略

| 策略 | 说明 |
|------|------|
| `round_robin` | 轮询分发，每个工具轮流执行 |
| `capability` | 根据语言/框架/复杂度智能匹配最佳工具 |
| `manual` | 通过路由表精确控制每个任务类型去向 |
| `broadcast` | 所有工具都执行（传统模式） |

---

## 六、模型配置

### 本地模型 (Ollama)

```bash
ollama pull qwen2.5:7b      # 拉取模型
ollama serve                  # 启动服务
```

### 云端模型

在 `.env` 文件中配置：

```bash
OLLAMA_MODEL=qwen2.5:7b          # 本地大模型
OPENAI_API_KEY=sk-xxx             # OpenAI
ANTHROPIC_API_KEY=sk-ant-xxx      # Anthropic Claude
DEEPSEEK_API_KEY=sk-xxx           # DeepSeek
```

---

## 七、产出文件位置

| 类型 | 位置 |
|------|------|
| 任务产出代码 | `workspace/<task-id>/` |
| 契约拼装代码 | `workspace/<task-id>/assembled/` |
| 实验报告 | `reports/` |
| 测试报告 | `test/reports/` |
| 会话记忆 | `memory/` |

---

## 八、常见问题

| 问题 | 解决方案 |
|------|---------|
| Web UI 无法访问 | `qidi web -p 8080` 换端口 |
| 工具扫描无结果 | 确认工具已安装：`where claude` / `where qoder` |
| Ollama 连接失败 | `ollama serve` 启动服务 |
| scan 卡住 | 已修复：Trae 等工具使用 spawnSync 超时保护 |
| 云端 API 调用失败 | 检查 `.env` 中 API Key 是否正确 |

---

## 九、npm 脚本速查

| 脚本 | 命令 | 说明 |
|------|------|------|
| `npm start` | `node src/cli/index.js` | 启动 CLI |
| `npm test` | `node test/comprehensive_test.js` | 运行测试 |
| `npm run web` | `node src/cli/index.js web` | 启动 Web UI |
| `npm run cli` | `node src/cli/index.js` | 启动 CLI |
| `npx qidi` | `node src/cli/index.js` | 全局命令 |
