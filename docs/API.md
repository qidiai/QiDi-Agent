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
  "provider": "ollama"
}
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
