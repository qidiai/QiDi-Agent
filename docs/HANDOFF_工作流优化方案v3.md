# Qidi Agent WebUI 工作流优化执行规格书 v3

> **文档用途**:供其他 AI 独立执行。无需阅读任何对话上下文,按本文档对照源码即可动手。
> **基准版本**:v2.0.0(2026-07-01 实测)
> **代码风格约定**:Node.js + CommonJS,中文注释,`require`,class。
> **不引入 TypeScript / 打包工具。**

---

## 第 0 章 · 用户真实场景(必须先理解)

### 0.1 工作流全貌

用户本机有 7 个 AI 编程工具,分两类使用:

```
手操工具(不通过 qidi,用户直接打开软件用):
  - Trae:用户主力写代码,包括改 Qidi Agent 自身的代码
  - AtomCode:用户做其他正常任务

Qidi 调度的闲时工具(通过 qidi WebUI 调用):
  - OpenClaw:闲时被 qidi 调用
  - Hermes Agent:闲时被 qidi 调用
  - 其他免费工具(按需启用)
```

**核心前提:Trae 和 AtomCode 不进入 qidi 的调度池。** 用户直接手操它们。Qidi 只调度用户"没在用"的闲时工具。

### 0.2 Qidi 的三种使用场景

| 场景 | 描述 | 例子 |
|------|------|------|
| **扫尾** | Trae 写完主体代码,qidi 调闲时工具做收尾(测试用例/文档/配置) | Trae 写完业务代码 → qidi 调 OpenClaw 生成测试 |
| **杂活** | Trae 在忙主线,qidi 同时调闲时工具干独立的辅助任务 | Trae 写主功能 → qidi 调 Hermes 写辅助脚本 |
| **攻坚** | 遇到困难问题,qidi 调 2 个工具同时处理,看能否解决 | 困难 bug → OpenClaw + Hermes 各自尝试 → 对比方案 |

### 0.3 核心需求

**用户要在 WebUI 上控制:这次任务调用哪几个闲时工具。**

比如在编程控制台:
- 场景"扫尾":选 1 个工具(OpenClaw)→ 单工具执行
- 场景"杂活":选 1 个工具(Hermes)→ 单工具执行
- 场景"攻坚":选 2 个工具(OpenClaw + Hermes)→ 并行执行 + 选优/合并

### 0.4 当前代码的根本问题

**WebUI 任务执行完全不调用外部工具。**

`src/core/WebUIServer.js` 的 `_runTaskAsync`(约 240 行):

```js
// 当前:创建 orchestrator 时不传 toolAdapters
const orch = new TaskOrchestrator(null, { workspaceDir: this.workspaceDir });
//                           ^^^^                          ^^^ 没有传 toolAdapters!
```

`TaskOrchestrator` 构造里 `this.toolAdapters = options.toolAdapters || []`,没传就是空数组。所以 WebUI 执行任务时 `this.toolAdapters` 为空,`_dispatchToAdapters` 找不到任何在线工具,直接走 Provider(LLM 生成代码)。

**后果:用户在 WebUI 发起任务,永远只走 DeepSeek 文本生成,从不调用 OpenClaw/Hermes 等真实工具。**

### 0.5 执行顺序

```
Phase 1(核心,1-2 天):U1 + U2 → WebUI 能选工具 + 任务真正调用工具
Phase 2(优化,半天):U3 → 三种场景预设
Phase 3(验证,1 天):U4 → 真机验证
```

---

## 第 1 章 · 项目上下文速查

### 1.1 WebUI 任务执行的完整链路(当前)

```
前端 executeTask()(public/js/app.js:987)
  → POST /api/tasks/execute { task, models, constraints, mode }
  → WebUIServer._runTaskAsync(taskId, task, models, constraints, mode)
    → new TaskOrchestrator(provider, { workspaceDir })  ← 没传 toolAdapters!
    → orchestrator.runTask(task)
      → TaskExecutor._executeCodeTask
        → _dispatchToAdapters  ← this.toolAdapters 为空,返回 {}
        → 只走 Provider 生成
```

### 1.2 WebUI 已有的工具管理能力

