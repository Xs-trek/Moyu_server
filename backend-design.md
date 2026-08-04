# moyu v0.0.2 后端设计定稿

本文是 v0.0.2 的实现基线。它只描述已实现能力、已知边界和后续适配器扩展点，不把前端视觉或新的安全模型带入后端范围。

## 1. 目标与边界

moyu 是本机 AI CLI 的远程控制面。手机只连接 PC 上的 moyu；moyu 只负责启动和驱动用户已经安装、已经登录的原生 CLI。AI 服务端连接、认证、请求格式和客户端身份始终由 CLI 自己产生。

固定约束：

- 后端对 AI provider 0 出站、0 探针、0 token exchange、0 provider SDK。
- 不使用 `clientInfo`、远程控制标记、隐藏 system prompt 或共享中继账号。
- 不修改 Claude/Codex 原生认证文件。多账号只是引用 PC 上已有凭证集。
- 不自动重试 AI 轮次；避免重复计费、重复写文件或重复执行工具。
- 只使用进程内状态、有限队列和有限重放窗口，不引入数据库、消息队列或常驻 worker 集群。
- 网关只绑定 loopback，经 EasyTier 的 no-tun/smoltcp 映射暴露给手机。

## 2. 运行拓扑

```text
Android glue ── REST/WS ──> moyu gateway ── stdin/stdout/hooks ──> native CLI ──> AI service
     │                         │                                      │
     └── EasyTier overlay ─────┘                                      └── native auth/proxy
```

边界含义：

1. 手机和 moyu 都不构造 AI HTTP 请求。
2. moyu 能看到 CLI 的本地流式输出，但不会在 CLI 发出的 provider 请求中添加 header、身份或提示词。
3. 用户选择 model/profile 时，moyu 只使用 CLI 原生参数和环境机制，等价于用户在终端选择同一配置。
4. EasyTier 只运输手机与本机网关协议，不运输 provider 凭证或替代 CLI 的 provider 连接。

## 3. 模块结构

| 模块 | 职责 | 状态边界 |
|---|---|---|
| `gateway/server` + `api/*` | Bearer REST、WS、localhost hook、配对 | 无业务持久化 |
| `session/manager` | 会话生命周期、统一事件、历史热窗口、重放与同步 | 最多 64 个活动会话 |
| `adapters/*` | 原生 CLI 启动、协议解析、审批、终止 | 每会话有限输入队列 |
| `accounts/service` | 只读发现 native/Claude env/Codex home profile | 不校验 provider 可用性 |
| `net/*` | EasyTier 生命周期、relay TCP 状态、链路建议 | 只探测用户配置的 relay |
| `config/*` | mode-0600 本地配置、脱敏视图、allowlist PATCH | 不回显 token/networkSecret |
| `approval/*` | 审批注册、超时 deny、Codex localhost relay | 密钥只在私有临时文件 |

主路径依赖只有 `ws`；开发入口使用 `tsx`。发布产物用 Bun compile 嵌入 EasyTier，无数据库、ORM、provider SDK 或遥测 SDK。

## 4. 0 感知的实现证据

“任意 AI 服务端 0 感知”在后端可验证的准确含义是：后端没有向 AI 服务端发请求的代码路径，AI 流量只能由用户原生 CLI 子进程产生；后端不向该流量注入集成身份。

已实现的约束：

- Claude 使用 `claude -p --output-format stream-json`；Codex 使用 `codex exec --json`，不使用需要 `clientInfo` 的 app-server。
- 输入经 stdin/原生 CLI 参数传入，没有额外 system prompt。
- 后端没有账号“测试消息”、models probe 或 provider health endpoint。
- `test/unit-egress.ts` 用 TypeScript AST 检查所有 `src` 文件：新增出站原语必须落入明确 allowlist；源码不得出现 provider 域名字面量。
- 实际 allowlist 只包含 relay TCP 探测、localhost CLI 管理请求、localhost hook relay，以及默认不注册的实验性 localhost OpenCode 适配器。
- Claude/Codex 启动环境统一清除 `RD_HOOK_*`、`MOYU_*` 和 `REMOTE_DASHBOARD_CONFIG`；普通工具子进程不会继承 moyu 身份或审批密钥。
- 日志对敏感字段、已注册凭证值和常见 token 形态脱敏；原始 stderr 不进入 REST/WS。

`PROVIDER_HOST_BLOCKLIST` 不是验收证明。它只防止用户把 relay URL 误配为少量已知 provider 域名，不能覆盖“任意 provider”，因此不得把扩充黑名单当作安全需求。真正的保证来自没有 provider 请求路径和构建期出站检查。

