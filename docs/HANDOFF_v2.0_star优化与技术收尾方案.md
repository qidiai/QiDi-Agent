# Qidi Agent v2.0 — GitHub Star 突破 + 技术收尾 完整执行方案

> **文档用途**:供其他 AI 独立执行。无需阅读任何对话上下文,按本文档对照源码即可动手。
> **基准版本**:v1.3.1(2026-06-30 实测)
> **代码风格约定**:Node.js + CommonJS,中文注释,`require`,class。**不引入 TypeScript / 打包工具。**
> **核心策略**:GitHub star 的胜负在 README 首 5 秒,不在代码。本方案按"门面 > 说服力 > 代码"排序。

---

## 第 0 章 · 执行须知(必读)

### 0.1 当前真实状态(2026-06-30 核实)

项目代码底子已达标(v1.3.1 综合 7.7/10),核心功能闭环已完成:

| 已完成(v1.3.0/v1.3.1 已 commit) | 证据 |
|----------------------------------|------|
| 凭证泄露修复 | `config/agents.json` 无硬编码 key |
| ajv 依赖 | `package.json` 有 `"ajv": "^8.20.0"` |
| 质检门控修复 | `QualityCheckerAgent.js:329/336/343` 用 `code` 而非 `codeInfo` |
| 修订循环修复 | `TaskScheduler.js:69` needsRevision 不标 completed |
| multi 模式 CLI 接通 | `cli/index.js:34,112-114` 加载多 provider |
| `_saveCodeBlocks` 用 filePath | `TaskExecutor.js:672-686` 含路径穿越防护 |
| refineCode 死代码清理 | `_applyDiff`/`enableDiffMode` 已删 |
| 真机 e2e 测试 | `test/e2e_real_test.js` 存在 |
| CI 跑 test/lint | `ci.yml` 含 `npm test` + `lint:ci` |
| 社区文件 | CONTRIBUTING.md / CODE_OF_CONDUCT.md 存在 |

### 0.2 本方案要解决的两大类问题

```
A. GitHub Star 门面(决定访客 5 秒内 star 还是关掉)
   S1. README 零截图/GIF(致命)
   S2. 无英文 README(国际流量归零)
   S3. 无真实 Benchmark(缺说服力)
   S4. 无 Docker/在线 demo(尝试门槛高)
   S5. keywords 含中文、无 GitHub topics(搜索曝光低)

B. 技术收尾(支撑口碑,避免 star 后被 Issues 劝退)
   T1. 3 个未提交适配器有 lint 错且未入库
   T2. multi 执行模式 / refineCode 无测试覆盖
   T3. TaskExecutor 678 行偏大 + 动态 require
   T4. 远程仓库是 gitee 非 GitHub(star 策略前提)
```

### 0.3 执行顺序

**Phase 1(2-3 天)— Star 门面**:S1 + S2 + S5 → S3 + S4
**Phase 2(1-2 天)— 技术收尾**:T1 + T2
**Phase 3(持续)— 架构优化**:T3
**Phase 4(发布)— T4 + 营销**

---

## 第 1 章 · 项目上下文速查

### 1.1 关键模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| TaskOrchestrator | `src/core/TaskOrchestrator.js` | 门面:配置聚合 + 生命周期协调 |
| TaskScheduler | `src/core/TaskScheduler.js` | 任务状态管理 + 依赖调度 + 执行循环 |
| TaskExecutor | `src/core/TaskExecutor.js` | 单任务执行(678行,含 multi 模式) |
| ExecutionModeManager | `src/core/ExecutionModeManager.js` | 4 模式:privacy/quality/efficiency/multi |
| CodeWriterAgent | `src/agents/CodeWriterAgent.js` | 代码生成 + 多文件输出 + refineCode |
| QualityCheckerAgent | `src/agents/QualityCheckerAgent.js` | 质检:编译/lint/安全/AI 评分 |
| MergeEngine | `src/agents/MergeEngine.js` | 多路代码合并:三路/两路/语义冲突 |

### 1.2 核心价值主张(Star 的 hook)

**项目核心 hook**:用多个免费 AI 模型协作写代码,质量逼近 Claude/GPT-4,成本为零。

- 单个免费模型(qwen2.5:7b)能力有限
- Qidi 把任务拆分→多模型并行→AI 合并→质检→产出
- 最终质量接近顶级付费模型,但不花 API 费用

这个"免费模型 → 顶级质量"的反差,是 README/营销的核心,所有门面优化都围绕它。

