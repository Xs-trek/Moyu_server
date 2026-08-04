# moyu

moyu 是**本机 AI CLI 的远程控制面**（v0.0.2，Apache-2.0）。它让你用手机通过 EasyTier 叠加网络控制 PC 上已安装、已登录的原生 AI CLI（Claude / Codex / opencode），而不是再造一个 AI 网关：

- **0 出站**：后端不连接任何 AI provider、不发探针、不代持 token，也不使用 provider SDK。
- **驱动原生 CLI**：只通过 stdin/stdout/hooks 启动和驱动用户已有的 CLI，等价于用户在终端操作。
- **多账号**：只读引用 PC 上已有的 Claude / Codex 凭证集，不修改也不复制原生认证文件。
- **安全边界**：网关只绑定 loopback，经 EasyTier 的 no-tun/smoltcp 映射暴露给手机；不落库、不做 provider 流量中继。
- **免提权**：不创建 TUN 网卡、不改防火墙，与 Clash 等 TUN 全局模式共存。

## 运行拓扑

```text
Android glue ── REST/WS ──> moyu gateway ── stdin/stdout/hooks ──> native CLI ──> AI service
     │                         │                                      │
     └── EasyTier overlay ─────┘                                      └── native auth/proxy
```

## 构建

要求 Node >= 22（开发）/ Bun（单二进制打包）。

```bash
npm install
npm run dev        # 开发模式（tsx watch）
npm run build      # bun scripts/build.mjs 产出 bin/<target>/ 单二进制
npm run typecheck
npm test           # 单元 + 集成测试
```

构建脚本会从 `bin/<target>/` 内嵌对应平台的 `easytier-core`（EasyTier v2.6.4，LGPL-3.0，以 sidecar/spawn 方式嵌入，见 `bin/README.md` 与 `NOTICE.md`）。

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
