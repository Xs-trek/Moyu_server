# NOTICE

moyu (the `remote-dashboard` package)
Copyright 2025 moyu contributors

Licensed under the Apache License, Version 2.0 (see `LICENSE`).

---

## Embedded third-party binary: EasyTier `easytier-core`

The moyu single-binary build (§3, `scripts/build.mjs`) embeds the
**EasyTier `easytier-core`** binary as a Bun compile file asset and extracts it
to a per-process temp directory at runtime, then spawns it as a **subprocess**.
moyu communicates with `easytier-core` solely via CLI arguments and
stdout/stderr. It does **not** link (statically or dynamically) against
EasyTier; the binary is invoked as an independent program. This is "mere
aggregation" / spawn-only use (design note T5), not a derivative work of
EasyTier.

- **Component:** EasyTier `easytier-core`
- **Upstream:** https://github.com/EasyTier/EasyTier
- **Version:** 2.6.4 (build `8428a89d`)
- **License:** GNU Lesser General Public License v3.0 (LGPL-3.0)
- **Upstream license text:** https://github.com/EasyTier/EasyTier/blob/main/LICENSE
- **Modification status:** unmodified official release build.

### LGPL-3.0 compliance notes

- The embedded `easytier-core` is an **unmodified** official EasyTier release
  binary, conveyed alongside moyu.
- Corresponding source for EasyTier is available from the upstream repository
  linked above (tag `v2.6.4`).
- Because moyu invokes `easytier-core` as a separate subprocess (no linking),
  replacing the embedded EasyTier binary with a compatible version is possible:
  stage a replacement `easytier-core[.exe]` under `bin/<target>/` and rebuild
  (`bun scripts/build.mjs --target <target>`), or set `network.easytierBin` in
  the config to point at an external binary (dev/source mode bypasses the
  embedded asset entirely).

## Asset source & version notes (§3)

The per-platform `easytier-core` binaries are obtained from the official
EasyTier GitHub release `v2.6.4`. The build embeds ONLY `easytier-core`; the
other files shipped in EasyTier's Windows archive (`wintun.dll`, `Packet.dll`,
`WinDivert64.sys`) are TUN-mode dependencies and are **not** used or embedded —
moyu runs `easytier-core` with `--no-tun` + a loopback SOCKS5 config (§1/N4
baseline), which does not load the TUN driver.

### Verified official release assets (v2.6.4)

Confirmed via the GitHub releases API (`/repos/EasyTier/EasyTier/releases/tags/v2.6.4`):

| moyu target         | EasyTier release asset                  |
| ------------------- | --------------------------------------- |
| `win-x64`           | `easytier-windows-x86_64-v2.6.4.zip`    |
| `win-arm64`         | `easytier-windows-arm64-v2.6.4.zip`     |
| `linux-x64`         | `easytier-linux-x86_64-v2.6.4.zip`      |
| `linux-arm64`       | `easytier-linux-aarch64-v2.6.4.zip`     |
| `linux-x64-musl`    | `easytier-linux-x86_64-v2.6.4.zip`      |
| `linux-arm64-musl`  | `easytier-linux-aarch64-v2.6.4.zip`     |
| `macos-x64`         | `easytier-macos-x86_64-v2.6.4.zip`      |
| `macos-arm64`       | `easytier-macos-aarch64-v2.6.4.zip`     |

Download URL pattern:
`https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/<asset>`

### Linux glibc and musl launchers

EasyTier's v2.6.4 release workflow builds the official Linux archives from the
`x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` Rust targets. The
archive names do not carry a `musl` suffix, but their static `easytier-core`
binaries are suitable for both moyu launcher variants. The release workflow
therefore reuses each matching official Linux archive for the Bun glibc and
musl targets; no unofficial or locally rebuilt EasyTier binary is introduced.

## Runtime extraction

At runtime, `materializeEmbeddedBin()` (see `src/net/embedded-bin.ts`) writes
the embedded bytes to a versioned temp dir:

- `os.tmpdir()/moyu-easytier-<VERSION>-<platform>-<arch>/easytier-core[.exe]`
- A `.moyu-stamp` file records `<VERSION>|<platform>|<arch>` so a residue left
  by an abnormal exit is **safely reused** (same version+platform) or **cleaned
  on the next start** (stale version/platform mismatch).
- On a clean shutdown, the temp dir is removed best-effort (process `exit`).