不可越界承诺：moyu 无法证明原生 CLI 自己从不发送遥测，也无法证明未知服务端不基于原生 CLI 行为做推断。后端保证的是“不增加 moyu 可识别信号”，不是改变或伪装 CLI 本身。

## 5. 适配器协议

网关只依赖 `Adapter`、`SessionHandle` 和 `AdapterEvent`。新增 CLI 需要实现能力声明、可用性检测、认证存在性检测、会话启动与统一事件映射；REST/WS 不增加 provider 分支。

统一事件包括：

- `turn.started|completed|failed`
- `thinking.delta|done`
- `text.delta|done`
- `tool.start|output|done`
- `approval.request|resolved`
- `transport.metrics`

每个 WS 事件都封装为 `{type:"event",seq,sessionId,event}`。`seq` 在会话内单调递增，是手机去重、确认和恢复的唯一游标。适配器差异由 `/server/info` 的 `capabilities` 表达，前端不得用 provider 名硬猜能力。

### Claude

- 每轮启动原生 headless CLI，使用 `--session-id`/`--resume` 保留原生会话。
- PreToolUse 使用 CLI 原生 localhost HTTP hook；Authorization 只存在 mode-0600 临时 settings 文件，不进入环境。
- Claude 当前 hook 机制在 hook 网络失败时由 CLI 自身 fail-open。moyu 在能收到请求时 fail-closed，但不能伪造 CLI 不提供的“连接失败即 deny”语义。前端必须明确显示断连并避免声称离线审批仍受保护。

### Codex

- 协议锁定在 0.146.x；版本不匹配直接拒绝启动，避免静默解析漂移。
- `protocol.ts` 集中维护 argv、TOML hook 和 JSONL normalize，升级版本只修改该协议层及其离线 fixtures。
- PreToolUse command 调用内置 `hook-relay`。端口、sessionId 和随机 secret 存在 mode-0600 私有描述符，命令只携带描述符路径。
- relay 对坏请求、超时、非 2xx、坏响应和启动失败全部 exit 2 + 非空 stderr，映射为 Codex 原生 deny，因而 fail-closed。

OpenCode/PTY 不属于 v0.0.2 可用适配器。OpenCode 仅保留实验代码且默认不注册；PTY 消息返回 `pty_not_available`。

## 6. 会话、流和恢复

后端只保留活动会话热状态：

- 活动会话上限 64。
- 每会话消息上限 1000、总存储预算 8 MiB，单文本 256 KiB，单工具输出 256 KiB。
- 每会话事件重放 ring 上限 256 条/2 MiB，单事件字段 256 KiB；待审批和最近终止事件独立保留，避免 ring 溢出丢失关键状态。
- CLI NDJSON 单行上限 2 MiB，Claude/Codex 流式文本与工具累积字段上限 256 KiB；异常超长输出只终止当前轮次。
- 每适配器输入队列上限 32。排队只串行执行，不自动重放失败轮次。
- WS 帧 1 MiB；发送缓存超过 4 MiB 时以 4011 主动断开，客户端从最后 ack 的 seq 恢复。

恢复顺序：

1. HTML 从 Android 本地库立即渲染，不等待网络。
2. glue 请求 `/sessions/snapshot` 对齐活动会话元数据。
3. 对打开的会话请求 `/sessions/:id/sync?after=<localSeq>`。
4. 若 `eventGap=true`，以同步响应的 canonical messages 补齐；按 `hasMoreMessages/nextMessageAfterSeq` 继续分页。
5. 建立 WS 并发送 `{type:"subscribe",sessionId,afterSeq}`；按 seq 幂等写入本地库，成功后 ack。

后端不是长期历史数据库。活动会话被删除或进程重启后，离线历史仍由 Android 本地库负责；这也是 HTML 与连接状态解耦的基础。

## 7. 多平台、多账号和 model

会话创建接受 `{kind,cwd,title,cliSessionRef,profileId,model}`：

- `kind` 选择 CLI 平台。
- `profileId` 是逐会话选择；省略时使用该 adapter 的活动 profile，再省略则使用 native default。
- `model` 是逐会话原生 CLI override；省略时使用 adapter 配置，再省略则继承 CLI 默认。
- 已创建会话冻结上述选择，配置 PATCH 只影响之后创建的会话。

账号 profile：

- Claude：`<config-dir>/profiles/claude/<name>.env`，只读并在 spawn 时合并。
- Codex：`<config-dir>/profiles/codex/<name>.home`，文件第一行指向用户预先 `codex login` 的 `CODEX_HOME`。
- `/accounts` 只返回 profile 名、类型和凭证字段存在性，不返回值、不主动验证可用性。
- Codex 选择 `CODEX_HOME` 时清除继承的 `CODEX_API_KEY`/`CODEX_ACCESS_TOKEN`，避免 shell env 覆盖所选原生账号。

