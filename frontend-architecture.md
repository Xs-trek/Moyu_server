# moyu Android 前端架构定稿（v0.0.2）

本文固定 Android 客户端的职责边界，供 HTML 视觉设计和后续 Android Studio 集成共同遵守。精确桥接消息与后端接口见 `frontend-handoff.md`。

## 1. 核心决定

HTML 与 Android WebView 胶水层完全解耦：

- HTML/UI bundle 只负责页面、组件、动画、用户输入和 view model 渲染。
- Android glue 负责网络、EasyTier、认证、SQLite、本地文件、同步、重连、耗时测量、后台生命周期和安全策略。
- HTML 不直接调用 `fetch`、`WebSocket`、IndexedDB、localStorage、Android 文件 API 或 EasyTier。
- token、networkSecret、profile 凭证和后端地址不进入 HTML/JavaScript。
- 同一 HTML 在普通桌面浏览器中可用 mock host 预览；不需要 Android、后端或真实连接才能查看所有页面状态。

这条边界使另一对话产出的 HTML 可以直接作为 UI 资产交付，后续只在 Android Studio 实现胶水层并打包 APK，无需把网络和持久化逻辑从 HTML 中二次剥离。

## 2. 分层

```text
┌──────────────────────── HTML / CSS / presentation JS ───────────────────────┐
│ Console / local sessions / approvals / nodes / settings / empty states     │
│ render(viewModel) + postIntent(intent)                                      │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ 单一 JSON bridge
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ Android WebView glue                                                       │
│ UI coordinator │ sync engine │ WS/REST │ Room │ Keystore │ RTT measurement │
├──────────────────────────────────────────────────────────────────────────────┤
│ OverlayController / foreground service / EasyTier no-tun + SOCKS5          │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ EasyTier overlay
                                ▼
                    PC moyu REST/WS gateway
```

HTML 只认识两种抽象动作：

1. `host -> UI`：完整或增量 view model。
2. `UI -> host`：用户 intent，例如打开本地会话、发送消息、批准工具、保存节点配置。

HTML 不认识 HTTP path、Bearer、WS seq 恢复算法或数据库 schema。这些都属于 glue。

## 3. HTML/UI bundle 的允许范围

允许：

- 语义化 HTML、CSS、图标和本地字体。
- 展示层 JavaScript/TypeScript：组件状态、路由、动画、表单临时值、虚拟列表、Markdown/code/diff 渲染。
- 调用统一 `window.MoyuHost.postMessage(JSON.stringify(intent))`。
- 接收统一 `window.dispatchEvent(new CustomEvent('moyu:view', ...))` 或 WebMessagePort 消息。
- 内置 mock host，用固定 fixtures 演示离线、连接中、审批、错误、长工具输出等状态。

禁止：

- `fetch`、XHR、`WebSocket`、EventSource 或任何远程 URL。
- localStorage、IndexedDB、Cache Storage 作为业务数据源。
- 保存 token、networkSecret、relay 凭证或 profile 凭证。
- 拼接后端路径、实现重试/同步/ack、启动 EasyTier。
- 通过多个 `@JavascriptInterface` 方法散布原生能力。
- 远程 CDN、远程脚本、动态下载安装 UI 代码。

HTML 可持有当前页面的短生命周期 view state；WebView 重建后由 glue 从本地库重新投影完整 view model。

## 4. Android glue 的职责

### 4.1 数据与离线

Room/SQLite 至少存储：

- 节点与配对配置的非敏感索引。
- 本地会话摘要、消息、工具事件、审批结果、最后 seq。
- 待发送 input outbox，但仅保存“未提交/等待用户再次确认”，不在断线后自动向 AI 重发。
- 每节点同步水位、最后成功时间、错误码和 RTT 样本。

token、networkSecret 使用 Android Keystore 包装的加密存储；数据库只保存引用。HTML 获得的 node view model 只包含名称、连接状态和非敏感提示。

App 启动流程必须先打开本地库并渲染，再异步启动 overlay/后端连接。无网络、token 失效或 relay 不可达均不能阻塞离线会话列表和详情。

### 4.2 网络

glue 使用 native HTTP/WS client 经 `127.0.0.1` SOCKS5 连接 PC backend VIP。WebView 没有网络权限层面的业务职责。所有请求由 glue 统一添加 Bearer、超时和稳定错误映射。

连接状态机：

```text
offline -> overlayStarting -> backendConnecting -> syncing -> online
   ^              |                 |                |
   └──────── degraded/error <───────┴────────────────┘
```

状态机只是同步状态，不是页面导航状态。Console 始终可打开；offline 时输入保留为本地草稿，用户明确选择连接/重试后才能发送。

### 4.3 同步

glue 按节点保存 `lastAckSeq`：

1. 读取本地会话立即投影 UI。
2. 获取 `/sessions/snapshot` 合并后端当前活动会话。
3. 对可恢复会话调用 `/sessions/:id/sync`。
4. 按 seq 幂等 upsert messages/events；检测 `eventGap` 时以 canonical messages 修复。
5. 建立 WS subscribe，持久化事件后再 ack。
6. 4011/backpressure 或网络断开后指数退避重连，但绝不自动重发 AI input 或审批决定。

