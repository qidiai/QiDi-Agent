# AI Bridge — AI 工具调度中枢

本机常驻 HTTP 服务，统一调度多个 AI 编程工具。

## 快速开始

```bash
cd ai-bridge
npm install        # 安装 ws 依赖
node server.js     # 启动服务 (端口 9800)
```

浏览器打开 `http://127.0.0.1:9800` 即可访问 Web UI。

## 前置条件

- Node.js 22+（使用内置 `node:sqlite`）
- 已安装至少一个 AI 编程工具的 CLI（如 OpenClaw、AtomCode）

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AI_BRIDGE_PORT` | 9800 | 服务端口 |
| `AI_BRIDGE_HOST` | 127.0.0.1 | 监听地址 |
| `AI_BRIDGE_TOKEN` | 无 | API 鉴权 token（不设则无鉴权） |
| `AI_BRIDGE_CLIENT` | unknown | 作为 MCP 客户端时的身份名 |
| `AI_BRIDGE_EXECUTE_TIMEOUT` | 300000 | 单次执行超时(ms) |

## 功能

- **dispatch** — 并行派发任务给多个 AI 工具，自动故障转移
- **discuss** — 多 AI 讨论会（两轮 + 共识引擎 + 自动止损）
- **review** — 交叉评审（A 产出 → B 评审）
- **routing** — 7维贝叶斯路由评分自动选最佳工具
- **handoff** — 接力续写（A 干不完 → B 接着干）
- **traffic** — 完整流量监控（所有 AI 和云端的通信记录）
- **OpenAI 反代** — `/v1/chat/completions` 统一暴露免费模型
- **MCP 桥接** — 任何支持 MCP 的 AI 工具可接入

## 配置文件

| 文件 | 说明 | 首次运行 |
|------|------|---------|
| `tools.json` | 工具配置（CLI/HTTP/routing-marker） | 已包含 |
| `models.json` | OpenAI 反代模型注册表 | 已包含 |
| `switches.json` | 工具开关 | 自动生成 |
| `clients-acl.json` | 客户端准入控制 | 自动生成 |
| `token-stats.json` | Token 统计 | 自动生成 |
| `memory.json` | 任务历史 + 经验 + 会议 | 自动生成 |

## 测试

```bash
node test-unit.mjs    # 纯单元测试
node test-e2e.mjs     # 全链路 E2E（使用端口 9810，不影响生产）
```

## 新增工具

编辑 `tools.json`，加一段配置：

```json
{
  "name": "my-tool",
  "displayName": "My Tool",
  "transport": "cli",
  "command": "mytool",
  "args": ["--prompt", "{{task}}"],
  "inputMode": "arg",
  "outputMode": "stdout-text",
  "timeout": 120000
}
```

重启服务即可，不改代码。

## MCP 客户端接入

在 AI 工具的 MCP 配置中注册 `bridge-stdio.js`：

```json
{
  "mcpServers": {
    "ai-bridge": {
      "command": "node",
      "args": ["/path/to/ai-bridge/bridge-stdio.js"],
      "env": {
        "AI_BRIDGE_CLIENT": "my-ai-tool",
        "AI_BRIDGE_PORT": "9800"
      }
    }
  }
}
```

## mitmproxy 流量监控（可选）

```bash
pip install mitmproxy
# 首次运行安装 CA 证书到受信任根证书
start-mitm.bat
```

## 进程守护（可选）

```bash
node watchdog.js    # 自动重启 + 熔断（连续崩溃5次停止）
```

## 文件结构

```
ai-bridge/
├── server.js              # HTTP 常驻服务 (40+ API 端点)
├── bridge-stdio.js        # MCP stdio 桥接器 (17 个 MCP 工具)
├── tool-registry.js       # 配置驱动工具注册表
├── routing-score.js       # 7维复合路由评分
├── tool-identity.js       # 工具身份归一化
├── observe.js             # 工具 baseUrl 接管
├── edge-agent.js          # 云端边缘代理
├── db.js                  # SQLite 全局数据库 (6 张表)
├── store.js               # JSON 持久化 + 日志轮转
├── watchdog.js            # 进程守护
├── adapters/
│   ├── base.js            # 基类 + parsePath 引擎
│   ├── cli-adapter.js     # CLI 传输
│   └── http-adapter.js    # HTTP 传输
├── tools.json             # 工具配置
├── models.json            # 模型注册表
├── ui.html                # Web UI (7 Tab)
├── mitm-addon.py          # mitmproxy 流量捕获
├── start-mitm.bat         # mitmproxy 启动脚本
├── read-cred.ps1          # Windows 凭据读取（AgnesCode token）
├── start.bat              # 服务启动脚本
├── test-unit.mjs          # 单元测试
└── test-e2e.mjs           # E2E 测试
```
