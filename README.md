# moyu

moyu 是**本机 AI 运行时的远程控制面**（v0.0.4，Apache-2.0）。它让手机通过 EasyTier 叠加网络控制 PC 上已安装、已登录的 Claude Code / Codex CLI，或连接 PC 本机的 OpenCode Server；它不是 AI 网关：

- **0 出站**：后端不连接任何 AI provider、不发探针、不代持 token，也不使用 provider SDK。
- **驱动原生运行时**：Claude/Codex 只走官方 CLI 的 stdin/stdout/hooks；OpenCode 只走官方 `opencode serve` REST/SSE，不解析数据库或桌面端私有 sidecar。
- **Claude 会话控制**：仅暴露 Plan / Auto / Accept Edits，用户可在空闲时手动切换模式和模型。设置直接进入原生 CLI 参数，不转换成 system prompt；Auto 不受支持时降为 Accept Edits，但绝不自动重发失败输入。
- **无产品标记注入**：发布版不会主动把 Moyu/手机来源标记写入 AI CLI 的 argv、settings、stdin、子进程环境或 Hook 返回；官方 CLI 自身仍会如实标记其 print/exec 运行模式。
- **前端数据隔离**：设备、WebView、EasyTier、节点和传输指标只留在手机↔PC 控制面；图片在 PC 入口清除 EXIF/XMP/GPS/设备文本等容器元数据后才交给原生 CLI。
- **多账号**：只读引用 PC 上已有的 Claude / Codex 凭证集，不修改也不复制原生认证文件。
- **安全边界**：网关只绑定 loopback，经 EasyTier 的 no-tun/smoltcp 映射暴露给手机；不落库、不做 provider 流量中继。
- **免提权**：不创建 TUN 网卡、不改防火墙，与 Clash 等 TUN 全局模式共存。

## 运行拓扑

```text
Android glue ── REST/WS ──> moyu gateway ─┬─ stdin/stdout/hooks ──> Claude/Codex CLI ──> AI service
     │                                    └─ loopback REST/SSE ───> OpenCode Server ───> AI service
     └──────────── EasyTier overlay ───────┘
```

这里的“无产品标记注入”是相对同版本官方 CLI 的相同结构化无头模式进行差分验收，
不是伪装成交互式客户端。项目不会篡改 User-Agent、originator 或 CLI 遥测；也无法从外部证明
官方 CLI 自身的遥测、PC 出口 IP/时序、父进程或模型主动执行 OS 枚举完全不可区分。

## 原生认证兼容矩阵（v0.0.4）

