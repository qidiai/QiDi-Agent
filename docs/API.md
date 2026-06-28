# API 文档 | Qidi Agent REST API Reference

- **Base URL**: `http://localhost:3000`
- **Content-Type**: `application/json`

---

## 健康检查

### `GET /api/health`

```json
{ "status": "ok", "timestamp": 1782584000000, "version": "1.0.0" }
```

---

## 仪表盘

### `GET /api/dashboard`

返回系统状态概览（工具数、Agent 数、任务数、Token 用量）。

---

## 工具管理

### `GET /api/tools`
列出所有已注册工具及其状态。

### `POST /api/tools/scan`
触发本机 AI 工具扫描。

### `POST /api/tools/connect/:name`
连接指定工具。`name` 为工具标识（如 `claude-code`）。

### `GET /api/tools/:name/detail`
获取指定工具详情。

---

## Agent 管理

### `GET /api/agents`
列出所有 Agent。

### `GET /api/agents/:name/status`
获取指定 Agent 状态。

### `POST /api/agents/:name/enable`
启用指定 Agent。

### `POST /api/agents/:name/disable`
禁用指定 Agent。

---

## 路由配置

### `GET /api/routing/config`
获取当前路由配置（策略、手动路由表等）。

### `POST /api/routing/config`
保存路由配置。

**Body**:
```json
{ "strategy": "capability", "manualRouting": {} }
```

---

## 执行模式

### `GET /api/modes`
获取所有执行模式及当前模式。

### `GET /api/modes/compare`
对比隐私模式与高质量模式配置差异。

### `POST /api/modes/recommend`
根据任务描述推荐最佳执行模式。

**Body**:
```json
{ "task": "写一个支付处理模块" }
```

---

## 模型管理

### `POST /api/models`
添加/保存模型配置。

### `PUT /api/models/:name`
更新指定模型配置。

### `DELETE /api/models/:name`
删除指定模型配置。

---

## 任务执行

### `POST /api/tasks/execute`
提交任务执行。

**Body**:
```json
{
  "task": "用Python写一个Web服务器",
  "mode": "privacy",
  "constraints": { "language": "Python", "platform": "Web" }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task` | string | 是 | 任务描述 |
| `mode` | string | 否 | 执行模式 `privacy` / `quality`，默认 `privacy` |
| `models` | string[] | 否 | 指定模型名列表。**不传或为空时，后端自动使用所有已启用模型**（`AgentHub.getEnabledAgents()`） |
| `constraints` | object | 否 | 约束条件，如 `{ "language": "Python", "platform": "Web" }`，会拼接到任务描述 |

> 🔧 **v1.1.0 变更**：原写死 `models || ['ollama']` 的 fallback 已删除（`src/core/WebUIServer.js` `_executeTask()`）。现在不传 `models` 时用所有启用模型，前端 Agent 页即采用此方式。隐私模式和高质量模式都遵循此规则，不再写死 ollama。

**响应**:
```json
{ "success": true, "taskId": "task_1782610303000" }
```

### `GET /api/tasks/:taskId/status`
查询任务执行状态。

### `GET /api/tasks`
列出所有任务历史。

---

## 文件查看

### `GET /api/files/view?path=<relative-path>`
查看工作目录中的文件内容。路径穿越防护：只允许访问 workspace 内文件。

---

## Token 统计

### `GET /api/tokens`
获取 Token 使用统计。

---

## 报告

### `GET /api/reports?tag=<tag>&limit=<n>`
列出实验报告。

### `GET /api/reports/:id`
加载指定报告。

### `GET /api/reports/tags/list`
列出所有报告标签。

---

## 文件管理（v1.0.0 新增统一 API）

所有路径均相对于 `workspaceDir`，自动防穿越。访问工作目录之外的路径返回 `403`。

### `GET /api/files?path=<rel>&recursive=<0|1>`

列出目录或查看文件元信息。

- `path`：相对路径，默认 `.`
- `recursive`：`1`/`true` 递归列出子目录（最多 2000 项）

返回（目录）：

```json
{
  "path": ".",
  "exists": true,
  "type": "dir",
  "entries": [
    { "name": "main.py", "path": "main.py", "type": "file", "size": 1234, "modified": 1782583000000, "lang": "python" },
    { "name": "sub", "path": "sub", "type": "dir" }
  ],
  "total": 2
}
```

返回（文件）：

```json
{ "path": "main.py", "exists": true, "type": "file", "size": 1234, "modified": 1782583000000, "lang": "python" }
```

### `GET /api/files/read?path=<rel>`

读取文件内容。自动识别二进制：

```json
{
  "success": true,
  "path": "main.py",
  "content": "print('hi')",
  "encoding": "utf-8",        // 二进制为 "base64"
  "size": 12,
  "modified": 1782583000000,
  "lang": "python",
  "binary": false
}
```

### `POST /api/files/write`

写入文件（自动创建父目录）。

```json
// 请求
{ "path": "notes/todo.md", "content": "# TODO\n", "encoding": "utf-8" }
// encoding 可选 "utf-8"（默认）或 "base64"

// 响应
{ "success": true, "path": "notes/todo.md", "size": 8, "modified": 1782583000000, "message": "文件已保存" }
```

### `POST /api/files/rename`

重命名/移动文件。

```json
{ "from": "old.py", "to": "new.py" }
```

### `POST /api/files/delete`

删除文件或目录（目录会递归删除）。

```json
{ "path": "notes/old.md" }
```

### `POST /api/files/mkdir`

创建目录（含父目录）。

```json
{ "path": "a/b/c" }
```

### `POST /api/files/upload`

批量上传文件到指定目录。

```json
// 请求
{
  "path": "uploads",           // 可选，目标目录，默认工作目录根
  "files": [
    { "name": "a.txt", "content": "...", "encoding": "utf-8" },
    { "name": "b.bin", "content": "base64...", "encoding": "base64" }
  ]
}

// 响应
{ "success": true, "uploaded": [ { "name": "a.txt", "success": true, "path": "uploads/a.txt", ... } ] }
```

### `GET /api/files/download?path=<rel>`

下载文件原始内容，响应头含 `Content-Disposition: attachment`。目录返回 `400`。

### `GET /api/files/view?path=<rel>`（兼容旧版）

直接返回文件原文（`text/plain`）。二进制文件以 `base64` 返回。新前端推荐使用 `/api/files/read`。

---

## 统计

### `GET /api/stats/overview`
获取全局统计概览。

---

## 错误响应格式

所有接口在出错时返回：

```json
{ "error": "错误描述" }
```

HTTP 状态码：`400`（参数错误）/ `403`（禁止访问）/ `404`（不存在）/ `500`（内部错误）
