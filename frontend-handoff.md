# moyu 前端交接协议（HTML ↔ Android glue ↔ v0.0.2 后端）

本文可以直接交给 HTML/UI 对话与 Android Studio 实现。HTML 只实现第 1～4 节的 bridge/view model；Android glue 实现 bridge，并消费第 5～9 节的真实后端协议。

## 1. HTML 交付硬约束

- 单入口、全本地 assets、无 CDN。
- 不使用 `fetch`、XHR、WebSocket、localStorage、IndexedDB、Cache API。
- 不保存或显示 token/networkSecret/API key/OAuth token。
- 不写 Android、EasyTier、REST path 或 SQLite 逻辑。
- 提供 mock host；脱离 Android/后端可预览所有状态。
- 响应式优先 Android 竖屏，同时支持平板/横屏。

HTML 只调用：

```ts
window.MoyuHost.postMessage(JSON.stringify(intent));
```

host 只投递：

```ts
window.dispatchEvent(new CustomEvent('moyu:view', { detail: envelope }));
```

Android 最终可把底层实现替换为 WebMessagePort，但 HTML adapter 的这两个语义保持不变。

## 2. Bridge envelope

```ts
type RequestId = string;

interface UiIntent<T extends string = string, P = unknown> {
  version: 1;
  type: T;
  requestId: RequestId;
  payload: P;
}

type HostEnvelope =
  | { version: 1; type: 'view.full'; revision: number; view: AppViewModel }
  | { version: 1; type: 'view.patch'; revision: number; patch: ViewPatch[] }
  | { version: 1; type: 'intent.result'; requestId: RequestId; ok: true; data?: unknown }
  | { version: 1; type: 'intent.result'; requestId: RequestId; ok: false; error: UiError };

interface ViewPatch {
  op: 'set' | 'remove';
  path: string; // JSON Pointer
  value?: unknown;
}

interface UiError {
  code: string;
  summary: string;
  retryable: boolean;
  category?: 'auth' | 'rate-limit' | 'network' | 'not-found' | 'parse' | 'unknown';
}
```

规则：

- `requestId` 由 UI 生成，用于按钮 submitting/result 对应，不是后端 session id。
- revision 必须单调；UI 发现跳号时发送 `view.reload`。
- UI 不假设 patch 一定到达；`view.full` 可随时替换全部状态。
- bridge 单条 JSON 上限 1 MiB；长 diff/工具输出由 host 分页或截断后投影。

## 3. UI intents

```ts
type MoyuIntent =
  | UiIntent<'app.ready', { uiVersion: string }>
  | UiIntent<'view.reload', {}>
  | UiIntent<'nav.open', { route: Route }>
  | UiIntent<'session.open', { localSessionId: string }>
  | UiIntent<'session.create', CreateSessionDraft>
  | UiIntent<'session.send', { localSessionId: string; text: string }>
  | UiIntent<'session.saveDraft', { localSessionId?: string; text: string }>
  | UiIntent<'session.interrupt', { localSessionId: string }>
  | UiIntent<'session.deleteLocal', { localSessionId: string }>
  | UiIntent<'session.loadOlder', { localSessionId: string; beforeLocalSeq?: number }>
  | UiIntent<'approval.decide', { localSessionId: string; approvalId: string; decision: ApprovalDecision }>
  | UiIntent<'diff.open', { localSessionId: string }>
  | UiIntent<'fs.list', { nodeId: string; path?: string }>
  | UiIntent<'node.connect', { nodeId: string }>
  | UiIntent<'node.disconnect', { nodeId: string }>
  | UiIntent<'node.save', NodeDraft>
  | UiIntent<'node.delete', { nodeId: string }>
  | UiIntent<'node.pair', { relayNode: string; pairString: string; displayName: string }>
  | UiIntent<'node.manualSetup.open', { displayName?: string; relayNode?: string }>
  | UiIntent<'node.diagnose', { nodeId: string }>
  | UiIntent<'accounts.activate', { nodeId: string; adapter: 'claude' | 'codex'; profileId: string }>
  | UiIntent<'config.patch', { nodeId: string; patch: ConfigPatch }>
  | UiIntent<'external.open', { url: string }>;

type Route = 'console' | 'sessions' | 'nodes' | 'accounts' | 'settings' | 'diagnostics';
type ApprovalDecision = 'allow' | 'allow_session' | 'deny' | 'cancel';

interface CreateSessionDraft {
  nodeId: string;
  kind: 'claude' | 'codex';
  cwd?: string;
  title?: string;
  profileId?: string;
  model?: string;
}

interface NodeDraft {
  nodeId?: string;
  displayName: string;
  relayNode: string;
}
```

