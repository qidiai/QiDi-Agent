# 贡献指南 | Contributing Guide

欢迎为 Qidi Agent 项目贡献代码！本文档旨在帮助你快速了解如何参与项目开发。

## 开发环境搭建

### 1. 克隆仓库

```bash
git clone https://github.com/qidiai/QiDi-Agent.git
cd QiDi-Agent
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，配置必要的环境变量
```

### 4. 运行测试

```bash
npm test                    # 运行综合测试
npm run test:e2e            # 运行真机 e2e 测试（需 Ollama）
npm run lint                # 运行 lint 检查
npm run lint:fix            # 自动修复 lint 问题
```

## 代码风格

项目使用 ESLint 进行代码检查，遵循以下规则：

- **代码风格**: Standard JS
- **缩进**: 2 个空格
- **引号**: 单引号
- **分号**: 必须
- **变量命名**: camelCase
- **函数命名**: camelCase
- **类命名**: PascalCase
- **常量**: UPPER_SNAKE_CASE

### 注意事项

- 避免使用 `console.log()`，使用 `Logger` 替代
- Promise 参数命名需匹配 `/^_?resolve$/`
- 避免在 case 块中直接声明变量（需使用花括号）
- 避免不必要的 try/catch 包装

## 提交规范

### Commit Message 格式

```
<type>: <subject>

<body>

<footer>
```

### Type 类型

| 类型 | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档更新 |
| `style` | 代码格式（不影响功能） |
| `refactor` | 重构（既不新增功能也不修复 Bug） |
| `test` | 测试相关 |
| `chore` | 构建/工具相关 |

### 示例

```
feat: 新增 multi 模式支持多 Provider 并行

- 在 ExecutionModeManager 中添加 multi 模式配置
- 在 TaskExecutor 中实现 _executeMultiProviderMode 方法
- 在 CLI 中接通 multi 模式参数
```

## 添加新适配器

### 适配器接口

所有适配器必须继承 `BaseToolAdapter` 并实现以下方法：

```js
class MyToolAdapter extends BaseToolAdapter {
  constructor() {
    super('my-tool', 'My Tool');
  }

  async isAvailable() {
    // 返回工具是否可用
  }

  async execute(task, options = {}) {
    // 执行工具
  }
}
```

### 注册适配器

在 `src/adapters/index.js` 中注册新适配器：

```js
const MyToolAdapter = require('./MyToolAdapter');

function createAll() {
  return [
    // ... 其他适配器
    new MyToolAdapter()
  ];
}
```

## Pull Request 流程

1. **Fork 仓库**
2. **创建分支**: `feature/xxx` 或 `fix/xxx`
3. **提交代码**: 遵循提交规范
4. **运行测试**: 确保所有测试通过
5. **创建 PR**: 描述变更内容和验证方式
6. **代码审查**: 等待维护者审查

## 问题反馈

### Bug 报告

请在 Issue 中包含以下信息：

- 版本号
- 复现步骤
- 预期结果
- 实际结果
- 错误日志（如有）

### 功能请求

请描述：

- 功能用途
- 使用场景
- 期望行为

## 社区规范

请遵守 [Code of Conduct](CODE_OF_CONDUCT.md)，尊重他人，友好协作。

---

**Qidi Agent Team**
