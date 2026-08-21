# AI Bridge 架构图

> 更新：2026-08-22（完善深化：安全加固 + 反代健壮性 + 新端点 + 模块拆分）

## 模块分层

```
┌────────────────────────────────────────────────────────────────┐
│ 接入层(仅本机 127.0.0.1:9800)                                   │
│  bridge-stdio.js   MCP stdio 桥接器(17 个 MCP 工具)             │
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
│ codely-client.js  团结 LiteLLM 客户端(独立模块)                  │
│  ├─ 凭据定位(oauth_creds.json, LocalSystem 兜底扫描)             │
│  ├─ cli_api_key 换取(缓存1h) + 401 失效重取                      │
│  ├─ X-Codely-Signature 签名(逆向自官方 CLI)                      │
│  ├─ UA 自动跟版(扫 codely.exe 版本串,失败回退 release.52)         │
│  └─ access_token JWT exp 监测(到期告警;无 refresh_token)          │
├────────────────────────────────────────────────────────────────┤
│ 注册表                                                          │
│  tool-registry.js  工具配置注册表(读 tools.json)                 │
│  tool-identity.js  工具身份归一化(canonical/实例ID分离)           │
│  routing-score.js  7维贝叶斯路由评分(衰减加权+Wilson+冷却)        │
├────────────────────────────────────────────────────────────────┤
│ 适配层 adapters/   base.js / cli-adapter.js / http-adapter      │
├────────────────────────────────────────────────────────────────┤
│ 持久层                                                          │
│  db.js             SQLite 全局库(7表: dispatches/meetings/       │
│                    reviews/async_tasks/events/traffic+用量报表)  │
│  store.js          JSON 持久化(memory.json) + 日志轮转           │
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
  ├─ transport=codely-http ──→ ① getCodelyCliApiKey()
  │        oauth_creds.json 的 access_token
  │        → codely.tuanjie.cn/api/api-token/cli-api-key 换 key(缓存 1h)
  │    ② buildCodelyHeaders(path, key, body)
  │        signingKey = HMAC-SHA256(HMAC-SHA256(SECRET,"codely-signing-v1"), key)
  │        X-Codely-Signature = "v1."+unix秒+"."+base64url(HMAC(key,"v1\n"+path+"\n"+ts))
  │        UA = codely-cli/{本地exe提取版本} (win32; x64)
  │    ③ forwardCodelyLiteLLM() → codely-litellm.tuanjie.cn
  │        流式 SSE/非流式透传; 401/403 → invalidate + 换新 key 重试一次
  │        重试仍 401 → error 日志告警(官方可能换签名算法)
  │        非流式 200 → 写入幂等缓存
  │
  ├─ transport=local-vl ──→ Ollama /api/chat (127.0.0.1:11434)
  │        OpenAI 消息转 Ollama 格式(图片 image_url→base64 images)
  │        流式: NDJSON→OpenAI SSE 逐块转换; 非流式: 直接映射+usage
  │
  └─ transport=cli ──→ CliAdapter spawn 子工具 CLI(atomcode 等)
```

## Anthropic 反代数据流（/v1/messages）

```
Claude Code 类客户端(ANTHROPIC_BASE_URL=http://127.0.0.1:9800)
  │  POST /v1/messages {model, messages, stream?}   (仅 codely-http 模型)
  ▼
server.js → findModel → forwardCodelyLiteLLM
  签名按纯 path=/v1/messages 计算(官方拦截器用 URL.pathname)
  实际请求 URL = /v1/messages?beta=1(上游 Anthropic 兼容层要求)
  响应原样透传(Anthropic 格式,含 SSE)
```

## 模型清单自动同步（POST /api/models/sync）

```
GET LiteLLM /v1/models(带签名) → 上游模型列表
  → diff models.json 中 transport=codely-http 条目
  → 新增: {id, owned_by:codely, switch:codely, transport:codely-http}
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

## 影响链（改 A 影响谁）

| 改动点 | 影响 |
|--------|------|
| models.json | /v1/models 清单、transport 分支选择、模型同步 diff 基线 |
| switches.json | 禁用工具 → 模型从清单消失、dispatch 跳过 |
| codely-client.js 签名函数/SECRET | 所有 codely-http 模型 + /v1/messages + /api/models/sync + health probe |
| 上游强制签名策略变更 | 持续 401 → error 日志告警,需重新逆向 codely.exe(查 CODELY_SIGNING_SECRET 与算法) |
| oauth_creds.json 登出/过期 | 换 key 失败 → 500 + 明确指引;health 的 tokenDaysLeft 提前 7 天预警 |
| codely.exe 升级 | UA 自动跟版(重启进程后生效);若版本串格式变化回退 release.52 |
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
| ~/.codely-cli/oauth_creds.json | codely-client → cli_api_key 换取(本地文件,不入库) |
| AI_BRIDGE_CACHE_TTL/MAX | 反代幂等缓存 |
| AI_BRIDGE_DAILY_TOKEN_BUDGET | /api/health 预算告警 |
| AI_BRIDGE_OLLAMA_BASE / CODELY_CLI_EXE | local-vl 上游 / UA 版本探测 |

## 修复/演进清单

- [x] 2026-08-21 反代修复:上游团结 LiteLLM 强制 X-Codely-Signature,旧实现 401。新增签名算法+401换key重试。
- [x] 2026-08-22 安全:服务绑定 0.0.0.0→127.0.0.1(堵局域网白嫖);清理 34 个 .bak/_patch 残留。
- [x] 2026-08-22 健壮:UA 自动跟版(扫 exe 版本串);持续 401 告警;token JWT 到期监测(剩7天预警)。
- [x] 2026-08-22 功能:/v1/messages Anthropic 反代(?beta=1);local-vl Ollama 实现(NDJSON→SSE);幂等缓存(X-Cache:HIT);模型清单自动同步(/api/models/sync);用量报表(/api/usage/report+Web UI 用量Tab);共识度评分(discuss)。
- [x] 2026-08-22 工程:codely-client.js 拆分;43/43 单测全过(签名单测 8 项);全端点真实调用回归。