`session.send` 离线时不得自动加入可重放网络 outbox。glue 应保存草稿并返回 `offline_confirmation_required`；重新在线后由用户再次点击发送。

## 4. App view model

```ts
interface AppViewModel {
  route: Route;
  now: string;
  activeNodeId?: string;
  activeLocalSessionId?: string;
  connection: ConnectionView;
  nodes: NodeView[];
  sessions: LocalSessionView[];
  activeSession?: SessionDetailView;
  server?: ServerView;
  accounts?: AccountSwitchingStatus;
  config?: SanitizedConfig;
  diagnostics?: DiagnosticsView;
  ui: {
    globalBanner?: BannerView;
    pendingRequestIds: string[];
  };
}

interface ConnectionView {
  state: 'offline' | 'overlayStarting' | 'backendConnecting' | 'syncing' | 'online' | 'degraded' | 'error';
  nodeId?: string;
  summary: string;
  phoneBackendRttMs?: number;
  lastOnlineAt?: string;
  error?: UiError;
}

interface NodeView {
  nodeId: string;
  displayName: string;
  relayNode: string;
  configured: boolean;
  active: boolean;
  overlayState: string;
  backendState: 'unknown' | 'offline' | 'online';
  syncState: 'idle' | 'syncing' | 'current' | 'error';
  relayLatencyMs?: number;
  relayLatencyReliable?: boolean;
  lastConnectedAt?: string;
  secretState: { token: boolean; networkSecret: boolean };
}

interface LocalSessionView {
  localSessionId: string;
  remoteSessionId?: string;
  nodeId: string;
  kind: 'claude' | 'codex';
  title: string;
  updatedAt: string;
  profileId?: string;
  model?: string;
  state: 'localOnly' | 'idle' | 'running' | 'completed' | 'failed' | 'ended';
  unread: number;
  lastSeq: number;
  preview?: string;
}

interface SessionDetailView extends LocalSessionView {
  cwd?: string;
  messages: TimelineItem[];
  hasOlderLocalMessages: boolean;
  composerDraft: string;
  canSend: boolean;
  canInterrupt: boolean;
  pendingApproval?: ApprovalView;
  transport?: TransportMetricsView;
  diff?: DiffView;
}

type TimelineItem =
  | { localSeq: number; kind: 'message'; role: 'user' | 'assistant' | 'system'; text: string; createdAt: string }
  | { localSeq: number; kind: 'thinking'; text: string; streaming: boolean; createdAt: string }
  | { localSeq: number; kind: 'tool'; toolCallId: string; tool: string; input?: unknown; output?: string; state: 'running' | 'done' | 'error'; createdAt: string }
  | { localSeq: number; kind: 'approval'; approval: ApprovalView; createdAt: string }
  | { localSeq: number; kind: 'usage'; usage: Usage; costUsd?: number; createdAt: string }
  | { localSeq: number; kind: 'error'; error: UiError; createdAt: string };

interface ApprovalView {
  approvalId: string;
  kind: 'command' | 'fileChange' | 'permission' | 'mcpElicit' | 'userInput';
  tool?: string;
  summary: string;
  input?: unknown;
  choices: ApprovalDecision[];
  state: 'pending' | 'submitting' | 'allowed' | 'denied' | 'expired';
}

interface TransportMetricsView {
  phoneBackendRttMs?: number;
  backendCliQueueMs?: number;
  backendCliDispatchMs?: number;
  cliFirstEventMs?: number;
  relayLatencyMs?: number;
  observedAt?: string;
}

interface DiagnosticsView {
  net?: NetStatus;
  transport?: TransportMetricsView;
  lastSyncAt?: string;
  backendVersion?: string;
  protocolVersion: 1;
  notes: string[];
}

interface BannerView {
  level: 'info' | 'warning' | 'error';
  text: string;
  actionLabel?: string;
  actionIntent?: MoyuIntent;
}
```

UI 必须为以下 fixtures 提供完成态：无节点、有离线历史但无连接、连接中、同步中、在线空会话、流式 thinking/text、长工具输出、pending approval、approval 过期、auth/rate-limit/network 错误、event gap 修复、diff 非 Git 目录。

## 5. 后端连接通则

