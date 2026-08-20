# Changelog

本项目记录 remote-dashboard（moyu）的版本演进。日期为本地时区。

## [0.0.3] - 2026-08-20 — 配对与移动端一致性定版

- `moyu -init` 在后台网关就绪后立即创建并打印五分钟一次性配对字符串；`moyu -pair` 继续承担显式重新生成。
- 初始化、帮助、Android 集成说明和验收契约使用同一配对流程，不再要求用户猜测第二条命令。
- 与 v0.0.3 Android/WebView UI 对齐版本；OpenCode CLI 与手机独立 Chat 不进入本版范围。
- Claude 会话仅公开 Plan / Auto / Accept Edits，并支持空闲时手动切换模式与模型；Auto 明确不受支持时只降级状态，不自动重发内容。
- 请求模型与本轮实际模型分层，修复兼容 Base URL 回报模型名覆盖用户选择的问题。
- 审批与失败不再写入重复 system 消息；Android 清理旧副本，前端默认折叠非正文运行记录。
- Windows 私有目录 ACL 的设置与复核统一使用 .NET API，不再受 PowerShell 7 继承的 `PSModulePath` 影响；从 PowerShell 7 启动、退出和发布自检均保持 fail-closed。
- Codex Profile 完整覆盖 ChatGPT OAuth、OpenAI API Key 与火山/自建 Responses 兼容端：隔离继承凭据，并允许 `.home` 按 Profile 追加原生 `env_key`，密钥值不进入前端或日志。

## [0.0.2] - 2026-08-01 — 后端设计收尾

- 将 Claude/Codex 原生 CLI 流统一为稳定事件协议，补齐会话快照、断线同步、工具审批、模型与账号 profile 逐会话选择及可解释耗时指标。
- 加固 0 感知边界：后端无 AI provider 请求路径、无 provider 探针或隐藏提示；发布版的结构化 CLI 调用不主动注入 Moyu/手机来源标记，构建前强制执行出站与 CLI 表面门禁。官方 Claude print / Codex exec 身份保持原样，不宣称伪装成交互式 TUI。
- 手机设备/网络/节点/传输字段与会话语义分流；默认 CLI cwd/PWD 使用用户主目录，图片先清除显式设备元数据，Claude 图片改用原生 stream-json image block，不再注入本机路径提示。
- Claude/Codex 审批统一为内置的本地 command hook：私有描述符、中性可执行入口、逐回合 Claude hook 可用性 canary，任一读取/执行/传输/超时/响应异常均 fail-closed。
- 增加轻量资源上限、稳定错误码、进程树清理、无自动 AI 轮次重试，以及 `moyu -help`/`moyu init` 的一次中继与多 API/OAuth profile 指引。
- 固化 HTML UI 与 Android WebView 胶水层边界，补齐离线多会话、本地同步、平台/profile 切换和耗时显示的前端交接协议。
- 发布矩阵扩展为 Windows、Linux glibc/musl、macOS 共 8 个目标。

## [0.0.1] - 2026-07-31 — 内部首个提交

首个内部里程碑。远程 AI CLI 控制后端：通过 EasyTier overlay 在手机端远程操控 PC 上的 claude / codex CLI，远程审批工具调用。

### 安全 / 审批

- **codex 远程审批 fail-closed 包装**：codex 的 PreToolUse hook 是 `type:"command"`，其 `parse_completed`（codex-rs/hooks/src/events/pre_tool_use.rs）在 hook 失败时 `should_block=false`（fail-open），仅在 `exit 2 + stderr 非空` 或 `exit 0 + 合法 deny JSON` 时 deny，且无配置项可改。本次把 hook 命令包装为 `curl --fail --max-time <N> ... || exit 2 + stderr`，使 curl 的任何传输失败（二进制缺失 / 连不上 gateway / 超时 / 5xx）走 codex 原生 deny 路径，而非放行工具。
  - `--max-time` 严格小于 codex hook timeout（10s 余量），保证 curl 先以 exit 2 返回 deny，不被 codex 杀进程。
  - `tool_input` 缺失（schema drift）时 gateway 返回 deny，而非走 allow 导致 codex "unsupported permissionDecision:allow" fail-open。
  - 覆盖：curl 不存在 / 连不上 / 超时 / 5xx / 被 codex 杀前 / tool_input 缺失。
  - 未覆盖（需启动前自检，非运行时随机失败）：hook 未注册/未调用；codex 升级导致 schema drift。
  - 不 fork codex、不违反 0 感知（hook 命令是 codex 本地执行，包装 exit code 不影响 codex↔服务端交互）。
- gateway 内部 fail-closed：坏 body / 无 routing key / 无 handler / 坏 secret / handler 抛错 -> 一律 `200 + DENY`。
- 0 感知（绝对约束）：生成用户自己的 CLI，无 provider 请求、无 token 注入、无 auth 文件写入；egress 架构 + 构建时静态检查（test/unit-egress.ts，567 pass）。
- 全局 `unhandledRejection` / `uncaughtException` handler：网关不因边缘 reject 崩溃（保护审批链路可用性）。

### 适配器

- codex：`codex exec --json` JSONL 流 + PreToolUse command hook（curl 到本地 gateway）+ `--dangerously-bypass-hook-trust` + CODEX_HOME 多账号。
- claude：`claude -p --output-format stream-json` + PreToolUse `type:"http"` hook + `resolveClaudeBinary`（绕过 Windows `.cmd` shim）。

### 网络 / 配对

- EasyTier overlay：`--no-tun` + `--port-forward` + `-n` + smoltcp（移动端兼容）。
- 一次性配对系统：PairingService + `/pair` + `moyu pair`（F1-F5 闭环）。
- moyu CLI：bun-compile 单二进制，嵌入 easytier-core 2.6.4。

### 验证

- `npm run typecheck`：通过。
- `npm test`：16 个测试套件、800+ 用例全绿。
- `bun scripts/build.mjs`：`moyu.exe` 自检 OK（self-contained，嵌入 easytier-core）。
- 独立子 agent 审查本次 fail-closed 改动：CONFIRMED 无问题（含 win cmd `/C "..."` 下 `&`/`||`/`()` 语法的实测验证）。
