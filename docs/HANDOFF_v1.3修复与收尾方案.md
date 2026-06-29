# Qidi Agent v1.3 — 修复与收尾执行规格书

> **文档用途**:供其他 AI 独立执行。无需阅读任何对话上下文,按本文档对照源码即可动手。
> **基准版本**:v1.2.0(已有一批未 commit 的功能改动,见下)
> **撰写日期**:2026-06-29
> **代码风格约定**:Node.js + CommonJS,中文注释,`require`,class。**不引入 TypeScript / 打包工具。**

---

## 第 0 章 · 执行须知(必读)

### 0.1 项目定位

Qidi Agent 是一个 **AI 编程工具编排层**(不是编程工具本身)。核心链路:

```
任务 → TaskSplitter 拆分 → 派发执行 → QualityChecker 质检 → MergeEngine 合并 → 报告
```

在"只有 qidi-agent 一个软件、无外部编程工具"的场景下,代码生成由 **LLM Provider**(Ollama/OpenAI/DeepSeek 等)完成,而非外部工具。

### 0.2 当前真实状态(2026-06-29 核实)

项目已有一批 **未 commit 的功能改动**(22 个文件 modified)。这批改动已实现了以下功能,**不要重做**:

| 功能 | 状态 | 实现位置 |
|------|------|----------|
| 凭证泄露修复 | ✅ 已做 | `config/agents.json` DeepSeek key 已移除 |
| ajv 依赖 | ✅ 已做 | `package.json` 已加 `"ajv": "^8.20.0"`(实测兼容) |
| 质检崩溃修复 | ✅ 已做 | `QualityCheckerAgent.js:303` 重新声明 codeInfo |
| 修订循环修复 | ✅ 已做 | `TaskScheduler.js:69` needsRevision 不标 completed;`TaskExecutor.js:113-136` maxRetries 收敛 |
| 多文件结构化输出 | ✅ 已做 | `CodeWriterAgent.js:39-60,126-195` 支持 JSON files 格式 |
| 激活 AI 合并 | ✅ 已做 | `TaskExecutor.js:280` 传真实 provider |
| multi 多 Provider 模式 | ⚠️ 部分做 | `ExecutionModeManager.js:270` 有配置 + `TaskExecutor.js:196` 有方法,**但 CLI 未接通** |
| refineCode 精修 | ⚠️ 部分做 | `CodeWriterAgent.js:197` 有方法,**但有死代码,且 CLI 未触发** |

### 0.3 本文档要解决的问题(残留断裂点)

上述改动虽然写了,但存在 **4 个断裂点** 导致功能够不着或不完整,外加若干工程化缺口:

```
P0 断裂点(功能写了一半,用户用不了):
  T1. multi 模式 CLI 未接通 —— 用户无法通过命令行使用多 Provider 并行
  T2. _saveCodeBlocks 丢文件路径 —— 多文件项目保存时目录结构丢失

P1 残留 Bug(功能有但不可靠):
  T3. 质检门控可能被跳过 —— _extractCode 对纯代码字符串二次提取可能返回 null
  T4. refineCode 死代码 —— _applyDiff 从未被调用,所谓 diff 精修实为整体重写

P2 工程化(收尾):
  T5. 真机 e2e 测试缺失
  T6. CI 不跑 test/lint
  T7. lint 2460 个错误
  T8. 社区文件缺失
  T9. 22 个文件未 commit
```

### 0.4 执行顺序

**Phase 1(止血,半天)**:T1 + T2 + T3 + T4 — 让已写的功能真正可用
**Phase 2(验证,1 天)**:T5 — 真机验证全链路
**Phase 3(收尾,1 天)**:T6 + T7 + T8 + T9 — CI 与提交

---

## 第 1 章 · 项目上下文速查