- Base：`http://<backendVip>:<gatewayPort>/api/v1`，只由 glue 知道。
- REST：`Authorization: Bearer <token>`。
- WS：`ws://<backendVip>:<gatewayPort>/api/v1/ws?token=<urlencoded-token>`。
- 业务 body 默认 JSON UTF-8。
- REST body 上限 1 MiB；WS frame 上限 1 MiB；UI input 上限 256 KiB。
- HTTP/WS 均经 Android loopback SOCKS5/EasyTier，HTML 不持有 URL。

通用失败：

```ts
interface BackendError {
  error: string;
  retryable?: boolean;
  category?: FailureCategory;
  summary?: string;
  details?: string[];
}
type FailureCategory = 'auth' | 'rate-limit' | 'network' | 'not-found' | 'parse' | 'unknown';
```

稳定业务 code：`session_not_found`、`session_limit`、`queue_full`、`session_disposed`、`approval_not_pending`、`adapter_unavailable`、`body_too_large`、`internal`。WS 协议 code：`bad_json`、`bad_message`、`input_too_large`、`unknown_message`、`pty_not_available`。401 Bearer 失败为 `{error:'unauthorized'}`。glue 将它们映射成 `UiError`，HTML 不解析任意英文 summary 来判断状态。

## 6. 会话 REST

### 6.1 类型

```ts
interface SessionSummary {
  sessionId: string;
  kind: 'claude' | 'codex';
  createdAt: string;
  updatedAt: string;
  title?: string;
  messageCount: number;
  latestSeq: number;
  cwd: string;
  cliSessionRef?: string;
  profileId?: string;
  model?: string;
  turnState: 'idle' | 'running' | 'completed' | 'failed';
  transport: TransportMetrics;
}

interface TransportMetrics {
  backendCliQueueMs?: number;
  backendCliDispatchMs?: number;
  cliFirstEventMs?: number;
  observedAt: string;
}

interface Message {
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text?: string;
  toolCallId?: string;
  tool?: string;
  toolInput?: unknown;
  toolOutput?: string;
  thinking?: string;
  createdAt: string;
}

interface SessionSyncSnapshot {
  session: SessionSummary;
  requestedAfterSeq: number;
  requestedMessageAfterSeq: number;
  latestSeq: number;
  oldestAvailableEventSeq: number | null;
  eventGap: boolean;
  events: EventEnvelope[];
  hasMoreEvents: boolean;
  nextAfterSeq: number;
  messages: Message[];
  hasMoreMessages: boolean;
  nextMessageAfterSeq: number;
  messagesTruncatedBeforeSeq: number;
  generatedAt: string;
}
```

### 6.2 路径

| Method | Path | Body / response |
|---|---|---|
| GET | `/sessions` | `SessionSummary[]`，兼容小列表 |
| GET | `/sessions/snapshot?cursor=&limit=50` | `{items,nextCursor,generatedAt}`，limit 1..100 |
| POST | `/sessions` | `{kind,cwd?,title?,cliSessionRef?,profileId?,model?}` -> `{sessionId,session}` |
| GET | `/sessions/:id` | `SessionSummary` |
| DELETE | `/sessions/:id` | `{ok:true}`；结束后端热会话，不删除 Android 本地历史 |
| GET | `/sessions/:id/messages?after=N` | `Message[]` |
| GET | `/sessions/:id/sync?after=N&messageAfter=M&limit=256` | `SessionSyncSnapshot`；两个游标独立 |
| POST | `/sessions/:id/input` | `{text}` -> 202 `{ok:true}` |
| POST | `/sessions/:id/interrupt` | `{}` -> `{ok:true}` |
| GET | `/sessions/:id/diff` | `DiffResult` |

`profileId/model` 在创建时冻结。glue 不应在运行会话里用 settings 变化模拟热切换。

同步分页：events 使用 `nextAfterSeq`；messages 使用 `nextMessageAfterSeq`，二者游标不可混用。`eventGap=true` 时以 messages 为 canonical 恢复时间线；`messagesTruncatedBeforeSeq>0` 表示后端更老消息已淘汰，但 Android 本地历史不得删除。

## 7. WebSocket

### 7.1 客户端消息

```ts
type WsClient =
  | { type: 'subscribe'; sessionId: string; afterSeq: number }
  | { type: 'input'; sessionId: string; text: string }
  | { type: 'approval'; sessionId: string; approvalId: string; decision: ApprovalDecision }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'ack'; seq: number }
  | { type: 'ping'; clientTs: number };
```

每条 input/approval 推荐走 WS；REST 是恢复/兼容路径。任何断线后的 input 都需要用户再次确认，不得由 glue 自动重放。

### 7.2 服务端消息