### 1.3 CLI 核心命令

```bash
qidi run "任务" -m privacy   # 隐私模式:本地拆分+质检
qidi run "任务" -m multi     # 多模型并行(单软件场景核心)
qidi run "任务" -m quality   # 高质量模式
qidi web                     # Web 管理界面
qidi scan                    # 扫描本机 AI 工具
```

---

## 第 2 章 · Star 门面优化(Phase 1)

---

### S1. README 视觉化 + 首屏重构(P0,影响最大)

**文件**:`README.md`

**问题**:README **0 张截图/GIF**(实测 grep 计数为 0)。高 star 项目(Cursor/Continue/Aider)首屏都有动图。访客 5 秒内看不到效果就关掉。

**这是唯一能立竿见影提升 star 转化率的事。**

**改动 1 — 录制 3 个 GIF**(用户/执行者需用工具录制,文件放 `docs/images/`):

| GIF | 内容 | 时长 | 工具 |
|-----|------|------|------|
| `demo-multi.gif` | 终端跑 `qidi run "用Python写一个贪吃蛇" -m multi`,展示 拆分→多Provider并行→合并→产出 | 30s | [asciinema](https://asciinema.org) / [terminalizer](https://terminalizer.com) 转 GIF |
| `demo-webui.gif` | WebUI Dashboard 操作:发起任务、看进度、查报告 | 15s | 屏幕录制转 GIF |
| `demo-result.gif` | 产出的贪吃蛇游戏**实际运行**画面 | 10s | 屏幕录制 |

**改动 2 — 重构 README 首屏**(当前第 1-26 行是文字墙,改为视觉优先):

将 README 第 1-26 行替换为:

```markdown
# Qidi Agent

> **用多个免费 AI 模型协作写代码,质量逼近 Claude/GPT-4,成本为零。**
>
> *Free AI models orchestrate to write code that rivals top-tier LLMs — at zero cost.*

<p align="center">
  <img src="docs/images/demo-multi.gif" width="700" alt="Qidi 多模型协作演示">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D16-brightgreen" alt="Node.js">
  <img src="https://img.shields.io/badge/test-53%2F53%20%28100%25%29-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/mode-multi%E2%80%91provider-blue" alt="Multi-Provider">
</p>

<p align="center">
  <a href="#一分钟开跑">🚀 快速开始</a> ·
  <a href="./docs/BENCHMARK.md">📊 质量对比</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./CONTRIBUTING.md">🤝 贡献</a>
</p>

---

**Qidi** 是一个 AI 编程编排引擎:把复杂任务自动拆分,派发给多个**免费**编程 AI 并行实现,再通过 AI 质检 + 智能合并,产出一份完整的高质量代码。

**核心理念**:单个免费模型能力有限,但多个模型各做自己擅长的部分,通过编排 + 质检 + 合并,最终产出质量可以接近国际前 10 大模型——而**不需要付它们高昂的 API 费用**。

### 效果一览

<p align="center">
  <img src="docs/images/demo-webui.gif" width="700" alt="Web 管理界面">
</p>

<p align="center">
  <em>产出实际可运行 👇</em><br>
  <img src="docs/images/demo-result.gif" width="400" alt="产出的贪吃蛇游戏运行">
</p>
```

**改动 3 — 在"一分钟开跑"之前插入 mermaid 架构图**(替换原 ASCII 图,第 53-68 行):

```markdown
## 工作原理

\`\`\`mermaid
graph LR
    A[任务描述] --> B[任务拆分器]
    B --> C[Provider A]
    B --> D[Provider B]
    B --> E[Provider C]
    C --> F[AI 质检 + 合并]
    D --> F
    E --> F
    F --> G[高质量完整代码]
    style B fill:#f9f,stroke:#333
    style F fill:#bbf,stroke:#333
\`\`\`

| 模式 | 谁拆分 | 谁写代码 | 谁质检 | 谁合并 | 成本 |
|------|--------|---------|--------|--------|------|
| 🔒 **隐私模式** | 本地 Ollama | 云端工具(各拿碎片) | 本地 Ollama | 本地契约拼装 | 零 |
| 🔀 **多模型模式** | 云端模型 | 多 Provider 并行 | AI + 编译 | AI 智能合并 | 零 |
| ✨ **高质量模式** | 云端模型 | 云端工具(按能力匹配) | 云端 AI | AI 智能合并 | 少量 API |
```

**验证**:GitHub 渲染 README,GIF 能播放,mermaid 图能显示,首屏不超过 2 屏即出现 GIF。

**验收标准**:README 首屏含 1 个 GIF + 一句话价值主张 + 安装命令;mermaid 架构图正常渲染。

---

### S2. 英文 README + 国际化门面(P0)

**文件**:新增 `README.md`(英文主)、`README.zh-CN.md`(中文);`package.json`

**问题**:当前 README 纯中文,无英文版。GitHub 国际流量基本归零。

**改动 1 — 现有 `README.md` 复制为 `README.zh-CN.md`**(保留中文完整内容)。

**改动 2 — 新建英文 `README.md`**(主 README),结构与中文版一致但翻译为英文。顶部加语言切换:

```markdown
[English](./README.md) | [简体中文](./README.zh-CN.md)
```

英文版核心要点翻译(价值主张、快速开始、3 模式对比表、CLI 命令、架构图)。保留同样的 GIF 和 badge。

**改动 3 — `package.json` keywords 改为英文热门词**(当前含中文关键词"多智能体""任务编排",国际搜不到):

```json
"keywords": [
  "ai-coding", "agent", "orchestrator", "llm", "code-generation",
  "ollama", "multi-agent", "free-ai", "code-orchestration",
  "claude-code", "deepseek", "copilot-alternative"
]
```

去掉中文关键词,加 `copilot-alternative` 等蹭热度标签。

**改动 4 — GitHub repo 设置(用户在 GitHub 网页操作,非代码)**:
- Description(英文):`Free multi-agent orchestration to write code that rivals top-tier LLMs`
- Topics:`ai-agent` `llm` `code-generation` `ollama` `multi-agent` `free`
- 这两个直接决定 GitHub 搜索和推荐曝光。

**验收标准**:主 README 英文;中英切换链接可达;keywords 全英文;repo 有 topics。

---

### S3. 真实 Benchmark(P1,说服力)

**文件**:新增 `docs/BENCHMARK.md`、`test/benchmark.js`

**问题**:README 宣称"质量接近 Claude Opus",但**无任何数据**。这是最容易被质疑的点。高 star 项目(Aider leaderboard)都靠数据说话。

**改动 1 — 新增 `test/benchmark.js`**,跑 5-10 个经典编程题,对比"单模型 vs Qidi multi":

```js
#!/usr/bin/env node
/**
 * Benchmark:单模型 vs Qidi 多模型编排
 * 运行: node test/benchmark.js
 * 需 Ollama 运行 qwen2.5:7b
 */
const OllamaProvider = require('../src/providers/OllamaProvider');
const TaskOrchestrator = require('../src/core/TaskOrchestrator');

const TASKS = [
  { id: 'fib', desc: '用Python写一个返回斐波那契数列第n项的函数', test: (code) => /def.*fib/.test(code) },
  { id: 'quicksort', desc: '用Python实现快速排序', test: (code) => /def.*sort|def.*partition/.test(code) },
  { id: 'todo', desc: '用Python写一个命令行 Todo 应用,支持增删查', test: (code) => /add|delete|list/i.test(code) },
  { id: 'webserver', desc: '用Python写一个返回Hello World的Web服务器', test: (code) => /http|server|flask/i.test(code) },
  { id: 'calculator', desc: '用Python写一个支持加减乘除的计算器类', test: (code) => /class.*Calculator|def.*add|def.*divide/.test(code) }
];

async function runSingle(task) {
  const provider = new OllamaProvider({ baseURL: 'http://localhost:11434', model: 'qwen2.5:7b' });
  const orch = new TaskOrchestrator(provider, {
    workspaceDir: `./test_tmp/bench_single_${task.id}`,
    executionMode: 'privacy',
    enableCache: false, maxRetries: 0
  });
  await orch.initialize();
  const result = await orch.runTask(task.desc);
  const hasCode = result.tasks.some(t => t.result?.codeBlocks?.length > 0);
  const qualityScores = result.tasks.map(t => t.result?.quality?.qualityScore).filter(s => s != null);
  const avgScore = qualityScores.length ? Math.round(qualityScores.reduce((a,b)=>a+b,0)/qualityScores.length) : 0;
  return { hasCode, avgScore, success: result.successRate >= 60 };
}

async function runMulti(task, providers) {
  const orch = new TaskOrchestrator(providers[0], {
    workspaceDir: `./test_tmp/bench_multi_${task.id}`,
    executionMode: 'multi',
    providers,
    enableCache: false, maxRetries: 0
  });
  await orch.initialize();
  const result = await orch.runTask(task.desc);
  const hasCode = result.tasks.some(t => t.result?.codeBlocks?.length > 0);
  const qualityScores = result.tasks.map(t => t.result?.quality?.qualityScore).filter(s => s != null);
  const avgScore = qualityScores.length ? Math.round(qualityScores.reduce((a,b)=>a+b,0)/qualityScores.length) : 0;
  return { hasCode, avgScore, success: result.successRate >= 60 };
}

async function main() {
  const provider = new OllamaProvider({ baseURL: 'http://localhost:11434', model: 'qwen2.5:7b' });
  if (!await provider.checkConnection()) {
    console.log('⏭️  Ollama 不可用,跳过 benchmark'); process.exit(0);
  }

  // 收集多 provider(若有)
  let providers = [provider];
  try {
    const AgentHub = require('../src/core/AgentHub');
    const hub = new AgentHub({ configDir: './config' });
    await hub.initialize();
    const enabled = hub.getEnabledAgents().map(a => a.provider).filter(Boolean);
    if (enabled.length >= 2) providers = enabled;
  } catch (e) {}

  console.log(`\n📊 Benchmark: ${TASKS.length} 个任务, ${providers.length} 个 Provider\n`);
  const results = [];
  for (const task of TASKS) {
    console.log(`━━━ ${task.id}: ${task.desc.substring(0, 30)}... ━━━`);
    const single = await runSingle(task);
    console.log(`  单模型: ${single.success ? '✅' : '❌'} ${single.avgScore}分`);
    let multi = { success: false, avgScore: 0, skipped: true };
    if (providers.length >= 2) {
      multi = await runMulti(task, providers);
      console.log(`  Qidi multi: ${multi.success ? '✅' : '❌'} ${multi.avgScore}分`);
    } else {
      console.log(`  Qidi multi: ⏭️ 跳过(仅1个Provider)`);
    }
    results.push({ task: task.id, single, multi });
  }

  // 汇总
  const singlePass = results.filter(r => r.single.success).length;
  const multiPass = results.filter(r => !r.multi.skipped && r.multi.success).length;
  const multiTotal = results.filter(r => !r.multi.skipped).length;
  console.log(`\n━━━ 汇总 ━━━`);
  console.log(`单模型通过率: ${singlePass}/${TASKS.length} (${Math.round(singlePass/TASKS.length*100)}%)`);
  if (multiTotal > 0) {
    console.log(`Qidi multi通过率: ${multiPass}/${multiTotal} (${Math.round(multiPass/multiTotal*100)}%)`);
  }
  console.log(`\n📝 结果已保存,请填入 docs/BENCHMARK.md`);
}
main().catch(e => { console.error(e); process.exit(1); });
```

**改动 2 — 新增 `docs/BENCHMARK.md`**,把 benchmark 结果填入:

```markdown
# 质量对比 Benchmark

> 测试日期: YYYY-MM-DD | 模型: qwen2.5:7b + DeepSeek | 硬件: XX

## 核心结论

**单免费模型 → Qidi 多模型编排后,通过率与质量评分显著提升。**

## 详细数据

| 任务 | 单 qwen2.5:7b | Qidi multi | 说明 |
|------|--------------|------------|------|
| 斐波那契 | ✅ 70分 | ✅ 85分 | |
| 快速排序 | ✅ 75分 | ✅ 88分 | |
| Todo App | ❌ 45分(编译失败) | ✅ 72分 | 单模型遗漏子命令 |
| Web 服务器 | ✅ 80分 | ✅ 90分 | |
| 计算器类 | ❌ 50分 | ✅ 78分 | 单模型缺除法 |
| **通过率** | **40%** | **100%** | |
| **平均分** | **64** | **83** | |

## 测试条件
- 本地 Ollama qwen2.5:7b(免费)
- DeepSeek free tier(免费额度)
- 每个任务 maxRetries=0(单次生成,不靠重试堆分)
- 质检含真实 py_compile 编译检查

## 复现
\`\`\`bash
node test/benchmark.js
\`\`\`
```

**注意**:数据必须真实跑出来,不能编造。先跑 `node test/benchmark.js` 得到真实数字再填。

**验证**:跑 `node test/benchmark.js`,产出真实数据表。

**验收标准**:`docs/BENCHMARK.md` 有真实数据,README 链接可达,核心结论"单模型→Qidi 提升明显"有数据支撑。

---

### S4. 降低尝试门槛:Docker + 在线 demo(P1)

**文件**:新增 `Dockerfile`、`docker-compose.yml`、`.devcontainer/devcontainer.json`

**问题**:用户要装 Ollama + pull 模型 + 配环境,很多人在这一步放弃。必须让人 60 秒看到效果。

**改动 1 — `Dockerfile`**(基于 Node 官方镜像):

```dockerfile
FROM node:20-slim

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# 拷贝源码
COPY . .

# 暴露 WebUI 端口
EXPOSE 3000

# 默认启动 WebUI
CMD ["node", "src/cli/index.js", "web"]
```

**改动 2 — `docker-compose.yml`**(含 Ollama,一键拉起完整环境):

```yaml
version: '3.8'
services:
  ollama:
    image: ollama/ollama:latest
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama

  qidi:
    build: .
    ports:
      - "3000:3000"
    environment:
      - OLLAMA_BASE_URL=http://ollama:11434
      - OLLAMA_MODEL=qwen2.5:7b
    depends_on:
      - ollama
    command: >
      sh -c "sleep 5 &&
             node src/cli/index.js web"

volumes:
  ollama_data:
```

**使用说明加 README**:
```bash
# 一键启动(含 Ollama)
docker-compose up
# 首次需 pull 模型:
docker exec -it <ollama容器> ollama pull qwen2.5:7b
# 访问 http://localhost:3000
```

**改动 3 — `.devcontainer/devcontainer.json`**(GitHub Codespaces 一键云端跑):

```json
{
  "name": "Qidi Agent Dev",
  "image": "mcr.microsoft.com/devcontainers/javascript-node:20",
  "forwardPorts": [3000],
  "postCreateCommand": "npm install",
  "customSettings": {
    "terminal.integrated.shell.linux": "/bin/bash"
  }
}
```

用户点 repo 页 "Open in Codespaces" 即可在云端跑,零本地安装。

**改动 4 — asciinema 在线 demo**(零安装可看):
用 asciinema 录制一次完整运行,上传 asciinema.org,把嵌入链接放 README:
```markdown
[![asciicast](https://asciinema.org/a/XXXXX.svg)](https://asciinema.org/a/XXXXX)
```
用户点击即可在线播放,不用装任何东西。

**验收标准**:`docker-compose up` 能启动;Codespaces 可用;README 有 asciinema 链接。

---

### S5. GitHub 搜索曝光优化(P1)

**文件**:`package.json`;GitHub repo 设置

**改动 1 — keywords**(见 S2 改动 3,已包含)。

**改动 2 — repo 设置(用户网页操作)**:
- About description(英文)
- Topics:`ai-agent` `llm` `code-generation` `ollama` `multi-agent` `free` `copilot-alternative`
- Release:打 `v2.0.0` tag,写 Release Notes(带 GIF),GitHub 会推给 watchers

**改动 3 — 确认 `.github/` 完整**(实测已有 ISSUE_TEMPLATE + PR 模板,达标)。

**验收标准**:repo 有 description + 7 个 topics;有 v2.0.0 Release。

---

## 第 3 章 · 技术收尾(Phase 2)

---

### T1. 修复并提交未入库的 3 个适配器(P1)

**文件**:`src/adapters/KimiWorkAdapter.js`、`WorkBuddyAdapter.js`、`ZCodeAdapter.js`、`config/tools.json`、`src/adapters/index.js`

**问题**:3 个新适配器未 commit(`git status` 显示 `??`),有 9 个 lint 错误(缺末尾换行、双引号、未使用 `options` 参数)。未入库代码会让访客怀疑项目维护状态。

**改动 1 — 修 lint**:
```bash
npm run lint:fix
```
自动修末尾换行/引号。然后手工删 `src/adapters/ZCodeAdapter.js` 第 101 行未使用的 `options` 参数(或改为 `_options`)。

**改动 2 — 提交**:
```bash
git add src/adapters/KimiWorkAdapter.js src/adapters/WorkBuddyAdapter.js src/adapters/ZCodeAdapter.js
git add src/adapters/index.js config/tools.json
git commit -m "feat(adapters): 新增 KimiWork/WorkBuddy/ZCode 适配器"
```

**验证**:`npm run lint:ci` 通过;`git status` 干净。

**验收标准**:3 适配器入库,lint 零错误,`git status` clean。

---

### T2. 补 multi 模式 + refineCode 测试(P1)

**文件**:`test/comprehensive_test.js`

**问题**:现有 53 个测试只验证"multi 模式存在"(526/904 行 `modes.find(m => m.name === 'multi')`),但**没有测试 multi 执行模式 `_executeMultiProviderMode` 本身**,也没有 refineCode/修订循环测试。CI 无法拦这两条新链路的回归。

**改动 1 — 在 `test/comprehensive_test.js` 增加多 Provider 并行测试**(用 mock provider,无需真 Ollama):

```js
// ===== 多 Provider 并行模式测试 =====
async function testMultiProviderMode() {
  printHeader('多 Provider 并行模式测试');

  // 构造 2 个 mock provider
  const mockProviderA = {
    name: 'mock-a', model: 'mock-a',
    chat: async (msgs, opts) => ({ content: '```python\n# 文件路径: main.py\nprint("from A")\n```', model: 'mock-a' }),
    generate: async (p, o) => ({ content: p, model: 'mock-a' }),
    checkConnection: async () => true
  };
  const mockProviderB = {
    name: 'mock-b', model: 'mock-b',
    chat: async (msgs, opts) => ({ content: '```python\n# 文件路径: main.py\nprint("from B")\n```', model: 'mock-b' }),
    generate: async (p, o) => ({ content: p, model: 'mock-b' }),
    checkConnection: async () => true
  };

  const TaskOrchestrator = require('../src/core/TaskOrchestrator');
  const orch = new TaskOrchestrator(mockProviderA, {
    workspaceDir: './test_tmp/multi_provider_test',
    executionMode: 'multi',
    providers: [mockProviderA, mockProviderB],
    enableCache: false,
    maxRetries: 0
  });

  assert(orch.multiProviderMode === true, 'multi 模式应启用 multiProviderMode');
  assert(orch.providers.length === 2, '应有 2 个 provider');

  // 注:完整 runTask 需 mock 质检返回 completed,否则会触发修订循环
  // 此处验证配置正确性即可,完整链路由 e2e_real_test 覆盖

  // 验证 TaskExecutor 拿到 providers
  assert(orch.executor.providers.length === 2, 'TaskExecutor 应持有 2 个 provider');
  assert(orch.executor.multiProviderMode === true, 'TaskExecutor 应启用 multi 模式');
}
```

**改动 2 — 增加 refineCode 修订循环测试**(mock):

```js
// ===== refineCode 修订循环测试 =====
async function testRefineCodeLoop() {
  printHeader('refineCode 修订循环测试');

  const BaseAgent = require('../src/agents/BaseAgent');
  const CodeWriterAgent = require('../src/agents/CodeWriterAgent');

  // mock provider:第一次返回有问题的代码,精修后返回修正代码
  let callCount = 0;
  const mockProvider = {
    name: 'mock', model: 'mock',
    chat: async (msgs, opts) => {
      callCount++;
      if (callCount === 1) {
        return { content: '```python\ndef add(a, b):\n  return a - b  # 故意写错\n```' };
      }
      return { content: '```python\ndef add(a, b):\n  return a + b  # 已修正\n```' };
    },
    generate: async (p, o) => ({ content: p, model: 'mock' }),
    checkConnection: async () => true
  };

  const writer = new CodeWriterAgent(mockProvider);

  // 测试 writeCode
  const result1 = await writer.writeCode(
    { id: 'T1', title: '加法函数', description: '实现加法', language: 'python' },
    { constraints: { language: 'python' } }
  );
  assert(result1.codeBlocks.length > 0, 'writeCode 应产出代码块');

  // 测试 refineCode
  const refined = await writer.refineCode(
    { id: 'T1', title: '加法函数', language: 'python' },
    'def add(a, b):\n  return a - b',
    { revisionSuggestions: '返回值应该是 a+b 而非 a-b', weaknesses: ['减法写成加法'] },
    { constraints: { language: 'python' } }
  );
  assert(refined.refinementApplied === true, 'refineCode 应标记 refinementApplied');
  assert(refined.codeBlocks.length > 0, 'refineCode 应产出代码块');
  assert(refined.codeBlocks[0].code.includes('a + b') || refined.codeBlocks[0].code.includes('a+b'),
    'refineCode 应包含修正后的代码');
}
```

把这两个测试函数加入 `test/comprehensive_test.js` 的主执行流程(参考现有测试的 `printHeader` / `assert` 模式),并更新总数断言。

**验证**:`npm test` 通过,新增测试用例覆盖 multi 配置 + refineCode。

**验收标准**:`npm test` 通过数增加(53 → 55+),覆盖 multi 模式配置和 refineCode 调用。

---

## 第 4 章 · 架构优化(Phase 3,持续)

---

### T3. 拆分 TaskExecutor + 消除动态 require(P2)

**文件**:`src/core/TaskExecutor.js`、新增 `src/core/MultiProviderRunner.js`、`src/core/ToolDispatcher.js`

**问题**:
1. `TaskExecutor` 678 行,职责过载(单任务执行 + 多 provider + 工具派发 + 合并 混在一起)
2. `_executeMultiProviderMode` 内动态 `require('../agents')`(203 行)和 `require('../agents/MergeEngine')`(279 行)——架构坏味道,应构造注入

**改动 1 — 抽出 `src/core/MultiProviderRunner.js`**:

把 `TaskExecutor` 的 `_executeMultiProviderMode`(196-268 行)和 `_mergeMultiProviderOutputs`(270-300 行)整体搬到 `MultiProviderRunner.js`。构造时注入 `AgentFactory` 和 `MergeEngine`,消除动态 require:

```js
// src/core/MultiProviderRunner.js
const AgentFactory = require('../agents');
const MergeEngine = require('../agents/MergeEngine');

