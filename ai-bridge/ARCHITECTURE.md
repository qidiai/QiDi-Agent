# AI Bridge 架构图

> 更新：2026-10-21（工作区管理：登记/受管目录 + dispatch/handoff cwd 绑定 + 归档/租约）

## 模块分层

```
┌────────────────────────────────────────────────────────────────┐
│ 接入层(仅本机 127.0.0.1:9800)                                   │
│  bridge-stdio.js   MCP stdio 桥接器(20 个 MCP 工具)             │
│  ui.html           Web UI(8 Tab:仪表盘/派发/讨论/记忆/日志/流量/用量/模型) │
└──────────────┬─────────────────────────────────────────────────┘
┌──────────────▼─────────────────────────────────────────────────┐
│ 服务层 server.js (HTTP 常驻, nssm 服务 AIBridgeHub)              │
│  ├─ /api/*          调度/讨论/评审/记忆/流量/观测/用量 API        │
│  ├─ /api/health     健康检查(token到期/预算/?probe=1上游探测)     │
│  ├─ /v1/models + /api/models/sync   模型清单与自动同步            │
│  ├─ /v1/chat/completions            OpenAI 兼容反代(含幂等缓存)   │
│  ├─ /v1/messages                    Anthropic 兼容反代(?beta=1) │
│  ├─ /proxy/<source>/<key>/...       透传观测代理                  │
│  └─ 凭据区: AgnesToken(凭据管理器) / AtomToken(auth.toml)         │
├────────────────────────────────────────────────────────────────┤
│ 注册表                                                          │
│  tool-registry.js  工具配置注册表(读 tools.json)                 │
│  tool-identity.js  工具身份归一化(canonical/实例ID分离)           │
│  routing-score.js  7维贝叶斯路由评分(衰减加权+Wilson+冷却)        │
│  workspace-manager.js 工作区注册表(登记/受管/归档/独占租约)       │
├────────────────────────────────────────────────────────────────┤
│ 适配层 adapters/   base.js / cli-adapter.js / http-adapter      │
├────────────────────────────────────────────────────────────────┤
│ 持久层                                                          │
│  db.js             SQLite 全局库(7表: dispatches/meetings/       │
│                    reviews/async_tasks/events/traffic+用量报表)  │
│  store.js          JSON 持久化(memory.json/workspaces.json) + 日志轮转 │
│  observe.js        工具 baseUrl 接管/代理路由                     │
│  watchdog.js       进程守护(自动重启+熔断)                        │
└────────────────────────────────────────────────────────────────┘
```

## OpenAI 反代数据流（/v1/chat/completions）

```
客户端(Base URL=http://127.0.0.1:9800/v1)
  │  POST {model, messages, stream?}
  ▼
server.js → findModel(models.json) → modelEnabled(switches.json)
  │
  ├─ 幂等缓存查询(sha256(model+messages+参数), TTL 10min, LRU 100)
  │    命中 → X-Cache: HIT 直接回放(非流式) / 合成单块 SSE(流式)
  │
  ├─ transport=agnes-http ──→ AgnesCode 上游(凭据管理器 token)
  │
  ├─ transport=local-vl ──→ Ollama /api/chat (127.0.0.1:11434)
  │        OpenAI 消息转 Ollama 格式(图片 image_url→base64 images)
  │        流式: NDJSON→OpenAI SSE 逐块转换; 非流式: 直接映射+usage
  │
  └─ transport=cli ──→ CliAdapter spawn 子工具 CLI(atomcode/codely 等)
        Codely 路线: spawn 官方 codely.exe -y --model <id> -p <task>
        (2026-08-26 起: codely-http 自签直连因 session 签名检测被封号,已弃用)
```

## Anthropic 反代数据流（/v1/messages）

```
Claude Code 类客户端(ANTHROPIC_BASE_URL=http://127.0.0.1:9800)
  │  POST /v1/messages {model, messages, stream?}
  ▼
server.js → findModel → transport 上游
  上游需要 Anthropic 兼容层时附加 ?beta=1(官方拦截器用 URL.pathname 计算签名)
  响应原样透传(Anthropic 格式,含 SSE)
```

## 模型清单自动同步（POST /api/models/sync）

```
GET 上游 /v1/models(带鉴权) → 上游模型列表
  → diff models.json 中对应 transport 条目
  → 新增: {id, owned_by, switch, transport}
  → 写回 models.json + 失效内存缓存
```

## 路由自学习闭环（已存在，无新代码）

```
doDispatch → store.recordTask(results{success,duration,tokens,fallbackLog})
  → getToolObservations(含 fallback 失败补偿样本)
  → buildRoutingProfile(14天半衰期加权 + Bayesian成功率 + Wilson稳定性 + 30min失败冷却)
  → 下次 dispatch 未指定 tools 时 rankRoutingProfiles 自动选优
```

## 讨论会流程（runDiscussionAsync）

```
创建(异步返回 meetingId) → 第一轮各自发言 → (可中断/注入/自动止损)
  → 第二轮互相回应 → 共识总结(结论/分歧/行动项→经验库)
  → 共识度评分(每位参与者表态 赞成/有保留/反对 → N% 共识度)
  → 可选自动实现(doDispatch) → closeMeeting + SQLite 写穿
```