```ts
type WsServer =
  | EventEnvelope
  | { type: 'ack'; ackType: 'subscribed'; sessionId: string; replay: ReplayStatus }
  | { type: 'pong'; clientTs?: number; serverTs: number }
  | { type: 'net_change'; seq: number; snapshot: { net: NetStatus; overlay: unknown } }
  | ({ type: 'error'; code: string; retryable?: boolean; category?: FailureCategory; summary?: string });

interface ReplayStatus {
  requestedAfterSeq: number;
  gap: boolean;
  latestSeq: number;
  oldestAvailableSeq: number | null;
}

interface EventEnvelope {
  type: 'event';
  seq: number;
  sessionId: string;
  event: AdapterEvent;
}
```

### 7.3 AdapterEvent

```ts
type AdapterEvent =
  | { type: 'turn.started' }
  | { type: 'thinking.delta'; text: string }
  | { type: 'thinking.done' }
  | { type: 'text.delta'; text: string }
  | { type: 'text.done'; text: string }
  | { type: 'tool.start'; toolCallId: string; tool: string; input: unknown }
  | { type: 'tool.output'; toolCallId: string; text?: string; base64?: string }
  | { type: 'tool.done'; toolCallId: string; isError: boolean }
  | { type: 'approval.request'; approvalId: string; kind: ApprovalView['kind']; tool?: string; input?: unknown; summary: string; choices: ApprovalDecision[] }
  | { type: 'approval.resolved'; approvalId: string; decision: ApprovalDecision | {allowWithModification?: unknown} }
  | { type: 'turn.completed'; usage?: Usage; costUsd?: number }
  | { type: 'turn.failed'; category: FailureCategory; summary: string }
  | { type: 'transport.metrics'; metrics: TransportMetrics };

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
```

glue 先事务性写入 event/message，再发 `{type:'ack',seq}`。重复 seq 幂等忽略。close code 4011 表示 backpressure，立即按 last persisted seq 重连；普通网络错误指数退避。subscribe ack 的 `gap=true` 时调用 REST sync。

WS ping RTT：`nowReceived - clientTs`，使用单调时钟样本；`serverTs` 只用于诊断，不计算单向延迟。

## 8. 平台、账号、配置与本地工具

### Server/capabilities

`GET /server/info` 返回平台、arch、port、startedAt、defaultAdapter、approvalTimeoutSec、accountSwitching 和 adapters。每个 adapter 包含：

```ts
interface AdapterStatus {
  kind: 'claude' | 'codex';
  displayName: string;
  available: boolean;
  auth: { adapter: string; mode: string; hasCredentials: boolean; baseUrlPresent?: boolean; proxyDetected?: boolean } | null;
  capabilities: {
    streaming: { text: boolean; thinking: boolean; tools: boolean };
    resume: boolean;
    interrupt: boolean;
    accountProfiles: boolean;
    approval: { transport: 'http-hook' | 'command-hook' | 'native'; semantics: string; policies: string[] };
    configuration: { model: boolean; sandboxModes: string[]; reviewers: string[] };
  };
}
```

HTML 根据 capabilities 显隐控件，不按 kind 硬编码 sandbox/reviewer。

### Accounts

```ts
interface AccountSwitchingStatus {
  profilesDir: string;
  setupHint?: string;
  adapters: Record<'claude' | 'codex', {
    switchableCount: number;
    nativeDefaultPresent: boolean;
    activeProfileId?: string;
    applied: boolean;
    profiles: Array<{
      id: string; name: string; adapter: string;
      authMode: 'oauth' | 'apiKey' | 'authToken+BaseUrl' | 'providerKey' | 'none';
      sourceKind: 'nativeDefault' | 'envFile' | 'codexHome';
      fields: { hasCredentials: boolean; baseUrl?: boolean; authToken?: boolean; apiKey?: boolean; provider?: boolean };
      active: boolean;
    }>;
  }>;
}
```

- `GET /accounts` -> 上述状态。
- `POST /accounts/activate` body `{adapter:'claude'|'codex',profileId}`。

账号失败只会在用户正常发起 CLI 轮次后以 `turn.failed` 出现；没有 probe 按钮和 probe endpoint。

### Config

- `GET /config` -> `SanitizedConfig`，不含 token/networkSecret/profile 值。
- `PATCH /config` -> 同一脱敏结构。