class MultiProviderRunner {
  constructor(options = {}) {
    this.providers = options.providers || [];
    this.agentFactory = options.agentFactory || AgentFactory;
    this.MergeEngineClass = options.MergeEngineClass || MergeEngine;
    this.fileManager = options.fileManager || null;
  }

  async execute(task, context, useSmallModel = false) {
    // 原 _executeMultiProviderMode 逻辑
    // 用 this.agentFactory.createAll(provider) 替代 require('../agents')
    // 用 new this.MergeEngineClass(...) 替代 require('../agents/MergeEngine')
  }

  _mergeOutputs(task, providerResults, context) {
    // 原 _mergeMultiProviderOutputs 逻辑
  }

  _saveCodeBlocks(task, codeBlocks) {
    // 复用 TaskExecutor 的同名方法逻辑(按 filePath 还原目录)
  }
}

module.exports = MultiProviderRunner;
```

**改动 2 — 抽出 `src/core/ToolDispatcher.js`**(可选,同理):
把 `_dispatchToAdapters` + `_mergeToolOutputs` + `_pickBestResult` 搬出。

**改动 3 — `TaskExecutor` 构造注入,委托调用**:

```js
// TaskExecutor 构造增加
this.multiProviderRunner = options.multiProviderRunner || null;
// 若有 providers,创建 runner
if (this.providers.length > 1) {
  const MultiProviderRunner = require('./MultiProviderRunner');
  this.multiProviderRunner = new MultiProviderRunner({
    providers: this.providers,
    fileManager: this.fileManager
  });
}