| API | 功能 | 位置 |
|-----|------|------|
| `GET /api/tools` | 列出所有工具 | WebUIServer.js:146 |
| `POST /api/tools/scan` | 扫描工具 | :155 |
| `POST /api/tools/connect/:name` | 连接工具 | :164 |
| `GET /api/tools/:name/detail` | 工具详情 | :173 |

前端已有工具管理页面(Tool Management),能扫描/连接/查看工具。但**任务执行时不使用这些工具**。

### 1.3 ToolScanner 的 adapter 管理

`src/core/ToolScanner.js`:
- `this.adapters` — Map,存所有注册的 adapter
- `scanner.adapters` — WebUIServer 通过 `this.toolScanner.adapters`(660 行)访问

### 1.4 TaskOrchestrator 如何接收工具

```js
// TaskOrchestrator.js 构造
this.toolAdapters = options.toolAdapters || [];
// 传数组进来,后续 _dispatchToAdapters 就能用
```

---

## 第 2 章 · 任务规格

> 每项任务格式:**文件 / 位置 / 问题 / 改动 / 验证 / 验收**

---

### U1. WebUI 任务执行时传入选中的工具(P0 核心)

**文件**:`src/core/WebUIServer.js`、`public/js/app.js`

**问题**:`_runTaskAsync` 创建 orchestrator 时不传 `toolAdapters`,导致 WebUI 任务永远不调用外部工具。

**改动 1 — `WebUIServer.js` `_runTaskAsync` 增加 `selectedTools` 参数**

找到 `_runTaskAsync` 方法定义(搜索 `async _runTaskAsync`),修改签名和 orchestrator 创建部分:

```js
// 改前
async _runTaskAsync (taskId, task, models, constraints, mode) {
  // ...
  const orch = new TaskOrchestrator(null, { workspaceDir: this.workspaceDir });
  // ...
}

// 改后
async _runTaskAsync (taskId, task, models, constraints, mode, selectedTools = []) {
  // ... 前面不变 ...

  // 获取用户选中的工具 adapter
  let toolAdapters = [];
  if (selectedTools.length > 0 && this.toolScanner) {
    toolAdapters = this.toolScanner.adapters
      .filter(a => selectedTools.includes(a.name))
      .filter(a => a.isAvailable && a.isAvailable());
    
    logger.info(`[任务启动] 用户选中工具: ${selectedTools.join(', ')}, 可用: ${toolAdapters.length} 个`);
  }

  const orch = new TaskOrchestrator(resolvedProvider, {
    workspaceDir: this.workspaceDir,
    toolAdapters,                           // 传入选中的工具
    executionMode: mode || 'quality',
    providers: resolvedProviders
  });
  // ... 后面不变 ...
}
```

**改动 2 — `/api/tasks/execute` 接口接收 `selectedTools` 参数**

找到 `/api/tasks/execute` 的处理代码(搜索 `tasks/execute` 或 `_runTaskAsync` 调用处),在提取 task/models/constraints/mode 的地方,增加 selectedTools:

```js
// 改前
this._runTaskAsync(taskId, task, useModels, constraints || {}, mode || 'privacy')

// 改后
const selectedTools = req.body.selectedTools || [];
this._runTaskAsync(taskId, task, useModels, constraints || {}, mode || 'privacy', selectedTools)
```

**改动 3 — 前端 `executeTask()` 增加工具选择器**

文件 `public/js/app.js` 的 `executeTask` 函数(约 987 行),增加获取选中工具的逻辑:

```js
// 改前
async function executeTask () {
  // ...
  const res = await fetch('/api/tasks/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task,
      models,
      constraints,
      mode: currentMode
    })
  });
  // ...
}

// 改后
async function executeTask () {
  // ...
  // 获取选中的工具
  const selectedTools = [];
  document.querySelectorAll('.tool-checkbox:checked').forEach(cb => {
    selectedTools.push(cb.value);
  });

  const res = await fetch('/api/tasks/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task,
      models,
      constraints,
      mode: currentMode,
      selectedTools    // 新增
    })
  });
  // ...
}
```

**改动 4 — 前端编程控制台增加工具选择 UI**

文件 `public/index.html`,在编程控制台页面(console page)的约束选项区域附近,增加工具选择区:

```html
<!-- 工具选择区域(加在约束复选框之后) -->
<div class="tool-selection-area" id="console-tool-selection">
  <label class="tool-section-label">🔧 调用工具(可选,不选则只用模型生成)</label>
  <div class="tool-checkbox-group" id="console-tool-checkboxes">
    <!-- 动态填充,由 JS 加载在线工具 -->
  </div>
</div>
```