### 1.1 关键模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| TaskOrchestrator | `src/core/TaskOrchestrator.js` | 门面:配置聚合 + 生命周期协调(751行) |
| TaskScheduler | `src/core/TaskScheduler.js` | 任务状态管理 + 依赖调度 + 执行循环 |
| TaskExecutor | `src/core/TaskExecutor.js` | 单任务执行:路由/派发/质检/合并(678行) |
| ExecutionModeManager | `src/core/ExecutionModeManager.js` | 模式配置(privacy/quality/efficiency/multi) |
| TaskRouter | `src/core/TaskRouter.js` | 工具选择 + 熔断器 |
| AgentFactory | `src/agents/index.js` | 创建 6 个 Agent |
| ProviderFactory | `src/providers/index.js` | 创建 Provider(ollama/openai/anthropic) |
| CodeWriterAgent | `src/agents/CodeWriterAgent.js` | 代码生成 + 多文件输出 + refineCode(271行) |
| QualityCheckerAgent | `src/agents/QualityCheckerAgent.js` | 质检:编译/lint/安全/AI 评分(882行) |
| MergeEngine | `src/agents/MergeEngine.js` | 多路代码合并:三路/两路/语义冲突(879行) |

### 1.2 关键工厂签名(实测)

```js
// AgentFactory.createAll —— 返回 6 个 agent,options 按键切片
AgentFactory.createAll(provider, options) → {
  splitter, codeWriter, codeReviewer, tester, qualityChecker, mergeEngine
}
// options 形如 { splitter: {...}, codeWriter: {...}, ... },每个 agent 拿对应子键

// ProviderFactory.create —— type 为 null 时回退 env 再回退 'ollama'
ProviderFactory.create(type = null, config = {}) → Provider 实例
// 支持: 'ollama' | 'openai' | 'openai_compatible' | 'anthropic' | 'claude'

// ExecutionModeManager —— 4 个模式
modes = { privacy, quality, efficiency, multi }
getModeConfig(modeName) → { name, splitter, codeGeneration, qualityCheck, merging, routing, privacy, ... }
```

### 1.3 CLI run 命令的代码路径(关键)

`src/cli/index.js` 第 30-136 行:

```
qidi run -t "任务" -m privacy
  → ProviderFactory.create(options.provider)        // 单个 provider(61行)
  → ToolScanner 扫描外部工具(91-95行)
  → new TaskOrchestrator(provider, {               // 108行
      workspaceDir, toolAdapters, executionMode
    })
  → orchestrator.setExecutionMode(options.mode)     // 116行
  → orchestrator.runTask(taskDescription)           // 125行
```

**问题**:`run` 命令只创建**单个** provider 传入,`TaskOrchestrator` 构造里 `this.providers = options.providers || [provider]`(31行)拿不到多个 provider。multi 模式因此无法触发。

---

## 第 2 章 · 任务规格

> 每项任务格式:**文件 / 位置 / 问题 / 改动 / 验证 / 验收**

---

### T1. 接通 multi 模式 CLI(P0 断裂)

**文件**:`src/cli/index.js`、`src/core/TaskOrchestrator.js`

**问题**:multi 模式在 `ExecutionModeManager`(270行)和 `TaskExecutor._executeMultiProviderMode`(196行)都已实现,但 CLI 无法触发:
1. `run` 命令 `--mode` 帮助文本是 `'执行模式: privacy|quality'`(第 34 行),没有 multi
2. `run` 命令只创建单个 provider(61 行),不加载多个 provider 传入 orchestrator
3. `TaskOrchestrator` 构造 `this.providers = options.providers || [provider]`(31 行)拿不到多 provider

**改动 1** — `src/cli/index.js` 第 34 行,`--mode` 帮助文本:

```js
// 改前
.option('-m, --mode <mode>', '执行模式: privacy|quality', 'privacy')

// 改后
.option('-m, --mode <mode>', '执行模式: privacy|quality|multi', 'privacy')
```

**改动 2** — `src/cli/index.js` 第 56 行附近,模式显示增加 multi:

```js
// 改前
const modeDisplay = options.mode === 'privacy' ? '🔒 隐私模式' : '✨ 高质量模式';

// 改后
const modeDisplay = options.mode === 'privacy' ? '🔒 隐私模式'
  : options.mode === 'multi' ? '🔀 多模型并行模式'
  : '✨ 高质量模式';
```

**改动 3** — `src/cli/index.js` 第 108 行附近,当 `--mode multi` 时加载多 provider。在 `new TaskOrchestrator` 之前插入:

```js
// ===== multi 模式:加载所有已启用的 Provider =====
let extraProviders = [];
if (options.mode === 'multi') {
  try {
    const AgentHub = require('../core/AgentHub');
    const hub = new AgentHub({ configDir: path.join(__dirname, '../../config') });
    await hub.initialize();
    const enabled = hub.getEnabledAgents();
    extraProviders = enabled
      .map(a => ({ name: a.name, provider: a.provider }))
      .filter(p => p.provider);
    console.log(chalk.cyan(`🔀 多模型模式: 已加载 ${extraProviders.length} 个 Provider`));
    extraProviders.forEach(p => console.log(chalk.gray(`   - ${p.name}`)));
  } catch (e) {
    console.log(chalk.yellow(`⚠️  多 Provider 加载失败: ${e.message},退化为单 Provider`));
  }
}
```

**改动 4** — `src/cli/index.js` 第 108 行,orchestrator 构造传入 providers:

```js
// 改前
const orchestrator = new TaskOrchestrator(provider, {
  workspaceDir: options.workspace,
  verbose: options.verbose,
  toolAdapters: registeredTools,
  executionMode: options.mode
});

// 改后
const orchestrator = new TaskOrchestrator(provider, {
  workspaceDir: options.workspace,
  verbose: options.verbose,
  toolAdapters: registeredTools,
  executionMode: options.mode,
  providers: extraProviders.length > 0 ? extraProviders.map(p => p.provider) : undefined
});
```

**验证**:`node src/cli/index.js run -t "用Python写一个hello world" -m multi`,确认日志出现 `🔀 多模型并行模式` 和 Provider 列表。

**验收标准**:`--mode multi` 能被 CLI 接受,`TaskExecutor.multiProviderMode` 为 true(由 `ExecutionModeManager` 的 `codeGeneration.multiProviderMode: true` 驱动),`this.providers.length >= 1`。

---

### T2. 修复 _saveCodeBlocks 丢失文件路径(P0 断裂)

**文件**:`src/core/TaskExecutor.js` 第 633-641 行

**问题**:`CodeWriterAgent._extractCodeBlocks`(126-195 行)已经从 LLM 输出中提取了 `filePath`,但 `TaskExecutor._saveCodeBlocks` 仍然用 `result_${i+1}${ext}` 命名,**完全忽略 `block.filePath`**。多文件项目保存时目录结构丢失。

**改动**:

```js
// 改前(633-641行)
_saveCodeBlocks(task, codeBlocks) {
  const taskDir = `output/${task.id}`;
  codeBlocks.forEach((block, i) => {
    const ext = this._getExtFromLanguage(block.language);
    const fileName = `result_${i + 1}${ext}`;
    const filePath = `${taskDir}/${fileName}`;
    try { this.fileManager?.writeFile(filePath, block.code); } catch (e) {}
  });
}

// 改后
_saveCodeBlocks(task, codeBlocks) {
  const taskDir = `output/${task.id}`;
  codeBlocks.forEach((block, i) => {
    // 优先使用代码块自带的 filePath,保留多文件项目结构
    let relPath = block.filePath;
    if (!relPath || relPath === 'main') {
      const ext = this._getExtFromLanguage(block.language);
      relPath = `result_${i + 1}${ext}`;
    }
    // 防止路径穿越:去掉开头的 / 或 ..
    relPath = relPath.replace(/^\/+/, '').replace(/\.\.\//g, '');
    const filePath = `${taskDir}/${relPath}`;
    try { this.fileManager?.writeFile(filePath, block.code); } catch (e) {}
  });
}
```