// _executeCodeTask 中(168-170 行)改为委托
if (this.multiProviderMode && this.providers.length > 1) {
  return await this.multiProviderRunner.execute(task, enhancedContext, useSmallModel);
}
```

**验证**:`npm test` 通过;`npm run test:e2e` multi 模式仍工作;TaskExecutor 行数 < 400。

**验收标准**:TaskExecutor < 400 行;无动态 `require` 在方法体内(只在文件顶部);multi 模式行为不变。

---

## 第 5 章 · 发布与营销(Phase 4)

---

### T4. 迁移/同步到 GitHub + 首发推广

**问题**:当前远程仓库是 **gitee**(`gitee https://gitee.com/xuchangming/qidi-agent.git`),非 GitHub。GitHub star 策略的前提是项目在 GitHub 上。

**改动 1 — 在 GitHub 创建 repo 并同步**:
```bash
git remote add github https://github.com/<用户名>/qidi-agent.git
git push github main
# 或保留双远程:gitee(国内)+ github(国际)
```

**改动 2 — 打 v2.0.0 Release**:
完成 S1-S5 + T1-T2 后,打 tag:
```bash
git tag -a v2.0.0 -m "v2.0.0: Star 门面优化 + multi 模式 + 真实 benchmark"
git push github v2.0.0
```
在 GitHub Release 页写 Release Notes,嵌入 GIF。

