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
| `AI_BRIDGE_HOST` | 127.0.0.1 | 监听地址（**仅本机**；改 0.0.0.0 前务必设 TOKEN） |
| `AI_BRIDGE_TOKEN` | 无 | API 鉴权 token（不设则无鉴权） |
| `AI_BRIDGE_CLIENT` | unknown | 作为 MCP 客户端时的身份名 |
| `AI_BRIDGE_EXECUTE_TIMEOUT` | 300000 | 单次执行超时(ms) |
| `AI_BRIDGE_CACHE_TTL` | 600000 | 反代幂等缓存 TTL(ms) |
| `AI_BRIDGE_CACHE_MAX` | 100 | 反代幂等缓存条目上限(LRU) |
| `AI_BRIDGE_DAILY_TOKEN_BUDGET` | 无 | 每日 token 预算，超出时 /api/health 告警 |
| `AI_BRIDGE_OLLAMA_BASE` | http://127.0.0.1:11434 | local-vl 模型的 Ollama 地址 |
| `CODELY_CLI_EXE` | 自动探测 | codely.exe 路径（UA 版本跟版用） |

## 功能

- **dispatch** — 并行派发任务给多个 AI 工具，自动故障转移
- **discuss** — 多 AI 讨论会（两轮 + 共识引擎 + 共识度评分 + 自动止损）
- **review** — 交叉评审（A 产出 → B 评审）
- **routing** — 7维贝叶斯路由评分自动选最佳工具（真实历史自学习）
- **handoff** — 接力续写（A 干不完 → B 接着干）
- **traffic** — 完整流量监控（所有 AI 和云端的通信记录）
- **OpenAI 反代** — `/v1/chat/completions` 统一暴露免费模型（含幂等缓存）
- **Anthropic 反代** — `/v1/messages` Claude Code 类工具直接接入
- **MCP 桥接** — 任何支持 MCP 的 AI 工具可接入

## OpenAI 反代模型

所有模型统一入口：`http://127.0.0.1:9800/v1`，API Key 随便填（本地代理不校验）。

| 模型 | 来源 | transport |
|------|------|-----------|
| agnes-2.0-flash / agnes-2.5-flash / auto | AgnesCode | agnes-http |
| glm-5.2 / deepseek-v4-flash / qwen3-vl-8b-instruct | AtomCode | cli |
| codely-core / codely-flash / codely-air / codely-vl / codely-basic | 团结 Cowork | codely-http |
| GLM-5.2 / GLM-5.3 / KIMI-K3 | 团结 Cowork | codely-http |
| qwen2.5-vl-local | 本地 Ollama | local-vl |

- **模型清单自动同步**：`POST /api/models/sync` 带签名拉上游 /v1/models，新模型自动注册进 models.json
- **幂等缓存**：非流式 200 响应按 sha256(model+messages+参数) 缓存，命中直接回放（`X-Cache: HIT`）
- **上游健康探测**：`GET /api/health?probe=1` 带签名实测 LiteLLM 连通性
- **用量报表**：`GET /api/usage/report?days=7` 按天/按模型聚合，Web UI「用量」Tab 可视化

### Codely（团结 Cowork）接入说明

`codely-http` transport 由 `codely-client.js` 内建实现（无需单独运行 codely2api 服务）：

1. 启动时自动探测 `~/.codely-cli/oauth_creds.json`（LocalSystem 服务下兜底扫描 `C:\Users\*`）
2. 用 `access_token` 调团结后端换取 `cli_api_key`（缓存 1 小时；401/403 自动换新重试）
3. 带 `X-Codely-Signature` 签名 + `x-litellm-session-id` + 自动跟版 UA（从本地 codely.exe 提取版本）转发
4. access_token 有效期监测：JWT exp 解析，剩 7 天内 /api/health 告警（微信登录无 refresh_token，需重开 Codely CLI 登录）

前提：本机已安装并登录团结 Cowork 桌面端。支持流式（stream）与非流式调用，流量自动记录进 traffic 监控。

### Claude Code / Anthropic 兼容客户端接入

```
ANTHROPIC_BASE_URL: http://127.0.0.1:9800
API Key:  随便填
模型名:   codely-core / GLM-5.3 等（仅 codely-http 模型；上游需 ?beta=1 已自动附加）
```

### zcode / 任何 OpenAI 兼容客户端接入

```
Base URL: http://127.0.0.1:9800/v1
API Key:  随便填（如 sk-1234）
模型名:   codely-core / GLM-5.3 / codely-flash / codely-vl 等（见上表）
```


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
├── codely-client.js       # 团结 LiteLLM 客户端(凭据/签名/UA跟版/请求)
├── bridge-stdio.js        # MCP stdio 桥接器 (17 个 MCP 工具)
├── tool-registry.js       # 配置驱动工具注册表
├── routing-score.js       # 7维复合路由评分
├── tool-identity.js       # 工具身份归一化
├── observe.js             # 工具 baseUrl 接管
├── edge-agent.js          # 云端边缘代理
├── db.js                  # SQLite 全局数据库 (6 张表 + 用量报表)
├── store.js               # JSON 持久化 + 日志轮转
├── watchdog.js            # 进程守护
├── adapters/
│   ├── base.js            # 基类 + parsePath 引擎
│   ├── cli-adapter.js     # CLI 传输
│   └── http-adapter.js    # HTTP 传输
├── tools.json             # 工具配置
├── models.json            # 模型注册表
├── ui.html                # Web UI (8 Tab)
├── mitm-addon.py          # mitmproxy 流量捕获
├── start-mitm.bat         # mitmproxy 启动脚本
├── read-cred.ps1          # Windows 凭据读取（AgnesCode token）
├── start.bat              # 服务启动脚本
├── test-unit.mjs          # 单元测试 (43 用例)
└── test-e2e.mjs           # E2E 测试
```