`moyu init` 自动生成本地 token/network secret、创建两个 profile 目录、探测 CLI 版本，并只要求一次 relay 输入。再次运行按 Enter 保留 relay。OAuth/login 始终由用户执行原生 CLI，moyu 不接管浏览器或 token exchange。

## 8. 审批与失败语义

审批超时统一解析为 deny；中断和 dispose 会清空 pending approval 并 deny。重复或过期决策返回 `approval_not_pending`，不会错误确认。

稳定客户端错误码：

| code | HTTP | retryable | 含义 |
|---|---:|---:|---|
| `session_not_found` | 404 | false | 后端活动会话不存在 |
| `session_limit` | 429 | true | 活动会话达上限 |
| `queue_full` | 429 | true | 该会话输入队列已满 |
| `session_disposed` | 409 | false | 会话已关闭 |
| `approval_not_pending` | 409 | false | 审批已处理/超时 |
| `adapter_unavailable` | 409 | false | 本机 CLI 不可用或版本不兼容 |
| `internal` | 500 | false | 未预期错误；响应不泄漏内部文本 |

CLI 正常执行失败使用 `turn.failed{category,summary}`，类别只有 `auth|rate-limit|network|not-found|parse|unknown`。summary 经过凭证遮蔽和长度限制。前端可以给出人工重试按钮，但 glue 不得自动重发 input。

子进程使用有限 stderr 缓冲；中断/关闭先温和信号、后硬终止进程树。临时 hook 文件和嵌入 EasyTier 提取目录均 best-effort 清理。

## 9. 耗时指标

指标必须使用可测名称，不把聚合时间伪装成 provider 单向延迟：

| 字段 | 测量方 | 定义 |
|---|---|---|
| `phoneBackendRttMs` | Android glue | WS ping 发出到对应 pong 收到的 RTT；后端端点返回 null |
| `backendCliQueueMs` | SessionManager | input 接受到对应 `turn.started` |
| `backendCliDispatchMs` | adapter | 本轮开始到 CLI 子进程成功 dispatch |
| `cliFirstEventMs` | adapter | dispatch 到首个可见 CLI 流事件；包含启动、网络和服务端处理 |
| `relay.latencyMs` | NetProbe | PC 到用户配置 relay 的 TCP connect 时间，仅作参考 |

手机到后端之外的单向分段没有时钟同步，CLI 到 AI 服务端也没有原生时间戳，因此 v0.0.2 不伪造“后端→CLI→provider”的严格拆分。

## 10. 配置与网络

配置优先级：`-config` > `REMOTE_DASHBOARD_CONFIG` > `~/.remote-dashboard/config.json`。文件以 0600 写入；`privateMode=true` 和 loopback bind 强制恢复。运行时 PATCH 只允许端口范围、relay/虚拟地址提示、默认 adapter、审批超时、日志等级和安全的 adapter 选项；token、networkSecret、二进制路径和 bindHost 不可由远端 PATCH。

NetProbe 只对用户配置的 relay 做有界 TCP connect，并输出网络建议；不探测 AI provider、不改防火墙、不改 Clash。Clash 节点延迟如未来由 Android/用户配置提供，可由 glue 展示；后端不依赖 Clash API。

## 11. 发布与验证

v0.0.2 矩阵共 8 个 launcher：Windows x64/arm64、Linux x64/arm64 glibc、Linux x64/arm64 musl、macOS x64/arm64。EasyTier 官方 Linux archive 本身由 musl Rust target 构建，因此对应 glibc/musl launcher 复用同一官方 core。

每次发布先执行：

1. `npm ci`
2. AST egress gate
3. TypeScript typecheck
4. 全量离线/集成测试
5. 每 target Bun cross compile
6. 原生平台 `moyu --selfcheck`；跨平台产物由目标平台执行 selfcheck

## 12. PTY 结论

PTY 能最接近完整 TUI，但会引入每 OS/架构 native addon、终端转义解析、resize/backpressure、安全输入转发和 8 平台 ABI 发布成本。Claude/Codex 已有结构化 headless 流，v0.0.2 使用结构化协议可获得文本、思考、工具、审批、usage、diff、interrupt 和 resume，同时更容易离线存储与恢复。因此 PTY 继续作为显式 addon 预留，不是后端“原生 CLI 体验”的必要条件，也不阻塞 v0.0.2。
