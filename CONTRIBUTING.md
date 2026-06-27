# 贡献指南 | Contributing to Qidi Agent

感谢你对启迪 Agent 的关注！Qidi 是一个隐私优先的多 AI 编程工具统一编排与协作平台。

- 🌐 中文 | [English](#english-version)

---

## 快速开始

```bash
git clone <your-fork>
cd ai-orchestrator
npm install
node src/cli/index.js scan    # 扫描本机 AI 工具
npm test                       # 53 个测试，确保全通过
```

---

## 如何贡献

### 报告 Bug

1. 搜索 [已有 Issue](../../issues) 确认未重复
2. 打开新 Issue，选择 **Bug Report** 模板
3. 必须包含：
   - 复现步骤
   - 期望行为 vs 实际行为
   - Node.js 版本、操作系统
   - 相关日志或错误输出

### 建议功能

1. 打开新 Issue，选择 **Feature Request** 模板
2. 描述使用场景和为什么重要
3 - 如果是新增 AI 工具适配器，请附上该工具的 CLI 接口说明

### 提交代码

1. **Fork** 本仓库
2. 从 `main` 创建分支：`git checkout -b feat/my-change`
3. 编写代码并补充测试
4. 运行 `npm test` 确保全通过
5. 按规范提交（见下方 Commit 规范）
6. 推送并打开 **Pull Request**

---

## 分支策略

| 分支 | 用途 | 示例 |
|------|------|------|
| `main` | 稳定发布 | — |
| `feat/<name>` | 新功能 | `feat/mcp-protocol` |
| `fix/<name>` | Bug 修复 | `fix/path-traversal` |
| `refactor/<name>` | 重构 | `refactor/split-orchestrator` |
| `docs/<name>` | 文档 | `docs/add-changelog` |
| `test/<name>` | 测试 | `test/e2e-pipeline` |

**规则**：
- 始终从 `main` 拉出新分支
- 一个 PR 只做一件事（单一职责）
- PR 合并后分支自动删除

---

## Commit Message 规范

采用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type（必填）

| Type | 说明 | 示例 |
|------|------|------|
| `feat` | 新功能 | `feat(router): add load-balance strategy` |
| `fix` | Bug 修复 | `fix(webui): prevent path traversal in file view` |
| `docs` | 文档 | `docs: add CHANGELOG` |
| `style` | 格式（不影响逻辑） | `style: fix indentation` |
| `refactor` | 重构 | `refactor(orchestrator): split into modules` |
| `perf` | 性能 | `perf(cache): add LRU eviction` |
| `test` | 测试 | `test: add e2e pipeline test` |
| `chore` | 构建/工具 | `chore: add GitHub Actions CI` |

### Scope（推荐）

`core` / `agents` / `adapters` / `providers` / `cli` / `webui` / `utils` / `config`

### 示例

```
feat(adapters): add CursorAdapter for Cursor IDE

- Implement detect() via `which cursor`
- Implement execute() with --prompt-file flag
- Register in adapters/index.js

Closes #42
```

---

## PR 流程

1. 打开 PR，填写 **Pull Request 模板**
2. 确保所有检查通过：
   - `npm test` 全绿
   - 无 `console.log` 调试残留
   - 新功能有对应测试
3. 等待至少 1 位 Maintainer 审查
4. 审查通过后 Squash Merge 到 `main`

### PR 规模建议

- ✅ 小 PR（< 300 行变更）：审查快，合并快
- ⚠️ 中 PR（300-800 行）：需详细说明设计意图
- ❌ 大 PR（> 800 行）：建议拆分为多个小 PR

---

## 代码规范

| 项 | 规范 |
|----|------|
| 语言 | JavaScript (ES6+)，Node.js >= 16 |
| 模块 | CommonJS（`require` / `module.exports`） |
| 异步 | `async/await`，避免裸回调 |
| 缩进 | 2 空格 |
| 引号 | 单引号 |
| 命名 | camelCase（变量/函数），PascalCase（类） |
| 安全 | 禁止 `shell:true` + 未转义参数，禁止 `eval()` |
| 路径 | 用 `os.homedir()` / `process.env` / `path.join()`，禁止硬编码绝对路径 |
| 日志 | 使用 `console.log/warn/error`（未来迁移到统一 logger） |
| 测试 | 所有新功能必须包含测试，放在 `test/` 目录 |

---

## 新增 AI 工具适配器

1. 创建 `src/adapters/YourToolAdapter.js`，继承 `BaseToolAdapter`
2. 实现三个核心方法：

```javascript
class YourToolAdapter extends BaseToolAdapter {
  constructor(options = {}) {
    super({ name: 'your-tool', displayName: 'Your Tool', ...options });
    this.command = 'your-tool-cli';
  }

  async detect() {
    // 检测本机是否安装了该工具
    // 返回 boolean
  }

  async connect() {
    // 建立连接/验证可用性
    // 设置 this.detected = true, this.status = 'online'
  }

  async execute(task, options = {}) {
    // 执行任务，返回 { success, code, output }
    // 使用 this._runCommand() 而非直接 spawn
  }
}
```

3. 在 `src/adapters/index.js` 中注册
4. 在 `test/` 中添加测试
5. 更新 README 支持工具列表
6. 提交 PR

**安全要求**：
- ✅ 使用 `this._runCommand()` 执行外部命令（已内置 `shell:false` + 参数转义）
- ❌ 禁止直接 `spawn(cmd, args, { shell: true })`
- ✅ 代码块提取可复用 `BaseToolAdapter._extractCodeBlocks()` 或自行实现正则

---

## 新增 LLM Provider

1. 创建 `src/providers/YourProvider.js`，继承 `BaseProvider`
2. 实现核心接口：

```javascript
class YourProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.name = 'your-provider';
  }

  async chat(messages, options = {}) { /* ... */ }
  async generate(prompt, options = {}) { /* ... */ }
  async checkConnection() { /* ... */ }
}
```

3. 在 `src/providers/index.js` 的 `ProviderFactory` 中注册
4. 在 `.env.example` 中添加对应环境变量
5. 在 `config/agents.json` 中添加默认配置
6. 添加测试 + 更新文档
7. 提交 PR

**接口对齐要求**：
- `chat(messages, options)` 的返回值必须为 `{ content, role, model, usage, raw }`
- `options` 中 `systemPrompt` 应在 Provider 内部处理（注入 messages 或走顶层 system 字段），调用方不应感知差异

---

## 安全贡献

如果你发现了安全漏洞，**请不要在公开 Issue 中报告**。

请发送邮件至：**289700172@qq.com**（占位，替换为实际邮箱）

我们将在 48 小时内确认收到，并在修复后公开致谢。

---

## 许可证声明

提交代码即表示你同意该代码以 **MIT 许可证** 发布。你保留自身版权，但授予项目及其用户 MIT 许可证下的所有权利。

---

## 有问题？

- 💬 [GitHub Discussions](../../discussions)（一般问题）
- 🐛 [GitHub Issues](../../issues)（Bug 和功能请求）
- 📧 289700172@qq.com（其他）

感谢你的贡献！每一个 PR 都让启迪 Agent 更好。 🎉

---

<a id="english-version"></a>

## English Version

Thanks for your interest in contributing to Qidi Agent!

### Quick Start

```bash
git clone <your-fork>
cd ai-orchestrator
npm install
node src/cli/index.js scan
npm test   # 53 tests, all must pass
```

### Submit Code

1. Fork → branch from `main` → code → test → PR
2. Follow [Conventional Commits](https://www.conventionalcommits.org/)
3. One PR = one concern
4. All tests must pass

### Add a New Adapter

1. Create `src/adapters/YourAdapter.js` extending `BaseToolAdapter`
2. Implement `detect()`, `connect()`, `execute()`
3. Use `this._runCommand()` — never `spawn(..., { shell: true })` directly
4. Register in `src/adapters/index.js`
5. Add tests, update README, submit PR

### Add a New Provider

1. Create `src/providers/YourProvider.js` extending `BaseProvider`
2. Implement `chat()`, `generate()`, `checkConnection()`
3. Return format: `{ content, role, model, usage, raw }`
4. Register in `src/providers/index.js`, add `.env.example` entry
5. Add tests, update docs, submit PR

### Security

Report vulnerabilities to **289700172@qq.com** — do NOT open public Issues.

### License

By submitting, you agree your code is licensed under MIT.