**改动 5 — 前端 JS 加载在线工具列表到选择器**

文件 `public/js/app.js`,增加一个加载函数:

```js
// 加载在线工具到编程控制台的选择器
async function loadConsoleTools () {
  try {
    const res = await fetch('/api/tools');
    const data = await res.json();
    const container = document.getElementById('console-tool-checkboxes');
    if (!container) return;

    const tools = data.tools || [];
    container.innerHTML = tools
      .filter(t => t.detected)  // 只显示检测到的工具
      .map(t => `
        <label class="tool-checkbox-item">
          <input type="checkbox" class="tool-checkbox" value="${t.name}" ${t.status === 'online' ? '' : 'disabled'}>
          <span>${t.displayName || t.name}</span>
          <small class="tool-status ${t.status === 'online' ? 'online' : 'offline'}">${t.status}</small>
        </label>
      `).join('');
  } catch (e) {
    console.error('加载工具列表失败:', e);
  }
}

// 在页面加载时调用
document.addEventListener('DOMContentLoaded', () => {
  // ... 现有初始化代码 ...
  loadConsoleTools();
});
```

**验证**:
1. 打开 WebUI 编程控制台,确认看到工具选择区
2. 勾选 OpenClaw,执行任务
3. 查看日志确认 `[任务启动] 用户选中工具: openclaw, 可用: 1 个`
4. 确认任务执行过程中调用了 OpenClaw(日志出现 `toolRouted` / `multiToolDispatch`)

**验收标准**:
- WebUI 编程控制台有工具选择 UI(复选框列表)
- 勾选工具后执行任务,真实调用该工具(非仅 Provider 生成)
- 不勾选工具时,退化为纯 Provider 生成(向后兼容)
- 日志记录选中工具和可用工具数

---

### U2. `_dispatchToAdapters` 走路由器 + `top_n` 策略(P0 核心)

**文件**:`src/core/TaskRouter.js`、`src/core/TaskExecutor.js`、`src/core/TaskOrchestrator.js`

**问题**:
1. `TaskRouter` 没有"选前 N 个"的策略(U1 传了工具后,需要按能力选)
2. `_dispatchToAdapters` 绕过路由器,直接发给所有传入的工具
3. `MergeEngine` 传 null provider(AI 合并失效)

**改动 1 — `TaskRouter.js` 新增 `top_n` 策略**

在 `routeTask` 的 switch 增加 `top_n`(在 `case 'broadcast'` 之前):

```js
case 'top_n':
  return this._routeTopN(task, available, this.options.topN || 3);
```

新增 `_routeTopN` 方法(放在 `_routeByCapability` 之后):

```js
/**
 * 选前 N 个最优工具(并行 + 对比选优)
 */
_routeTopN (task, available, n = 3) {
  const scores = available.map(adapter => {
    const caps = this.options.capabilities[adapter.name] || {};
    const score = this._calculateCapabilityScore(task, caps, adapter.name);
    return { adapter, score, reason: this._explainCapabilityMatch(task, caps, score) };
  });

  scores.sort((a, b) => b.score - a.score);
  const matched = scores.filter(s => s.score > 0);
  const selected = matched.slice(0, n);

  if (selected.length === 0) {
    // 无匹配,取前 N 个可用的
    const fallback = available.slice(0, n);
    return {
      adapter: fallback,
      reason: `无精确能力匹配,取前 ${fallback.length} 个可用工具`,
      strategy: 'top_n',
      isBroadcast: fallback.length > 1,
      allScores: scores.map(s => ({ tool: s.adapter.name, score: s.score }))
    };
  }

  return {
    adapter: selected.map(s => s.adapter),
    reason: `按能力选前 ${selected.length} 个: ${selected.map(s => s.adapter.displayName).join(', ')}`,
    strategy: 'top_n',
    isBroadcast: selected.length > 1,
    allScores: scores.map(s => ({ tool: s.adapter.name, score: s.score }))
  };
}
```

在 `getStrategies()` 返回数组中(`capability` 之后)增加:

```js
{
  name: 'top_n',
  description: '选前N个最优工具(并行+对比选优)',
  privacyLevel: 'medium',
  providerInvolved: true
}
```

在构造函数 `this.options` 增加 `topN`:

```js
this.options = {
  strategy: options.strategy || 'round_robin',
  topN: options.topN || 3,
  // ... 其余不变
};
```

**改动 2 — `TaskExecutor.js` `_dispatchToAdapters` 走路由器**

找到 `_dispatchToAdapters` 方法,替换为(只派发路由选中的工具,而非全部):

```js
async _dispatchToAdapters (task, context) {
  const allOnline = this.toolAdapters.filter(a => a.isAvailable && a.isAvailable());
  if (allOnline.length === 0) return {};

  // 走路由器选工具
  const router = this._getTaskRouter ? this._getTaskRouter() : null;
  let targetAdapters = allOnline;

  if (router) {
    const routing = router.routeTask(task);
    if (routing.adapter) {
      if (Array.isArray(routing.adapter)) {
        targetAdapters = routing.adapter;
      } else {
        targetAdapters = [routing.adapter];
      }
    }
    context.orchestrator?.emit('toolRouted', {
      task,
      strategy: routing.strategy,
      selectedTools: targetAdapters.map(a => a.displayName),
      reason: routing.reason
    });
  }

  context.orchestrator?.emit('multiToolDispatch', {
    task,
    tools: targetAdapters.map(a => ({ name: a.name, displayName: a.displayName }))
  });

  const taskDesc = this._buildToolTaskDescription(task, context);
  const promises = targetAdapters.map(async (adapter) => {
    const startTime = Date.now();
    try {
      const r = await adapter.execute(taskDesc, {
        taskId: `${adapter.name}_${task.id}`, timeout: 120000
      });
      const errMsg = !r.success
        ? (r.stderr || r.error || r.rawOutput?.substring(0, 300) || '工具执行失败')
        : null;
      return { name: adapter.name, displayName: adapter.displayName, result: r, error: errMsg, duration: Date.now() - startTime };
    } catch (e) {
      return { name: adapter.name, displayName: adapter.displayName, result: { success: false, content: '', codeBlocks: [] }, error: e.message, duration: Date.now() - startTime };
    }
  });

  const settled = await Promise.allSettled(promises);
  const results = {};
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      const { name, displayName, result, error, duration } = s.value;
      if (result && result.success && !error) {
        results[name] = { ...result, displayName, duration };
      } else {
        results[name] = { success: false, error: error || '任务失败', displayName, duration };
        context.orchestrator?.emit('toolFailed', { tool: displayName, task, error: error || '任务失败' });
      }
    }
  }
  return results;
}
```

**改动 3 — `TaskExecutor.js` 修 MergeEngine null provider**

找到 `_mergeToolOutputs` 中的(约 378 行):

```js
// 改前
const mergeEngine = new MergeEngine(null, { conflictResolution: 'auto' });

// 改后
const mergeEngine = new MergeEngine(
  context.orchestrator?.provider ?? null,
  { conflictResolution: 'auto' }
);
```

**改动 4 — `TaskOrchestrator.js` `_getTaskRouter` 透传 topN**

```js
// 改前
_getTaskRouter() {
  if (!this.toolRouter) {
    this.toolRouter = new TaskRouter(this.toolAdapters, {
      strategy: this.routingStrategy,
      manualRouting: this.manualRouting,
      privacyMode: this.privacyMode,
      toolOnlyMode: this.privacyMode,
      toolLearning: this.toolLearning
    });
  }
  return this.toolRouter;
}

// 改后
_getTaskRouter() {
  if (!this.toolRouter) {
    this.toolRouter = new TaskRouter(this.toolAdapters, {
      strategy: this.routingStrategy,
      topN: this.options.topN || 3,
      manualRouting: this.manualRouting,
      privacyMode: this.privacyMode,
      toolOnlyMode: this.privacyMode,
      toolLearning: this.toolLearning
    });
  }
  return this.toolRouter;
}
```

**改动 5 — quality 模式默认路由改为 `top_n`**

文件 `src/core/ExecutionModeManager.js`,quality 模式的 routing:

```js
// 改前
routing: {
  defaultStrategy: 'capability',
  strategies: ['capability', 'round_robin', 'manual', 'broadcast'],
  ...
},

// 改后
routing: {
  defaultStrategy: 'top_n',
  strategies: ['top_n', 'capability', 'round_robin', 'manual', 'broadcast'],
  ...
},
```

