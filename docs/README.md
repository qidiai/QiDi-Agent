# 启迪 Agent (Qidi) 文档中心

> 版本 v1.1.0 · 更新日期 2026-06-28

本目录是 Qidi Agent 项目的文档总入口。所有文档统一在此索引，新增文档请同步更新本文件。本轮变更详见仓库根目录 [CHANGELOG.md](../CHANGELOG.md)。

---

## 📚 文档索引

| 文档 | 用途 | 目标读者 |
|------|------|----------|
| [CLI_GUIDE.md](./CLI_GUIDE.md) | 命令行交互式界面完整使用指南 | 终端用户、开发者 |
| [WEBUI_GUIDE.md](./WEBUI_GUIDE.md) | Web UI 编程界面与文件管理使用指南 | 普通用户、运维 |
| [OPERATION_GUIDE.md](./OPERATION_GUIDE.md) | 全部命令速查与详细参数说明 | 所有用户 |
| [API.md](./API.md) | REST API 接口参考（含文件管理 API） | 前端、集成开发者 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统架构与模块设计 | 贡献者、架构师 |
| [NEXT_PLAN.md](./NEXT_PLAN.md) | 待办优化计划与已知问题 | 维护者 |

---

## 🚀 快速入口

- **第一次使用** → 先看 [OPERATION_GUIDE.md](./OPERATION_GUIDE.md) 的"快速启动"
- **想用命令行交互编程** → 看 [CLI_GUIDE.md](./CLI_GUIDE.md) 的"交互式 REPL"
- **想用浏览器图形界面** → 看 [WEBUI_GUIDE.md](./WEBUI_GUIDE.md) 的"Agent 页"
- **想二次开发/集成** → 看 [API.md](./API.md) 的 REST API 参考
- **想了解整体设计** → 看 [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## 📝 文档规范

### 命名约定

- 使用大写英文 + 下划线：`CLI_GUIDE.md`、`API.md`
- 专题文档放在 `docs/`，项目级说明（README、CHANGELOG、CONTRIBUTING）放仓库根目录
- 中文文档为主，技术术语保留英文

### 结构约定

每篇文档应包含：

1. **标题行**：`# 文档名 | 简短描述`
2. **元信息块**：版本号、更新日期
3. **目录**（文档较长时）
4. **正文**：分章节，使用二级标题 `##`
5. **变更记录**（可选）：附录记录重要修订

### 更新流程

1. 修改代码同步更新对应文档
2. 新增文档必须在本索引中登记
3. 重大变更同步更新根目录 `CHANGELOG.md`
4. 文档与代码同样接受 PR Review

### 链接约定

- 文档间互链使用相对路径：`[API](./API.md)`
- 引用代码使用反引号：`src/core/WebUIServer.js`
- 引用命令使用反引号：`qidi interactive`

---

## 🔄 最近更新

### v1.1.0（2026-06-28）

- **WebUI**：Agent 页改为聊天式布局；删除 Agent 页模型多选框，模型统一在「模型管理」页启用；隐私/高质量模式不再写死 ollama；工具管理恢复独立页；报告并入「文件与报告」页
- **后端**：`_executeTask` 删除 `models || ['ollama']` 写死，改为用所有启用模型
- **文档**：重写 `WEBUI_GUIDE.md`，更新 `API.md` 的 `/api/tasks/execute`，新建根目录 `CHANGELOG.md`
- 详见 [CHANGELOG.md](../CHANGELOG.md)

### v1.0.0（2026-06-28 初版）

- 新增 `CLI_GUIDE.md`：交互式 REPL 完整使用说明（多行输入、历史、上下文记忆）
- 新增 `WEBUI_GUIDE.md`：编程控制台增强与文件管理页面使用说明
- 更新 `API.md`：新增统一文件管理 API 章节
- 更新 `OPERATION_GUIDE.md`：补充 `interactive` 命令的新参数
- 更新 `ARCHITECTURE.md`：补充 `InteractiveSession` 与文件管理模块
- 更新 `NEXT_PLAN.md`：标记本次已完成项，补充新发现的待办