**验证**:构造一个含 2 个 filePath 的 codeBlocks 数组,调用 `_saveCodeBlocks` 后确认 `output/<taskId>/src/main.c` 和 `output/<taskId>/src/utils.h` 被创建(而非 `result_1.c` / `result_2.h`)。

**验收标准**:多文件项目的产出按 LLM 标注的路径还原目录结构;`FileManager.writeFile` 已支持递归创建目录(若不支持,需确认)。

---

### T3. 修复质检门控可能被跳过(P1 残留 Bug)

**文件**:`src/agents/QualityCheckerAgent.js` 第 302-303 行、322/329/336 行

**问题**:`checkQuality`(281 行)先用 `_extractCode(result)` 提取得 `code`(纯代码字符串),再传给 `_runQualityGates(code, ...)`。但 `_runQualityGates`(303 行)又调 `_extractCode(code)` 对纯代码字符串**二次提取**。

`_extractCode`(601 行)对字符串的处理:先匹配 markdown 代码块(纯代码无 ``` 包裹 → 失败)→ `_repairCodeBlocks` 用语言关键字模式匹配(`#include`/`def`/`class`/`function` 等开头才命中)→ 否则返回 `null`。

**后果**:如果代码不以那些关键字开头(如 Python 以 `import` 开头、JS 以 `const` 开头但不在模式列表里),`codeInfo` 为 null,322/329/336 行的 `&& codeInfo` 为 false,**compile/lint/test 门控被静默跳过**。

**改动** — `_runQualityGates` 不再二次提取,直接用传入的 `code` 做门控判断:

```js
// 改前(302-303行)
async _runQualityGates(code, language, task, context) {
  const codeInfo = this._extractCode(code);
  const gateResults = {

// 改后
async _runQualityGates(code, language, task, context) {
  // code 已由 checkQuality 提取为纯代码字符串,这里直接用,不再二次提取
  const gateResults = {
```

然后将 322/329/336 行的 `&& codeInfo` 改为 `&& code`:

```js
// 改前(322行)
if (this.enableCompilation && this.gates.compile.enabled && codeInfo) {

// 改后
if (this.enableCompilation && this.gates.compile.enabled && code) {
```

329 行、336 行同理(`codeInfo` → `code`)。

**验证**:用真 Ollama 跑一个 `import os\nprint("hi")` 的 Python 任务,确认 compile 门控执行(日志出现 `compileCode` 调用,`toolResults.compile` 非 null)。

**验收标准**:对任意合法代码字符串,compile/lint 门控都能触发(只要 `code` 非空),不再依赖代码是否以特定关键字开头。

---

### T4. 清理 refineCode 死代码(P1 残留)

**文件**:`src/agents/CodeWriterAgent.js` 第 197-268 行

**问题**:
1. `_applyDiff`(237-268 行)定义了但 **从未被调用** —— `refineCode` 总是走"输出完整修改后代码"路径
2. `useDiffMode` 开关(198 行)和 if/else 分支(219-223 行)的两个分支 prompt **几乎完全相同**,毫无差异
3. 所谓"diff 级精修"实际是整体重写,与 `writeCode` 区别仅在于多了质检反馈

**改动** — 删除死代码,简化 refineCode。保留整体重写(当前唯一生效的路径),删除误导性的 diff 开关:

```js
// 改后(替换 197-235 行)
async refineCode(task, originalCode, feedback, context = {}, options = {}) {
  let prompt = `请根据以下反馈精修代码：\n\n任务：${task.title}\n`;

  if (context.constraints) {
    prompt += `\n【约束】\n编程语言：${context.constraints.language || '未指定'}\n`;
  }

  prompt += `\n【原始代码】\n\`\`\`${task.language || 'text'}\n${originalCode}\n\`\`\`\n`;

  prompt += `\n【质检反馈】\n`;
  if (feedback.revisionSuggestions) {
    prompt += `修改建议：${feedback.revisionSuggestions}\n`;
  }
  if (feedback.weaknesses && feedback.weaknesses.length > 0) {
    prompt += `问题列表：\n${feedback.weaknesses.map((w, i) => `${i + 1}. ${w}`).join('\n')}\n`;
  }
  if (feedback.constraintViolations && feedback.constraintViolations.length > 0) {
    prompt += `约束违规：\n${feedback.constraintViolations.map((v, i) => `${i + 1}. ${v}`).join('\n')}\n`;
  }

  prompt += `\n【输出要求】请输出完整的修改后的代码（不是 diff 格式），确保修复了上述所有问题。保留原有正确的部分，只修改有问题的部分。`;

  const result = await this.sendOnce(prompt, options);
  const codeBlocks = this._extractCodeBlocks(result.content);

  return {
    content: result.content,
    codeBlocks,
    hasMultipleFiles: codeBlocks.length > 1,
    model: result.model || 'unknown',
    refinementApplied: true
  };
}
```

同时删除 `_applyDiff` 方法(237-268 行)和构造函数中的 `this.enableDiffMode`(72 行)。

**验证**:确认 `refineCode` 仍被 `TaskExecutor.js:180` 正常调用,无 ReferenceError。

**验收标准**:无死代码,`refineCode` 行为明确(整体重写 + 质检反馈注入),lint 无 `_applyDiff` 未使用告警。

---

### T5. 新增真机 e2e 测试(P2 验证)

**文件**:新增 `test/e2e_real_test.js`;`package.json` 加 script

**问题**:现有 `test/comprehensive_test.js` 53 个测试全是 mock,从未真机验证。T1-T4 的修复是否有效无从确认。

**改动** — 新增 `test/e2e_real_test.js`,用真 Ollama 跑通全链路。Ollama 不可用时自动 skip:

```js
#!/usr/bin/env node
/**
 * 真机 e2e 测试:用真 Ollama 跑通 拆分→生成→质检→报告 全链路。
 * Ollama 不可用时自动 skip。
 * 运行: npm run test:e2e
 */