**验证**:
1. WebUI 勾选 OpenClaw + Hermes,执行任务
2. 日志出现 `toolRouted: strategy=top_n, selectedTools=[OpenClaw, Hermes Agent]`
3. 只调用选中的 2 个工具(不调用未选中的)
4. 多工具产出后 MergeEngine 不报"AI调用失败"

**验收标准**:
- `top_n` 策略存在且工作
- `_dispatchToAdapters` 只派发路由选中的工具
- MergeEngine provider 非 null
- quality 模式默认 `top_n`

---

### U3. 三种场景预设按钮(P1 体验)

**文件**:`public/index.html`、`public/js/app.js`

**问题**:用户每次要手动勾选工具+选模式,但实际就 3 种场景。

**改动 1 — `index.html` 编程控制台增加 3 个场景按钮**

在工具选择区上方加:

```html
<!-- 场景预设按钮 -->
<div class="scenario-presets" id="console-scenarios">
  <button class="btn-scenario" data-scenario="sweep">🧹 扫尾(单工具)</button>
  <button class="btn-scenario" data-scenario="chore">📦 杂活(单工具)</button>
  <button class="btn-scenario" data-scenario="tough">🧠 攻坚(双工具并行)</button>
</div>
```

**改动 2 — `app.js` 增加场景预设逻辑**

```js
// 场景预设:自动选工具 + 选模式
document.addEventListener('click', async (e) => {
  if (!e.target.classList.contains('btn-scenario')) return;
  
  const scenario = e.target.dataset.scenario;
  const checkboxes = document.querySelectorAll('.tool-checkbox');
  
  // 先取消所有勾选
  checkboxes.forEach(cb => cb.checked = false);
  
  // 获取在线工具列表
  const onlineTools = Array.from(checkboxes).filter(cb => !cb.disabled);
  
  switch (scenario) {
    case 'sweep':
      // 扫尾:选第 1 个在线工具(如 OpenClaw),quality 模式
      if (onlineTools[0]) onlineTools[0].checked = true;
      setMode('quality');
      appendChatMessage('system', '🧹 扫尾模式:单工具执行收尾任务');
      break;
    case 'chore':
      // 杂活:选第 2 个在线工具(如 Hermes),quality 模式
      if (onlineTools[1]) onlineTools[1].checked = true;
      else if (onlineTools[0]) onlineTools[0].checked = true;
      setMode('quality');
      appendChatMessage('system', '📦 杂活模式:单工具执行辅助任务');
      break;
    case 'tough':
      // 攻坚:选前 2 个在线工具,quality + top_n 模式
      onlineTools.slice(0, 2).forEach(cb => cb.checked = true);
      setMode('quality');
      appendChatMessage('system', '🧠 攻坚模式:双工具并行,对比选优');
      break;
  }
});

function setMode(mode) {
  currentMode = mode;
  const modeBtns = document.querySelectorAll('.mode-btn');
  modeBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}
```

**验证**:点 3 个场景按钮,工具自动勾选正确。

**验收标准**:3 个场景按钮可用,点击后自动勾选工具 + 设模式。

---

### U4. 真机验证(P2)

**验证步骤**:

```bash
# 前提:DeepSeek API 可用,OpenClaw + Hermes 已连接

# 1. 启动 WebUI
node src/cli/index.js web

# 2. 场景"扫尾"
#    打开 http://localhost:3000 → 编程控制台
#    点"🧹 扫尾"按钮 → 输入"给 main.py 写单元测试" → 执行
#    预期:只调 1 个工具(OpenClaw),产出测试代码

# 3. 场景"攻坚"
#    点"🧠 攻坚"按钮 → 输入"写一个贪吃蛇游戏" → 执行
#    预期:调 2 个工具(OpenClaw + Hermes)并行,质检选优,日志可见两个工具的产出和评分对比

# 4. 验证日志
#    日志应出现:
#    [任务启动] 用户选中工具: openclaw, hermes-agent, 可用: 2 个
#    toolRouted: strategy=top_n, selectedTools=[OpenClaw, Hermes Agent]
#    multiToolDispatch: tools=[openclaw, hermes-agent]
#    (两个工具各自产出)
#    multiToolMerged: toolsUsed=[openclaw, hermes-agent]
```