```ts
interface ConfigPatch {
  gateway?: { portMin?: number; portMax?: number };
  network?: { publicNode?: string; virtualIp?: string; backendMapCidr?: string };
  defaultAdapter?: 'claude' | 'codex';
  approvalTimeoutSec?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  ptyAddon?: { enabled?: boolean };
  adapters?: Partial<Record<'claude' | 'codex', {
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    approvalsReviewer?: 'user' | 'auto_review' | 'guardian_subagent';
    model?: string;
    activeProfileId?: string;
  }>>;
}

interface SanitizedConfig {
  gateway: { portMin: number; portMax: number; bindHost: string; gwPort?: number };
  network: {
    publicNode: string;
    easytierBin?: string;
    virtualIp?: string;
    backendMapCidr?: string;
    networkName?: string;
    privateMode: boolean;
  };
  defaultAdapter: 'claude' | 'codex';
  approvalTimeoutSec: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  ptyAddon: { enabled: boolean };
  adapters: Record<'claude' | 'codex', {
    approvalPolicy: 'untrusted' | 'on-failure' | 'on-request' | 'never';
    sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
    approvalsReviewer: 'user' | 'auto_review' | 'guardian_subagent';
    model?: string;
    bin?: string;
    activeProfileId?: string;
  }>;
}
```

UI 不提供 bindHost、token、networkSecret、easytierBin 或 adapter bin 的远程编辑。

### Files/diff

- `GET /fs/list?path=<encoded>` -> `FsEntry[]`，字段 `{name,path,isDir,isFile,size,mtime}`。
- `GET /sessions/:id/diff` -> `{repo,cwd,staged,unstaged,untracked,head,truncated,error?}`。

HTML 发 `fs.list` intent，由 glue 调 endpoint 后返回目录 view model；HTML 不直接知道本地文件路径权限。

## 9. 网络、配对和耗时

- `GET /net/status` -> `NetStatus & {overlay}`。
- `POST /net/status` body `{mobileV6Available}` -> 刷新并广播。
- `GET /net/join-params` -> 已认证的真实 overlay 参数，含敏感 networkSecret；只进 Keystore，不进 HTML。
- `POST /net/overlay` body `{action:'start'|'stop'|'restart'}`。
- `POST /pair` 是配对期唯一无 Bearer endpoint，body `{code}`；handoff 只由 glue 消费。

```ts
interface NetStatus {
  profile: {
    ipv6GuaAvailable: boolean;
    tempAddress?: { current: string; preferredLifetimeSec: number; validLifetimeSec: number; estimatedRotationAt: string };
    inboundFirewallDefault: 'allow' | 'block' | 'unknown';
    natType: 'fullcone' | 'restrictedcone' | 'portrestricted' | 'symmetric' | 'unknown';
    clash: null | { detected: boolean; tunAdapter?: string; tunIfIndex?: number; defaultRouteCaptured?: {ipv4:boolean;ipv6:boolean}; recommendation: string };
  };
  publicNode: null | { host: string; port: number; tcpConnectOk: boolean; reliable: boolean; latencyMs?: number; note?: string };
  verdict: { publicNode: NetStatus['publicNode']; mobileV6Available?: boolean; overall: 'ok'|'degraded'|'dead-zone'|'unknown'; rationale: string[] };
  inboundPolicy: { version:1; mode:'loopback-via-overlay-map'; gatewayBindHost:string; backendMapCidr:string|null; apiBearerRequired:true; pairingOneTimeCodeRequired:true; hooksLocalhostOnly:true; hookSessionSecretRequired:true; hostFirewallMutation:false };
  checkedAt: string;
}
```

`GET /transport/metrics?sessionId=` 返回：

```ts
{
  observedAt: string;
  phoneBackendRttMs: null;
  phoneBackendRttSource: 'client-ws-ping';
  session: null | ({sessionId:string} & TransportMetrics);
  relay: null | {latencyMs:number|null;reliable:boolean;source:'relay-tcp-connect'};
  limitations: string[];
}
```

UI 标签必须是“手机↔后端 RTT”“CLI 首事件（聚合）”“PC↔relay TCP”；不能改写为不可测的 provider 单向延迟。

## 10. HTML 验收清单

- Console 在完全离线时可打开已有本地会话与消息。
- 未配置节点不会挡住主页面；节点配置是独立页面/banner action。
- Claude/Codex、profile、model 的创建会话选择完整，能力不支持的字段不显示。
- thinking/text/tool/approval/usage/error/diff 均有稳定组件。
- approval 提交中不可重复点击，断线不可发送，过期可解释。
- 指标显示来源与不可测状态，不用 0 代替 null。
- 所有删除、danger-full-access、allow_session 有显式确认。
- 无远程资源、无网络 API、无持久化 API、无密钥 fixture。
- mock host 能演示第 4 节列出的所有状态。
