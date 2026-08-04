# Vendor binaries: `easytier-core` (§3)

This directory stages the per-platform `easytier-core` binaries that
`scripts/build.mjs` embeds into the moyu single-binary build. The directory and
its binaries are **gitignored** (large binaries are not committed); stage them
locally or let the GitHub Release workflow download them.

## Layout

```
bin/<target>/easytier-core[.exe]
```

One binary per target, named `easytier-core.exe` on Windows and `easytier-core`
elsewhere. The build embeds ONLY `easytier-core`; other files in the EasyTier
release archive (e.g. `easytier-cli`, `wintun.dll`, `Packet.dll`,
`WinDivert64.sys`) are **not** embedded and are not needed (moyu runs
`--no-tun` + loopback SOCKS5; see NOTICE.md).

## Targets & official EasyTier v2.6.4 release assets

Verified via the GitHub releases API. Download, unzip, and place
`easytier-core[.exe]` into the target directory below.

| target dir            | EasyTier release asset (v2.6.4)          | binary name        |
| --------------------- | ---------------------------------------- | ------------------ |
| `bin/win-x64/`        | `easytier-windows-x86_64-v2.6.4.zip`     | `easytier-core.exe`|
| `bin/win-arm64/`      | `easytier-windows-arm64-v2.6.4.zip`      | `easytier-core.exe`|
| `bin/linux-x64/`      | `easytier-linux-x86_64-v2.6.4.zip`       | `easytier-core`    |
| `bin/linux-arm64/`    | `easytier-linux-aarch64-v2.6.4.zip`      | `easytier-core`    |
| `bin/linux-x64-musl/` | `easytier-linux-x86_64-v2.6.4.zip`       | `easytier-core`    |
| `bin/linux-arm64-musl/` | `easytier-linux-aarch64-v2.6.4.zip`    | `easytier-core`    |
| `bin/macos-x64/`      | `easytier-macos-x86_64-v2.6.4.zip`       | `easytier-core`    |
| `bin/macos-arm64/`    | `easytier-macos-aarch64-v2.6.4.zip`      | `easytier-core`    |

Download URL pattern:
`https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/<asset>`

The official Linux archives are built from musl Rust targets, so the same
unmodified `easytier-core` is staged for the corresponding Bun glibc and musl
launcher directories.

## Local build

Only the **host** target's binary is required for `npm run build` (native
compile + selfcheck). Cross-compile targets need their respective binary staged
here first (`npm run build:<target>`).

## License

EasyTier is LGPL-3.0 (see `../NOTICE.md` and
https://github.com/EasyTier/EasyTier/blob/main/LICENSE).
