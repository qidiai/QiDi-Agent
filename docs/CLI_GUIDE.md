# CLI 使用指南 | Qidi Agent Command Line Interface

> 版本 v1.3.0 · 更新日期 2026-06-29

本指南覆盖 Qidi Agent 命令行界面（CLI）的全部用法，重点是 **交互式编程界面（REPL）**。

---

## 目录

1. [环境准备](#一环境准备)
2. [一键启动](#二一键启动)
3. [交互式 REPL（interactive）](#三交互式-replinteractive)
4. [单次任务（run）](#四单次任务run)
5. [多模型并行模式（multi）](#五多模型并行模式multi)
6. [工具扫描与连接](#六工具扫描与连接)
7. [报告与上下文](#七报告与上下文)
8. [配置与日志](#八配置与日志)
9. [执行模式详解](#九执行模式详解)
10. [常见问题](#十常见问题)

---

## 一、环境准备

```bash
# Node.js >= 16
node -v

# 安装依赖
npm install

# （可选）配置环境变量
cp .env.example .env
# 编辑 .env 设置 OPENAI_API_KEY / MODEL_PROVIDER 等
```

启动本地模型（推荐隐私模式）：

```bash
ollama serve          # 启动 Ollama 服务
ollama pull qwen2.5:7b  # 拉取本地模型
```

---

## 二、一键启动

```bash
# 扫描本机已安装的 AI 编程工具
npx qidi scan --connect --save

# 启动交互式界面（推荐）
npx qidi interactive

# 或直接执行单次任务
npx qidi run -t "用 Python 写一个 Web 服务器"
```

---

## 三、交互式 REPL（interactive）

`qidi interactive`（别名 `qidi i`）启动一个常驻的交互式编程界面，支持多行输入、命令历史、上下文记忆。

### 启动

```bash
qidi interactive                            # 默认隐私模式 + ollama
qidi interactive --mode quality             # 默认高质量模式
qidi interactive --provider openai          # 默认使用 OpenAI
qidi interactive -w ./myworkspace           # 指定工作目录
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-m, --mode` | 默认执行模式 `privacy` / `quality` / `multi` | `privacy` |
| `-p, --provider` | 默认模型提供商 `ollama` / `openai` / `anthropic` | `ollama` 或 `$MODEL_PROVIDER` |
| `-w, --workspace` | 工作目录 | `./workspace` |

### 命令一览

| 命令 | 作用 |
|------|------|
| `scan` | 扫描并接入本机 AI 编程工具 |
| `tools` | 查看已接入工具 |
| `status` | 查看当前模式/提供商/工具/工作目录 |
| `mode privacy` / `mode quality` / `mode multi` | 切换执行模式 |
| `provider ollama` / `provider openai` | 切换默认提供商 |
| `<任务描述>` 或 `run <任务描述>` | 执行编程任务 |
| `tasks` | 查看最近任务历史 |
| `reports` | 查看最近报告 ID |
| `report <id>` | 查看报告内容 |
| `context` / `ctx` | 查看上下文记忆 |
| `ls [dir] [depth]` | 列出工作目录文件 |
| `view <path>` | 查看工作目录中的文件（带行号，最多 200 行） |
| `pwd` | 显示当前工作目录 |
| `history` | 查看命令历史 |
| `reset` | 重置上下文记忆 |
| `clear` / `cls` | 清屏 |
| `help` / `h` / `?` | 显示帮助 |
| `exit` / `quit` / `q` | 退出（自动保存上下文） |

### 多行任务输入

任务描述较长时，在末尾加 `;` 触发多行模式：

```
qidi> 用 Python 写一个完整的博客系统;
  ...> 需求：
  ...> 1. 文章 CRUD
  ...> 2. 用户登录
  ...> 3. SQLite 存储
  ...> 4. 提供 README
  ...> ;           ← 空行或 ; 提交
```

- 进入多行模式后提示符变为 `...>`
- 输入空行或单独的 `;` 提交任务
- 输入 `.cancel` 放弃当前多行输入

### 命令历史与上下文记忆

- **命令历史**：持久化到 `~/.qidi/history`（最多 200 条），方向键 ↑↓ 可翻阅
- **上下文记忆**：最近任务、最近报告 ID 持久化到 `~/.qidi/session.json`
- 启动时会显示上次任务和最近报告，便于接续工作
- `reset` 命令清空上下文记忆（不影响工作目录文件）

### Tab 补全

输入命令前缀按 Tab 自动补全，例如输入 `sc` + Tab → `scan`。

### Ctrl+C 行为

- 第一次 Ctrl+C：取消当前输入或正在运行的任务
- 第二次 Ctrl+C：退出 REPL（自动保存上下文）

### 任务执行反馈

任务运行期间会显示实时进度：

```
qidi> 用 C 写贪吃蛇
  🚀 开始执行 (🔒 隐私模式)

  ⠋ 拆分任务...
  ⠙ 执行子任务 2/5...
  ⠹ 子任务完成...
  ✅ 任务完成！

  ═══ 任务总结 ═══
  成功率: 100% (5/5)
  输出目录: /path/workspace/task_xxx
  报告 ID: exp_1782583048043
  子任务:
    ✅ task_1 写主程序
    ✅ task_2 实现游戏循环
    ...

  📁 产出文件 (预览):
    📄 task_xxx/main.c (2.3KB)
    📄 task_xxx/README.md (0.8KB)
  输入 view <路径> 查看内容
```

---

## 四、单次任务（run）

```bash
qidi run -t "任务描述" [选项]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-t, --task` | 任务描述（不传则交互式询问） | - |
| `-m, --mode` | 执行模式 `privacy` / `quality` / `multi` | `privacy` |
| `-p, --provider` | 模型提供商 | `ollama` 或 `$MODEL_PROVIDER` |
| `-w, --workspace` | 工作目录 | `./workspace` |
| `-v, --verbose` | 显示详细日志 | false |

示例：

```bash
qidi run -t "写一个贪吃蛇游戏" --mode quality
qidi run -t "REST API" -p openai -v
qidi run -t "创建待办事项应用" --mode multi   # 多模型并行模式
```

---

## 五、多模型并行模式（multi）

**多模型并行模式**（`multi`）是 v1.3.0 新增的执行模式，在无外部编程工具时，使用多个 LLM Provider 并行生成代码，通过 MergeEngine 智能合并结果，提升代码质量。

### 工作流程

```
用户任务 → 智能拆分 → 多Provider并行生成 → 结果合并 → 质量检查 → 精修循环 → 最终输出
```

### 启用方式

```bash
# 方式一：启动时指定模式
qidi interactive --mode multi
qidi run -t "任务" --mode multi

# 方式二：在交互式界面中切换
qidi> mode multi
```

### 配置要求

需要在 `config/agents.json` 中启用多个 Agent：

```json
{
  "agents": {
    "ollama": {
      "enabled": true,
      "provider": "ollama",
      "config": {
        "baseURL": "http://localhost:11434",
        "model": "qwen2.5:7b"
      }
    },
    "deepseek": {
      "enabled": true,
      "provider": "openai",
      "config": {
        "apiKey": "${DEEPSEEK_API_KEY}",
        "baseURL": "https://api.deepseek.com/v1",
        "model": "deepseek-chat"
      }
    }
  }
}
```

### 执行效果

```
qidi> mode multi
✅ 切换到 🔀 多模型并行模式

qidi> 创建一个待办事项应用
  🚀 开始执行 (🔀 多模型并行模式)
  🔄 并行执行: Ollama 本地模型, DeepSeek
  ⠋ Provider 1/2 生成中...
  ⠙ Provider 2/2 生成中...
  ✅ 多Provider执行完成
  🔀 合并结果...
  ⠋ 质量检查...
  ✅ 任务完成！

  ═══ 任务总结 ═══
  成功率: 100% (5/5)
  输出目录: /path/workspace/task_xxx
  报告 ID: exp_1782583048043
  精修次数: 1
  合并来源: Ollama, DeepSeek
```

### 模式特性

| 特性 | 说明 |
|------|------|
| 代码生成 | 广播到所有启用的 Provider 并行生成 |
| 结果合并 | 使用 MergeEngine 智能合并，取各模型之长 |
| 质量检查 | 本地 Ollama 快速初筛 + 静态代码分析 |
| 精修循环 | 质量不通过时自动精修（最多 2 次） |
| 路由策略 | broadcast（广播） |
| 并行限制 | 默认 3 个 Provider |

---

## 六、工具扫描与连接

```bash
qidi scan --connect --save      # 扫描 + 自动连接 + 保存结果
qidi connect --auto             # 自动连接所有已发现工具
qidi connect -t claude-code     # 连接指定工具
qidi agents --check             # 检查所有 Agent 连接状态
qidi agents --enable openai     # 启用某 Agent
qidi agents --disable openai    # 禁用某 Agent
```

---

## 七、报告与上下文

```bash
qidi reports              # 列出最近 10 个报告
qidi reports -c 30        # 列出最近 30 个
qidi report exp_xxxxx     # 查看指定报告
qidi context              # 查看历史上下文
qidi context -c 5         # 最近 5 个报告的上下文
```

---

## 八、配置与日志

```bash
qidi config --show                 # 显示当前配置
qidi config --level debug         # 设置日志级别
qidi logs                         # 日志统计
qidi logs --clean                 # 清理 7 天前的日志
qidi version                      # 版本信息
qidi update --changelog           # 查看更新日志
qidi web -p 8080                  # 启动 Web UI
```

---

## 九、执行模式详解

Qidi Agent 支持三种执行模式，可根据需求灵活切换：

### 模式对比

| 特性 | 🔒 隐私模式 (`privacy`) | ✨ 高质量模式 (`quality`) | 🔀 多模型并行模式 (`multi`) |
|------|------------------------|--------------------------|---------------------------|
| 代码生成 | 本地 Ollama | 云端 API | 多 Provider 并行 |
| 任务拆分 | 本地 Ollama | 云端最强模型 | 云端最强模型 |
| 质量检查 | 本地工具链 | 云端 AI 质检 + 工具链 | 本地工具链 + 静态分析 |
| 结果合并 | 简单合并 | AI 智能合并 | MergeEngine 智能合并 |
| 数据安全性 | 最高（不离开本机） | 中等（云端处理） | 中等（部分云端） |
| 代码质量 | 中等 | 最高 | 高（取各模型之长） |
| Token 消耗 | 无 | 高 | 中等 |
| 适用场景 | 敏感代码、离线开发 | 复杂项目、高质量需求 | 无外部工具、提升质量 |
| 路由策略 | round_robin | capability | broadcast |

### 模式切换

```bash
# 在交互式界面中切换
qidi> mode privacy     # 🔒 隐私模式
qidi> mode quality     # ✨ 高质量模式
qidi> mode multi       # 🔀 多模型并行模式

# 启动时指定
qidi interactive --mode privacy
qidi run -t "任务" --mode multi
```

### 智能模式推荐

系统会根据任务描述中的关键词自动推荐模式：

| 关键词 | 推荐模式 |
|--------|----------|
| 隐私、敏感、保密、离线 | `privacy` |
| 高质量、精细、专业、复杂 | `quality` |
| 效率、并行、分布式、多工具 | `multi` |

---

## 十、常见问题

### Q：交互式界面里输入任务没反应？

A：检查 Ollama 是否运行（`ollama serve`），或切换提供商 `provider openai` 并配置 API Key。

### Q：多行模式卡住了怎么退出？

A：输入 `.cancel` 取消，或按 Ctrl+C。

### Q：上下文记忆在哪里？

A：`~/.qidi/session.json`（任务/报告记忆）和 `~/.qidi/history`（命令历史）。删除即可清空。

### Q：如何查看任务生成的文件？

A：在 REPL 中 `ls` 列出工作目录，`view <相对路径>` 查看内容；或启动 `qidi web` 在浏览器中查看。

### Q：三种执行模式有什么区别？

| 模式 | 特点 | 适用场景 |
|------|------|----------|
| 🔒 隐私模式 | 数据不离开本机，安全最高 | 敏感代码、离线开发 |
| ✨ 高质量模式 | 云端最强模型，质量最高 | 复杂项目、高质量需求 |
| 🔀 多模型并行 | 多 Provider 并行，取各模型之长 | 无外部工具时提升质量 |

### Q：多模型并行模式需要什么配置？

A：需要在 `config/agents.json` 中启用多个 Agent（至少 2 个），例如同时启用 Ollama 和 DeepSeek。

### Q：代码质量检查不通过会怎样？

A：系统会自动精修代码，最多重试 2 次。如果仍不通过，会输出 `qualityWarning` 警告并使用当前代码完成任务，防止无限循环。

### Q：如何查看精修历史？

A：任务报告中会记录精修次数和每次的质量评分，使用 `report <id>` 查看详细内容。
