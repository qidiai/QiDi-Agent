# Qidi Agent CLI Ink TUI 完整改造计划

> 日期: 2026-06-29 | 用户选择: Ink (React-based) + 完整改造

## Context

Qidi Agent 的 CLI 界面当前使用 readline + chalk + ora + inquirer 实现，虽然已具备多行输入、命令历史、上下文记忆等基础功能，但与 Claude Code/Cursor 等专业工具相比，用户体验差距明显。专家评审建议（优先级最高）：
1. TUI 框架升级（Ink/Blessed）
2. 分屏布局（左侧任务列表，右侧代码预览）
3. 实时进度条（百分比 + ETA）
4. 代码语法高亮预览
5. 键盘快捷键支持
6. 流式输出
7. 主题切换（深色/浅色）
8. 模糊匹配

用户已确认选择 **Ink (React-based)** 框架和 **完整改造** 方案。

---

## 实施计划

### 阶段一：基础设施（Week 1）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `src/tui/index.js` | TUI 入口 |
| 新增 | `src/tui/context/ThemeContext.jsx` | 主题上下文 |
| 新增 | `src/tui/context/TaskContext.jsx` | 任务状态上下文 |
| 新增 | `src/tui/styles/themes.js` | 深色/浅色主题定义 |
| 修改 | `package.json` | 添加 ink, react, highlight.js, fuzzysort |

**新增依赖**：
```json
{
  "ink": "^4.4.1",
  "react": "^18.2.0",
  "highlight.js": "^11.9.0",
  "fuzzysort": "^2.0.4"
}
```

### 阶段二：核心组件（Week 2）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `src/tui/App.jsx` | 主应用组件 |
| 新增 | `src/tui/components/SplitPane.jsx` | 分屏布局 |
| 新增 | `src/tui/components/TaskList.jsx` | 任务列表 |
| 新增 | `src/tui/components/TaskItem.jsx` | 任务项 |
| 新增 | `src/tui/components/ProgressBar.jsx` | 进度条（百分比 + ETA） |
| 新增 | `src/tui/components/StatusBar.jsx` | 状态栏 |

### 阶段三：输入与交互（Week 3）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `src/tui/components/InputLine.jsx` | 命令输入行 |
| 新增 | `src/tui/hooks/useKeyboard.js` | 键盘事件 Hook |
| 新增 | `src/tui/hooks/useFuzzyMatch.js` | 模糊匹配 Hook |
| 新增 | `src/tui/utils/fuzzyMatch.js` | 模糊匹配算法 |
| 新增 | `src/tui/TUISession.js` | TUI 会话管理 |

**键盘快捷键**：
| 快捷键 | 功能 |
|--------|------|
| `Ctrl+S` | 保存 checkpoint |
| `Ctrl+R` | 清除/重新执行 |
| `Ctrl+U` | 重置上下文 |
| `Ctrl+L` | 清屏 |
| `Ctrl+T` | 切换主题 |
| `Ctrl+H/L` | 调整分屏比例 |
| `↑/↓` | 历史命令 |
| `Tab` | 自动补全 |
| `F1` | 帮助面板 |

### 阶段四：代码预览与流式（Week 4）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `src/tui/components/CodePreview.jsx` | 代码预览面板 |
| 新增 | `src/tui/components/CodeBlock.jsx` | 语法高亮代码块 |
| 新增 | `src/tui/components/StreamOutput.jsx` | 流式输出组件 |
| 新增 | `src/tui/hooks/useStream.js` | 流式输出 Hook |
| 新增 | `src/tui/adapters/TUIEventAdapter.js` | 事件适配器 |
| 修改 | `src/providers/OllamaProvider.js` | 实现 streamGenerate 流式接口 |

### 阶段五：集成与测试（Week 5）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `src/tui/components/HelpPanel.jsx` | 帮助面板 |
| 新增 | `src/tui/components/Header.jsx` | 顶部标题栏 |
| 修改 | `src/cli/index.js` | 添加 `qidi tui` 命令入口 |
| 新增 | `test/tui_test.js` | TUI 测试 |
| 新增 | `test/stream_test.js` | 流式输出测试 |

---

## 关键文件

### 新增文件（~25个）

```
src/tui/
├── index.js                    # TUI 入口
├── App.jsx                    # 主应用
├── TUISession.js             # 会话管理
├── context/
│   ├── ThemeContext.jsx
│   └── TaskContext.jsx
├── components/
│   ├── SplitPane.jsx
│   ├── TaskList.jsx
│   ├── TaskItem.jsx
│   ├── CodePreview.jsx
│   ├── CodeBlock.jsx
│   ├── InputLine.jsx
│   ├── StatusBar.jsx
│   ├── ProgressBar.jsx
│   ├── Header.jsx
│   ├── HelpPanel.jsx
│   └── StreamOutput.jsx
├── hooks/
│   ├── useKeyboard.js
│   ├── useTheme.js
│   ├── useTaskEvents.js
│   ├── useFuzzyMatch.js
│   └── useStream.js
├── styles/
│   └── themes.js
├── utils/
│   └── fuzzyMatch.js
└── adapters/
    └── TUIEventAdapter.js
```

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/cli/index.js` | 添加 `qidi tui` 命令入口 |
| `src/providers/OllamaProvider.js` | 实现 streamGenerate 流式接口 |
| `src/providers/BaseProvider.js` | 添加 streamGenerate 基类方法 |
| `package.json` | 添加 ink, react, highlight.js, fuzzysort |

---

## 向后兼容性

保留现有命令，TUI 作为可选增强：

```bash
qidi interactive        # 默认调用 TUI（带 --classic 回退）
qidi interactive --classic  # 使用原有 readline 界面
qidi tui                # 直接启动 TUI
```

---

## 验证方案

### 单元测试
```bash
npm run test -- test/tui/fuzzyMatch.test.js
npm run test -- test/tui/stream.test.js
```

### 集成测试
```bash
npm run test -- test/tui/integration.test.js
```

### E2E 测试
```bash
npm run test -- test/e2e_tui.test.js
```

### 手动验证
```bash
# 启动 TUI
qidi tui --mode privacy

# 快捷键验证
# Ctrl+T 切换主题
# Ctrl+L 清屏
# scan 扫描工具
# mode quality 切换模式
# <任务描述> 执行任务
```

---

## 时间估算

| 阶段 | 内容 | 工期 |
|------|------|------|
| 阶段一 | 基础设施 | 1 周 |
| 阶段二 | 核心组件 | 1 周 |
| 阶段三 | 输入与交互 | 1 周 |
| 阶段四 | 代码预览与流式 | 1 周 |
| 阶段五 | 集成与测试 | 1 周 |
| **总计** | | **5 周** |

---

## 风险与备选

| 风险 | 缓解方案 |
|------|----------|
| Ink 与 Node.js 版本兼容 | 锁定 ink@4.4.1 + react@18.2.0 |
| 性能问题（高频 re-render） | 使用 React.memo + useMemo 优化 |
| 键盘事件冲突 | 使用 useEffect cleanup 清理监听 |
| 流式输出延迟 | 使用 Buffer 批量渲染 |