const OllamaProvider = require('../src/providers/OllamaProvider');
const TaskOrchestrator = require('../src/core/TaskOrchestrator');

async function main() {
  // 1. 探测 Ollama
  const provider = new OllamaProvider({ baseURL: 'http://localhost:11434', model: 'qwen2.5:7b' });
  let connected;
  try {
    connected = await provider.checkConnection();
  } catch (e) {
    connected = false;
  }
  if (!connected) {
    console.log('⏭️  Ollama 不可用,跳过真机 e2e 测试');
    process.exit(0);
  }
  console.log('✅ Ollama 连接成功,开始真机 e2e 测试\n');

  const results = { passed: 0, failed: 0 };

  function assert(name, condition, detail = '') {
    if (condition) { results.passed++; console.log(`  ✅ ${name}`); }
    else { results.failed++; console.log(`  ❌ ${name} ${detail}`); }
  }

  // 2. 隐私模式:简单 Python 任务
  console.log('━━━ 测试1: privacy 模式 简单任务 ━━━');
  try {
    const orch = new TaskOrchestrator(provider, {
      workspaceDir: './test_tmp/e2e_privacy',
      executionMode: 'privacy',
      enableCache: false,
      maxRetries: 1
    });
    await orch.initialize();
    const result = await orch.runTask('用Python写一个函数,返回两个数的和');

    assert('任务完成', result.completedTasks >= 1);
    assert('有代码产出', result.tasks.some(t => t.result?.codeBlocks?.length > 0));
    assert('质检执行', result.tasks.some(t => t.result?.quality?.toolResults));
    assert('报告生成', !!result.reportId);
  } catch (e) {
    assert('privacy 模式不抛异常', false, e.message);
  }

  // 3. multi 模式(若有多 provider 配置)
  console.log('\n━━━ 测试2: multi 模式 多Provider ━━━');
  try {
    const AgentHub = require('../src/core/AgentHub');
    const hub = new AgentHub({ configDir: './config' });
    await hub.initialize();
    const enabled = hub.getEnabledAgents();
    const providers = enabled.map(a => a.provider).filter(Boolean);

    if (providers.length < 2) {
      console.log('  ⏭️  启用的 Provider 不足 2 个,跳过 multi 测试');
    } else {
      const orch = new TaskOrchestrator(providers[0], {
        workspaceDir: './test_tmp/e2e_multi',
        executionMode: 'multi',
        providers,
        enableCache: false,
        maxRetries: 1
      });
      await orch.initialize();
      const result = await orch.runTask('用Python写一个hello world');

      assert('multi 任务完成', result.completedTasks >= 1);
      assert('multi 模式生效', orch.multiProviderMode === true);
    }
  } catch (e) {
    assert('multi 模式不抛异常', false, e.message);
  }

  // 4. 汇总
  console.log(`\n━━━ 真机 e2e 结果: ${results.passed} 通过, ${results.failed} 失败 ━━━`);
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
```

`package.json` scripts 加:

```json
"test:e2e": "node test/e2e_real_test.js"
```

**验证**:`npm run test:e2e`(需 Ollama 运行 qwen2.5:7b)。

**验收标准**:Ollama 可用时测试通过;不可用时 graceful skip(exit 0)。

---

### T6. 修复 CI 不跑 test/lint(P2 收尾)

**文件**:`.github/workflows/ci.yml`

**问题**:当前 CI 只做 `node --check` 语法检查,不跑 `npm test` 也不跑 `npm run lint:ci`。

**改动** — 在 ci.yml 的 steps 末尾(syntax check 之后)加:

```yaml
      - name: Lint
        run: npm run lint:ci

      - name: Test
        run: npm test
```

**注意**:`lint:ci` 是零警告门槛,必须先完成 T7 才能让 CI 通过。建议 T7 完成后再加这一步,或先用 `npm run lint`(非 ci 版本)过渡。

**验收标准**:CI 在 push/PR 时同时跑 lint 和 test。

---

### T7. 治理 lint 错误(P2 收尾)

**文件**:全项目 `src/`、`test/`、`public/`

**问题**:实测 2460 个 lint 问题(2364 errors, 96 warnings),其中 2352 个可 `--fix` 自动修复。

**改动**:
1. 先跑 `npm run lint:fix` 自动修复格式问题(空格/引号/尾随空格等)
2. 手工修复残余真实问题:
   - 未使用变量(如 `test/tool_executor_test.js` 中 `ClaudeCodeAdapter` import 了没用)
   - Promise 参数命名(需匹配 `^_?resolve$`)
3. 目标:`npm run lint:ci` 通过(零警告)

**验证**:`npm run lint:ci` 退出码 0。

**验收标准**:`lint:ci` 通过。

---

### T8. 补全社区文件(P2 收尾)

**文件**:新增 `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`

**问题**:README.md 第 14 行引用了这两个文件,但它们不存在。

**改动** — 创建标准内容:
- `CONTRIBUTING.md`:开发环境搭建(npm install / npm test)、代码风格(eslint standard)、提交规范、添加新适配器流程(README 第 236-239 行已有说明,搬过来扩充)
- `CODE_OF_CONDUCT.md`:Contributor Covenant 2.1 中文版

**验收标准**:两个文件存在,README 链接可达。

---

### T9. 提交未 commit 的改动(P2 收尾)

**问题**:22 个文件 modified 未 commit,包括本次 T1-T8 的所有改动。风险:丢失、冲突、无法回滚。

**改动** — 分批 commit(建议):
1. `git add config/agents.json .env.example` → commit "fix: 移除硬编码 API key,改用环境变量"
2. `git add src/agents/ src/core/` → commit "feat: multi模式/refineCode/质检门控/修订循环修复"
3. `git add src/cli/index.js` → commit "feat: CLI 接通 multi 模式"
4. `git add test/e2e_real_test.js package.json` → commit "test: 新增真机 e2e 测试"
5. `git add .github/ CONTRIBUTING.md CODE_OF_CONDUCT.md` → commit "ci: 补全 CI lint/test + 社区文件"
6. `git add -A` → commit "style: lint:fix 格式化"

**注意**:提交前确认 `.gitignore` 已排除 `config/agents.json`(含真实配置)。若 `config/agents.json` 需要保留默认配置在版本控制,确保其中无任何真实 key。

**验收标准**:`git status` clean;`git log` 可见分批提交。

---

## 第 3 章 · 验收清单

### 3.1 功能验收(真机)

```bash
# 前提:Ollama 运行 qwen2.5:7b

# 1. privacy 模式
node src/cli/index.js run -t "用Python写一个返回两数之和的函数" -m privacy
# 预期:任务拆分→生成→质检→报告,产出代码保存到 output/

# 2. multi 模式(需 config/agents.json 至少 2 个 enabled provider)
node src/cli/index.js run -t "用Python写一个hello world" -m multi
# 预期:日志出现"🔀 多模型并行模式"+ Provider 列表,多 provider 并行生成

# 3. 多文件项目
node src/cli/index.js run -t "用C语言写一个含main.c和utils.h的项目" -m privacy
# 预期:output/<taskId>/ 下按文件路径还原目录(非 result_1.c)
```

### 3.2 工程验收

```bash
npm test                    # 53/53 mock 单测通过
npm run test:e2e            # 真机 e2e 通过(Ollama 可用时)
npm run lint:ci             # 零警告通过
git status                  # clean
```

### 3.3 逐项验收对照

| 任务 | 验收点 |
|------|--------|
| T1 | `--mode multi` 可用,multiProviderMode=true |
| T2 | 多文件产出按 filePath 还原目录 |
| T3 | compile/lint 门控对任意代码触发(日志可见) |
| T4 | 无 `_applyDiff` 死代码,refineCode 正常调用 |
| T5 | `npm run test:e2e` 通过 |
| T6 | CI 跑 lint + test |
| T7 | `lint:ci` 退出码 0 |
| T8 | CONTRIBUTING.md / CODE_OF_CONDUCT.md 存在 |
| T9 | git status clean,分批 commit |

---

## 附录 · 风险与边界

1. **T1 multi 模式降级**:若仅 1 个 enabled provider,`TaskExecutor._executeMultiProviderMode` 会走单 provider 路径(245-253 行),不合并。这是预期行为,非 Bug。
2. **T2 路径穿越防护**:`relPath` 已做 `^/+` 和 `../` 清理。若 `FileManager.writeFile` 不支持递归建目录,需先确认其实现。
3. **T3 不改 `_extractCode` 签名**:只改 `_runQualityGates` 内部,避免影响 `runFullQualityCheck`(843 行)等其它调用方。
4. **T5 真机测试耗时**:单次任务可能 30-60s,超时建议设 120s。Ollama 不可用必须 graceful skip,不能让 CI 因无 Ollama 而挂。
5. **T9 提交前必查**:确认 `config/agents.json` 中无任何 `sk-` 开头的真实 key;确认 `.env` 不被跟踪。
6. **不做的事**:不引入 TypeScript;不重写 TUI/WebUI;不实现 MCP/插件系统;不做递归拆分。这些是 v2.0 范畴。

---

## 附录 · 已确认的非问题(不要动)

以下看起来像问题但实际正常,**不要修改**:

- `BaseAgent.js` 用 `new Ajv()` + `ajv.compile()` —— ajv v8 实测兼容此用法(smoke test 通过)
- `TaskExecutor.js:280` `new MergeEngine(this.agents.codeWriter?.provider || null)` —— 传 codeWriter 的 provider,可用(虽非最优,但非 Bug)
- `TaskScheduler.js:69` needsRevision 不标 completed —— 这是 B2 的正确修复,配合 `TaskExecutor.js:113` 的 maxRetries 收敛,无死循环风险
- `ExecutionModeManager.js` 的 `multi` 模式配置 —— 结构完整,无需改动