**验收标准**:
- 扫尾场景:单工具执行,产出代码
- 杂活场景:单工具执行,产出代码
- 攻坚场景:双工具并行,产出 + 质检选优/合并

---

## 第 3 章 · 验收清单

### 3.1 功能验收

| 场景 | 操作 | 预期 |
|------|------|------|
| 不选工具 | 直接执行 | 退化为纯 Provider 生成(向后兼容) |
| 扫尾 | 点"🧹 扫尾"→ 执行 | 单工具执行 |
| 杂活 | 点"📦 杂活"→ 执行 | 单工具执行 |
| 攻坚 | 点"🧠 攻坚"→ 执行 | 双工具并行 + 选优/合并 |

### 3.2 工程验收

```bash
npm test                    # 全部通过
npm run lint:ci             # 零错误(若仍有,先 npm run lint:fix)
git status                  # 改动已提交
```

### 3.3 逐项验收

| 任务 | 验收点 |
|------|--------|
| U1 | WebUI 编程控制台有工具选择器;勾选工具后任务真实调用该工具 |
| U2 | top_n 策略工作;_dispatchToAdapters 走路由器;MergeEngine 非 null |
| U3 | 3 个场景按钮可用,自动勾选工具 |
| U4 | 三种场景真机验证通过 |

---

## 附录 · 风险与边界

1. **U1 向后兼容**:不传 `selectedTools` 或传空数组时,退化为纯 Provider 生成,不破坏现有功能。
2. **U2 路由器为 null 时降级**:若 `_getTaskRouter` 不可用,退化为发送全部传入的工具(保持兼容)。
3. **U3 工具不足**:若在线工具不足 2 个,"攻坚"按钮自动降级为选 1 个。
4. **U1 工具不可用**:勾选了但 `isAvailable()` 返回 false 的工具,会被 filter 过滤掉,不参与执行。
5. **WebUI 安全**:已有认证机制(WEBUI_AUTH_PASSWORD),工具选择不引入新安全风险。

## 附录 · 不做的事

- 不引入 TypeScript
- 不改 CLI 的 run 命令(本方案只优化 WebUI 路径)
- 不实现 MCP/插件系统
- 不改 Trae/AtomCode 适配器(用户手操,不通过 qidi 调用)

## 附录 · 已确认的非问题(不要动)

- `BaseAgent.js` 用 ajv v8 —— 兼容
- `TaskScheduler.js` needsRevision 逻辑 —— 正确
- 适配器工作目录隔离 —— 正确
- WebUI 已有认证机制 —— 达标
- 12 个适配器都有真实 execute —— 达标

---

## 给执行方 AI 的提示词

```
请阅读 docs/HANDOFF_工作流优化方案v3.md,按 Phase 1 → 2 → 3 顺序执行全部 4 项任务(U1-U4)。

关键约束:
1. 每项改动给出精确文件路径,对照源码确认行号后再改(项目在持续变动,行号可能偏移)
2. 沿用现有代码风格:CommonJS、中文注释、class
3. 不要引入 TypeScript / 打包工具
4. U1 是核心:WebUI 任务执行时传入 toolAdapters,让任务真正调用外部工具
5. 已确认的非问题(见附录)不要动
6. 每完成一项,跑 npm test 确认不破坏现有测试
7. U4 真机验证需 DeepSeek API + OpenClaw/Hermes 已连接
```

---

## 执行顺序总览

```
Phase 1(核心,1-2 天):
  U1 WebUI 传入选中工具     ← _runTaskAsync 加 toolAdapters + 前端工具选择器
  U2 路由器 top_n + 修 MergeEngine  ← _dispatchToAdapters 走路由器

Phase 2(优化,半天):
  U3 三种场景预设按钮       ← 扫尾/杂活/攻坚

Phase 3(验证,1 天):
  U4 真机验证              ← 三种场景跑通
```

**一句话**:当前 WebUI 任务执行根本不传 toolAdapters——这是"WebUI 控制工具调用"的最大障碍。U1 修这个(让任务真正调用工具),U2 修路由和合并,U3 加场景按钮,U4 真机验证。修完 U1+U2,你的三种场景就能跑了。