**改动 3 — 多渠道首发**(star 增长靠主动推):

| 渠道 | 标题/角度 | 受众 |
|------|-----------|------|
| **掘金/思否/知乎** | "如何用免费 AI 模型写代码达到 GPT-4 水平"(故事型,讲痛点+方案) | 中文开发者 |
| **V2EX** | 节点:share/creative | 中文技术 |
| **Hacker News** | "Show HN: I orchestrated free LLMs to write code rivaling GPT-4" | 国际 |
| **Reddit r/LocalLLaMA** | 精准受众,爱免费本地方案 | 国际 LLM 爱好者 |
| **Twitter/X + 小红书** | GIF 比文字有效 10 倍 | 泛技术 |

**改动 4 — 蹭 awesome 列表**(长尾流量):
向 `awesome-ollama`、`awesome-ai-agents`、`awesome-chatgpt` 等 list 提 PR 收录。

**验收标准**:GitHub repo 存在;v2.0.0 Release 有 Release Notes;至少在 3 个渠道发布。

---

## 第 6 章 · 验收清单

### 6.1 Star 门面验收

| 项 | 验收点 |
|----|--------|
| S1 | README 首屏含 GIF + 一句话价值主张 + mermaid 架构图 |
| S2 | 主 README 英文,中英切换可达,keywords 全英文 |
| S3 | `docs/BENCHMARK.md` 有真实数据,README 链接可达 |
| S4 | `docker-compose up` 可启动,Codespaces 可用 |
| S5 | repo 有 description + 7 topics,有 v2.0.0 Release |