| CLI | 认证方式 | Moyu 的只读接入方式 | 约束 |
| --- | --- | --- | --- |
| Claude Code | 原生 OAuth | native `~/.claude`，或 `<name>.env` 中设置 `CLAUDE_CONFIG_DIR=<已登录目录>` | OAuth/login 仍由 `claude` 完成 |
| Claude Code | setup-token OAuth | `<name>.env` 中设置 `CLAUDE_CODE_OAUTH_TOKEN` | token 只进入 Claude 子进程，不回显 |
| Claude Code | API/兼容 URL | `<name>.env` 中设置 `ANTHROPIC_API_KEY`，或 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` | 保留 Claude 原生配置、模型别名和代理行为 |
| Codex | ChatGPT OAuth | 先在独立 `CODEX_HOME` 执行 `codex login`，再让 `<name>.home` 指向该目录 | 多账号要求文件型 `auth.json`；系统凭据库不提供可移植的逐目录引用 |
| Codex | OpenAI API Key | 先在独立 `CODEX_HOME` 执行 `codex login --with-api-key`，再使用 `<name>.home` | 选择 Profile 时会隔离 shell 中继承的 OpenAI/Codex 标准凭据 |
| Codex | 火山/自建兼容 URL | 在该 `CODEX_HOME/config.toml` 配置 `model_provider`、`base_url`、`env_key`，并在同一 `<name>.home` 追加对应 `KEY=VALUE` | Codex 0.146 自定义 provider 必须兼容 Responses API；仅兼容 Chat Completions 的端点不可用 |
| OpenCode | OpenCode 原生 provider 配置（包括可直接使用的内置 free 模型） | OpenCode 自己读取 PC 本机配置和凭据；Moyu 只连接官方 Server API | 支持 Server 1.17.9–1.18.x；provider 凭据不进入 Moyu 协议或手机 |

Codex `<name>.home` 保持旧格式兼容：第一条非注释裸行仍是 `CODEX_HOME` 路径；也可写
`CODEX_HOME=<path>`。后续 `KEY=VALUE` 只作为该 Profile 的原生 Codex 环境，例如：

```text
D:\ai-profiles\codex-volcengine
ARK_API_KEY=...
```

Moyu 不调用登录接口、不刷新 OAuth、不验证 Provider 可达性，也不把凭据值送到手机。

OpenCode 有两种 PC 本机模式：`managed` 使用已安装的 OpenCode 可执行文件启动唯一一个
`opencode serve`；`attach` 只连接 `adapters.opencode.serverUrl` 指向的现有 loopback HTTP
Server，不要求 Moyu 能找到 OpenCode 可执行文件，也不会停止外部 Server。`moyu -init`
为 managed Server 自动生成稳定的 Basic Auth 口令并仅存入受保护的 PC 配置；
`OPENCODE_SERVER_PASSWORD` 可作为本机覆盖值，所有 Server 配置和口令均不会投影到手机。

若未来/特定 Desktop 构建实际随包或已暂存官方 service-capable CLI，Moyu 会自动发现并只
调用其公开的 `service status/start/get password`，作为第三种 `desktop-service` 有效模式；
该服务始终由 Desktop 所有，Moyu 退出时不会停止它。

OpenCode Desktop 1.18.21 的正式安装包仍未包含 service-capable CLI；其 v1 内置 sidecar
会为每次启动生成私有随机口令并只通过 Electron 私有 IPC 交给 renderer。Moyu 不抓取该
口令或 Desktop 私有状态。要在该版本共享同一历史/数据库，安装匹配的官方 OpenCode CLI，运行一次
`moyu -init`，再在 Desktop 的 Servers 页面添加 init 打印的 loopback URL、用户名和口令并
设为默认。之后 Desktop 与 Moyu 都是同一官方 Server 的客户端；无需在 Moyu 中配置模型
provider/API key，订阅与 provider 配置继续由 OpenCode 管理。

## 构建

要求 Node >= 22（开发）/ Bun（单二进制打包）。

```bash
npm install
npm run dev        # 开发模式（tsx watch）
npm run build      # bun scripts/build.mjs 产出 dist/moyu(.exe) 单二进制
npm run typecheck
npm test           # 单元 + 集成测试
```

构建脚本会从 `bin/<target>/` 内嵌对应平台的 `easytier-core`（EasyTier v2.6.4，LGPL-3.0，以 sidecar/spawn 方式嵌入，见 `bin/README.md` 与 `NOTICE.md`）。

## 首次初始化与配对

`moyu -init` 保存 CLI 配置目录和 relay，重启或启动后台网关，并在网关就绪后直接打印五分钟有效的手机配对字符串。配对串过期、已消费或需要连接另一台手机时，运行 `moyu -pair` 重新生成；无需再次初始化。

## 目录结构

| 路径 | 说明 |
|---|---|
| `src/` | 后端源码（gateway / api / session / adapters / net / approval 等模块） |
| `test/` | 单元、冒烟与集成测试 |
| `scripts/build.mjs` | 单二进制打包脚本 |
| `.github/workflows/release.yml` | GitHub Releases 按平台出包 |
| `docs`（`backend-design.md`、`frontend-architecture.md`、`frontend-handoff.md`） | 设计与交接文档 |
| `bin/README.md` | `easytier-core` 平台二进制放置与验证说明 |

## 许可证

Apache-2.0（见 `LICENSE`）。依赖的 EasyTier 为 LGPL-3.0，以独立进程 spawn 方式使用，详见 `NOTICE.md`。