## 工作区流程（workspace-manager）

```
POST /api/workspaces {name, path?, exclusive?}
  ├─ 无 path → managed: 在 AI_BRIDGE_WORKSPACE_ROOT 下创建目录(受管,可回收)
  └─ 有 path → linked:  登记已存在目录(绝对路径/拒绝根目录,永不删文件)
  → workspaces.json 原子写入(store.saveSync)
  ▼
dispatch/handoff 带 workspace(id/name/path 均可解析)
  → resolveForDispatch(归档/不存在 → 4xx)
  → beginRun 租约(exclusive 工作区已有运行 → 409)
  → CliAdapter cwd={{workspaceDir}}, {{workspaceDir}} 模板 = 工作区路径
  → finally endRun(释放租约;更新 useCount/lastUsedAt)
  ▼
archive/restore 切换 status;运行中工作区禁止归档/删除
remove: linked 仅解除登记;managed + delete_files=1 且 realpath 严格落在根内才递归删除
```

## 影响链（改 A 影响谁）

| 改动点 | 影响 |
|--------|------|
| models.json | /v1/models 清单、transport 分支选择、模型同步 diff 基线 |
| workspaces.json | /api/workspaces、dispatch/handoff 的 cwd 绑定、归档/租约判定 |
| switches.json | 禁用工具 → 模型从清单消失、dispatch 跳过 |
| codely-client.js 缺失(开源版) | codely-http 模型不可用,health/probe 返回明确错误 |
| Ollama 未运行 | local-vl 模型返回 502/503 明确指引 |
| /v1 反代不可用 | 所有 Base URL 指向 9800 的客户端(zcode/Claude Code 等)报错 |
| nssm 服务环境变量 | AI_BRIDGE_HOST 改 0.0.0.0 会暴露无鉴权端点(已改回 127.0.0.1) |

## 配置消费者

| 文件/环境变量 | 消费者 |
|------|--------|
| tools.json | tool-registry → /api/tools、dispatch、讨论会 |
| models.json | loadModels → /v1/models、/v1/chat/completions、/v1/messages |
| switches.json | isToolEnabled → 工具开关、模型过滤 |
| clients-acl.json | 准入控制(白名单/黑名单/待审批) |
| workspaces.json | workspace-manager → /api/workspaces、dispatch/handoff |
| AI_BRIDGE_WORKSPACE_ROOT | managed 工作区根目录(创建/回收边界) |
| AI_BRIDGE_CACHE_TTL/MAX | 反代幂等缓存 |
| AI_BRIDGE_DAILY_TOKEN_BUDGET | /api/health 预算告警 |
| AI_BRIDGE_OLLAMA_BASE | local-vl 上游地址 |

## 修复/演进清单

- [x] 2026-08-21 反代修复:上游强制签名策略,旧实现 401。新增签名校验+401换key重试。
- [x] 2026-08-22 安全:服务绑定 0.0.0.0→127.0.0.1(堵局域网白嫖);清理 34 个 .bak/_patch 残留。
- [x] 2026-08-22 健壮:UA 自动跟版(扫 exe 版本串);持续 401 告警;token JWT 到期监测(剩7天预警)。
- [x] 2026-08-22 功能:/v1/messages Anthropic 反代(?beta=1);local-vl Ollama 实现(NDJSON→SSE);幂等缓存(X-Cache:HIT);模型清单自动同步(/api/models/sync);用量报表(/api/usage/report+Web UI 用量Tab);共识度评分(discuss)。
- [x] 2026-08-22 工程:codely-client.js 拆分为可选模块(开源版剔除);单测全过(签名单测 8 项);全端点真实调用回归。
- [x] 2026-08-26 安全:官方按 session 签名检测封号(3个号全灭),codely-http 自签直连永久弃用;models.json 新增 glm-5.3/codely-core/codely-flash/kimi-k3 走 cli transport(spawn 官方 CLI,官方明示安全路径);switches.json 新增 codely-cli 开关;端到端测试通过。
- [x] 2026-08-26 调度:tools.json 注册 codely 为 dispatch 工具(spawn 官方 CLI,30min超时,默认模型跟随 codely settings);QIDI Code 经 MCP(.mcp.json 已接 bridge-stdio.js)可派发任务给 Codely;dispatch 端到端测试通过(10.4s)。
- [x] 2026-08-26 调度:新增 codely-k3 工具变体(--model KIMI-K3 执行),测试通过(100.2s,注意 K3 比 GLM-5.3 慢约10倍)。QIDI 侧只能用 K3 当执行模型,不能当大脑(bridge cli transport 无 tool_calls 协议,QIDI agent 循环不兼容)。
- [x] 2026-10-21 工作区(P0-1):新增 workspace-manager.js + workspaces.json;dispatch/handoff 支持 workspace 绑定,CLI 以工作区为 cwd;登记(linked)/受管(managed)双模式、归档/恢复、独占租约;HTTP /api/workspaces* 与 MCP list_workspaces/create_workspace;测试 test-workspace.mjs + E2E 工作区链路。