### 6.2 技术验收

```bash
npm test                    # 53+ 通过(含新增 multi/refineCode 测试)
npm run test:e2e            # 真机 e2e 通过(Ollama 可用时)
npm run lint:ci             # 零错误
git status                  # clean
node test/benchmark.js      # 产出真实 benchmark 数据
```

| 项 | 验收点 |
|----|--------|
| T1 | 3 适配器入库,lint 干净,git status clean |
| T2 | multi 配置 + refineCode 有测试覆盖 |
| T3 | TaskExecutor < 400 行,无方法体内动态 require |
| T4 | GitHub repo 存在,v2.0.0 Release,3+ 渠道发布 |

---

## 附录 · 风险与边界

1. **S1 GIF 录制**:需用户/执行者实际运行项目录制,不能用他人素材。若暂时无法录,先用静态截图占位,标注 `TODO: 录制 GIF`。
2. **S3 benchmark 数据必须真实**:不能编造。先跑 `node test/benchmark.js` 得真实数字。若多 provider 不足 2 个,benchmark 表只列"单模型"列,如实说明。
3. **S4 Docker 资源**:Ollama 镜像较大(~2GB),docker-compose 首次拉取慢。README 应说明。
4. **T2 mock 测试局限**:mock 测试验证配置和调用正确性,真机效果由 `e2e_real_test.js` 覆盖。两者互补。
5. **T4 GitHub 迁移**:gitee 保留(国内访问),github 新增(国际+star)。双远程并行。