本地历史可以比后端热窗口更长。后端进程重启导致活动会话消失时，本地记录标记为 `localOnly/ended`，仍可离线查看。

### 4.4 EasyTier

Android 不使用 `VpnService`。OverlayController 以 no-tun + smoltcp 模式提供 loopback SOCKS5；native client 通过 SOCKS5 访问 backend VIP。实际采用 JNI library 还是可执行 sidecar，需要在 Android 原型中验证，但这不改变 HTML/bridge 协议。

前台 service 负责 overlay 生命周期和通知。Manifest 不得包含 `BIND_VPN_SERVICE`，代码不得调用 `VpnService.Builder`；后续 CI 应静态检查两者。

## 5. 信息架构

### 5.1 Console（主页面）

主页面是控制台，不是连接向导。页面结构：

- 顶部：当前本地会话标题、平台/profile/model 标签、节点状态和 RTT。
- 主区：本地持久化的消息时间线；文本、thinking、工具、diff、usage 和错误均有独立视觉层级。
- 底部：composer、发送、中断、附件入口；offline 时变为“保存草稿/连接后发送”，不得丢失输入。
- 会话抽屉：所有本地会话，支持离线筛选和打开；后端活动状态仅作为 badge。

首次启动、未配节点和连接失败时仍显示 Console 骨架与已有本地内容。连接条件以非阻塞 banner/card 呈现。

### 5.2 节点页面

每个节点代表一台 PC/一份 overlay 配置：

- 名称、relay、配对/手工配置状态、最后连接时间。
- overlay、backend、sync 分段状态。
- 手机↔后端 RTT、PC↔relay TCP latency；不可测字段显示“未提供”，不显示伪 0。
- 新增、编辑、删除、连接、重新配对和诊断 intent。

敏感值只允许“已配置/未配置”状态，不提供明文回显。删除节点是显式确认的本地操作，不删除 PC 上的会话或 profile。

### 5.3 新建会话与切换

创建会话 sheet 由 backend capabilities 驱动：

- 平台：Claude/Codex；不可用项禁用并显示原因。
- profile：native default 与后端发现的 profile；只显示名称、auth mode、字段存在性。
- model：可选原生 override；空值表示继承 CLI 默认。
- cwd：通过 host intent 打开 native/后端目录选择，不由 HTML 直接访问文件系统。
- sandbox/reviewer：仅在 adapter capabilities 声明支持时显示。

平台/profile/model 是会话级固定 metadata。切换它们意味着新建会话，不在执行中的会话上静默更换账号。

### 5.4 审批

`approval.request` 以高优先级卡片/底部 sheet 显示 tool、摘要、可选输入与 choices。UI 发出一次 approval intent 后立即进入 `submitting`，等待后端 `approval.resolved` 或稳定错误码；不得乐观显示已允许。断线时禁止提交，显示后端可能已超时 deny。重复决定收到 `approval_not_pending` 后刷新会话同步。

### 5.5 设置与诊断

- 只显示后端允许 PATCH 的配置。
- 账号页只激活已有 profile，不创建或编辑密钥。
- 网络诊断展示 overlay 状态、relay latency、死区提示和 Clash DIRECT 建议；不自动修改 Clash。
- 显示版本、协议版本、最后同步时间和可复制的脱敏诊断。

## 6. 耗时展示

前端必须保留指标来源：

- `phoneBackendRttMs`：glue 的 WS ping/pong RTT。
- `backendCliQueueMs`：input 到 CLI turn start。
- `backendCliDispatchMs`：本地 CLI dispatch 开销。
- `cliFirstEventMs`：CLI dispatch 到首个流事件的聚合时间。
- `relayLatencyMs`：PC 到 relay 的 TCP connect 参考值。

推荐默认只显示 RTT 和“首响应”；详细诊断展开后显示全部定义。不得把 `cliFirstEventMs` 标成“服务端延迟”或把 relay latency 当成手机当前数据路径延迟。

## 7. WebView 安全

- 只加载 APK 内置资源，禁用 file URL 跨域访问和任意导航。
- bridge 只接受 JSON envelope，校验 schema、大小和 requestId；未知 intent 拒绝。
- 不把 token 注入 JS，不把原始后端响应直接 `evaluateJavascript` 拼接；使用 JSON 编码/WebMessagePort。
- 禁止远程调试进入 release；外链交给系统浏览器且需 allowlist/用户确认。
- WebView 崩溃或进程回收后，glue 重新投影本地数据，不依赖 JS 持久状态。

## 8. 可交付性结论

另一对话可以先交付完全独立的 HTML UI。可接受交付包应包含：

- 单入口 `index.html` 和本地 assets，不依赖 CDN。
- `MoyuHost` mock adapter 与完整 fixture 状态。
- 所有页面、空/离线/错误/审批/长内容状态。
- 只使用 `frontend-handoff.md` 中的 intent/view model，不包含真实 REST/WS/存储代码。

随后可以在 Android Studio 中实现真实 host adapter、Room/Keystore、EasyTier 和 APK 集成。该路径可行，并且无需修改 HTML 的业务边界；若视觉稿增加新交互，只扩展 versioned bridge intent/view model。
