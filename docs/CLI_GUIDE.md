# CLI 使用指南 | Qidi Agent Command Line Interface

> 版本 v1.0.0 · 更新日期 2026-06-28

本指南覆盖 Qidi Agent 命令行界面（CLI）的全部用法，重点是 **交互式编程界面（REPL）**。

---

## 目录

1. [环境准备](#一环境准备)
2. [一键启动](#二一键启动)
3. [交互式 REPL（interactive）](#三交互式-replinteractive)
4. [单次任务（run）](#四单次任务run)
5. [多 Agent 分派（multi）](#五多-agent-分派multi)
6. [工具扫描与连接](#六工具扫描与连接)
7. [报告与上下文](#七报告与上下文)
8. [配置与日志](#八配置与日志)
9. [常见问题](#九常见问题)

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
| `-m, --mode` | 默认执行模式 `privacy` / `quality` | `privacy` |
| `-p, --provider` | 默认模型提供商 `ollama` / `openai` / `anthropic` | `ollama` 或 `$MODEL_PROVIDER` |
| `-w, --workspace` | 工作目录 | `./workspace` |

### 命令一览

| 命令 | 作用 |
|------|------|
| `scan` | 扫描并接入本机 AI 编程工具 |
| `tools` | 查看已接入工具 |
| `status` | 查看当前模式/提供商/工具/工作目录 |
| `mode privacy` / `mode quality` | 切换执行模式 |
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
| `-m, --mode` | 执行模式 `privacy` / `quality` | `privacy` |
| `-p, --provider` | 模型提供商 | `ollama` 或 `$MODEL_PROVIDER` |
| `-w, --workspace` | 工作目录 | `./workspace` |
| `-v, --verbose` | 显示详细日志 | false |

示例：

```bash
qidi run -t "写一个贪吃蛇游戏" --mode quality
qidi run -t "REST API" -p openai -v
```

---

## 五、多 Agent 分派（multi）

```bash
qidi multi -t "任务" -a ollama,openai -m parallel
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-t, --task` | 任务描述 | - |
| `-a, --agents` | Agent 列表（逗号分隔） | - |
| `-m, --mode` | 分派模式 `parallel` / `sequential` / `select` / `cascade` / `merge` / `privacy` / `quality` | `parallel` |
| `-w, --workspace` | 工作目录 | `./workspace` |
| `-v, --verbose` | 详细日志 | false |

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

## 九、常见问题

### Q：交互式界面里输入任务没反应？

A：检查 Ollama 是否运行（`ollama serve`），或切换提供商 `provider openai` 并配置 API Key。

### Q：多行模式卡住了怎么退出？

A：输入 `.cancel` 取消，或按 Ctrl+C。

### Q：上下文记忆在哪里？

A：`~/.qidi/session.json`（任务/报告记忆）和 `~/.qidi/history`（命令历史）。删除即可清空。

### Q：如何查看任务生成的文件？

A：在 REPL 中 `ls` 列出工作目录，`view <相对路径>` 查看内容；或启动 `qidi web` 在浏览器中查看。

### Q：隐私模式和高质量模式区别？

- **隐私模式** 🔒：任务拆分、质检都在本地（Ollama），数据不离开本机，适合敏感代码
- **高质量模式** ✨：使用云端最强模型拆分和质检，6 维评分 + AI 合并，质量更高但消耗 Token