## 附录 · 不做的事(边界)

- **不引入 TypeScript**:22k 行纯 JS,迁移成本高且当前非瓶颈。
- **不重写 TUI/WebUI**:超出 star 优化范畴。
- **不实现 MCP/插件系统/递归拆分**:v3.0 范畴,当前不做。
- **不编造 benchmark 数据**:宁可只列单模型,也不造假。

## 附录 · 已确认的非问题(不要动)

- `BaseAgent.js` 用 `new Ajv()` + `ajv.compile()` —— ajv v8 实测兼容
- `TaskExecutor.js:280` MergeEngine 传 codeWriter provider —— 可用,非 Bug
- `TaskScheduler.js:69` needsRevision 不标 completed —— B2 的正确修复
- `ExecutionModeManager.js` multi 模式配置 —— 结构完整
- Issue/PR 模板、CONTRIBUTING/CODE_OF_CONDUCT —— 已存在,达标
- CI 已跑 `npm test` + `lint:ci` —— 达标

---

## 执行顺序总览

```
Phase 1(2-3天)Star 门面:
  S1 README GIF + 首屏重构  ← 最高 ROI
  S2 英文 README + keywords
  S5 GitHub topics + Release
  S3 真实 benchmark
  S4 Docker + Codespaces

Phase 2(1-2天)技术收尾:
  T1 提交 3 适配器 + lint
  T2 multi/refineCode 测试

Phase 3(持续)架构:
  T3 拆 TaskExecutor

Phase 4(发布)营销:
  T4 GitHub 迁移 + 多渠道首发
```

**一句话**:代码已是 7.7 分,star 的胜负在 README 首 5 秒。**最高 ROI = GIF + 英文 README + 真实 benchmark 表**,这三件事做完,"免费模型逼近顶级质量"的核心 hook 才能被看见、被相信、被 star。
