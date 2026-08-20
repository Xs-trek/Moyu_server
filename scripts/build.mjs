#!/usr/bin/env bun
// §3 single-binary delivery (T2–T6). Embeds the per-platform `easytier-core` as a
// Bun compile file asset and produces a self-contained `dist/moyu[.exe]` -- no
// external bin/ dir or PATH needed at runtime (resolveBin() materializes the
// embedded asset to a temp dir; see src/net/embedded-bin.ts).
//
// Usage:
//   bun scripts/build.mjs                       # native build for the HOST platform
//   bun scripts/build.mjs --target linux-arm64  # cross-compile (all 8 targets supported)
//   bun scripts/build.mjs --no-selfcheck        # skip the post-build smoke (cross builds)
//
// The vendor binary for the target MUST exist at bin/<target>/easytier-core[.exe].
// For the host build that is the only one required locally; the GitHub Release
// workflow downloads the rest per target.
import { copyFileSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// target name -> { bun compile triple, whether the binary has a .exe extension }
const TARGETS = {
  'win-x64':          { triple: 'bun-windows-x64',       exe: true  },
  'win-arm64':        { triple: 'bun-windows-arm64',     exe: true  },
  'linux-x64':        { triple: 'bun-linux-x64',         exe: false },
  'linux-arm64':      { triple: 'bun-linux-arm64',       exe: false },
  'linux-x64-musl':   { triple: 'bun-linux-x64-musl',    exe: false },
  'linux-arm64-musl': { triple: 'bun-linux-arm64-musl',  exe: false },
  'macos-x64':        { triple: 'bun-darwin-x64',        exe: false },
  'macos-arm64':      { triple: 'bun-darwin-arm64',      exe: false },
};

/** Native host target (musl is opt-in via --target; native linux assumes glibc). */
function hostTarget() {
  const p = os.platform();
  const a = os.arch();
  if (p === 'win32') return a === 'arm64' ? 'win-arm64' : 'win-x64';
  if (p === 'darwin') return a === 'arm64' ? 'macos-arm64' : 'macos-x64';
  if (p === 'linux') return a === 'arm64' ? 'linux-arm64' : 'linux-x64';
  throw new Error(`unsupported host platform: ${p}`);
}

function parseArgs(argv) {
  let target = null;
  let selfcheck = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') {
      target = argv[++i];
    } else if (a.startsWith('--target=')) {
      target = a.slice('--target='.length);
    } else if (a === '--no-selfcheck') {
      selfcheck = false;
    } else if (a === '--help' || a === '-h') {
      console.log(`usage: bun scripts/build.mjs [--target <name>] [--no-selfcheck]\ntargets: ${Object.keys(TARGETS).join(', ')}`);
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return { target, selfcheck };
}

function vendorBinary(target) {
  const exe = TARGETS[target].exe ? 'easytier-core.exe' : 'easytier-core';
  return join(ROOT, 'bin', target, exe);
}

function build() {
  const { target: requested, selfcheck } = parseArgs(process.argv.slice(2));
  const target = requested ?? hostTarget();
  if (!TARGETS[target]) {
    console.error(`unknown target: ${target}\nvalid: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(2);
  }
  // #3: local C3 egress gate -- the SAME static check CI's `verify` job runs (and `npm test`
  // includes). Enforced before compile so a local `npm run build` can never emit an artifact
  // that violates the 0-perception outbound invariant. Runs on the current runtime (bun, since
  // `npm run build` => `bun scripts/build.mjs`); resolves `typescript` from node_modules.
  // Cross-builds (--no-selfcheck) still run this gate -- C3 is independent of the selfcheck.
  console.log('#3: C3 egress gate (test/unit-egress.ts)');
  const egress = spawnSync(process.execPath, ['test/unit-egress.ts'], { cwd: ROOT, stdio: 'inherit' });
  if (egress.status !== 0) {
    console.error(`#3: C3 egress gate FAILED (exit ${egress.status}) -- refusing to build`);
    process.exit(1);
  }

  // Use the installed Node runtime for tsx even when this build script itself is hosted by Bun;
  // Bun's preload semantics are not compatible with tsx's Node loader.
  const nodeExecutable = process.platform === 'win32' ? 'node.exe' : 'node';
  console.log('#3: provider-surface differential gate (test/unit-provider-surface.ts)');
  const providerSurface = spawnSync(
    nodeExecutable,
    [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'test', 'unit-provider-surface.ts')],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (providerSurface.status !== 0) {
    console.error(`#3: provider-surface differential gate FAILED (exit ${providerSurface.status}) -- refusing to build`);
    process.exit(1);
  }

  console.log('#3: native CLI surface gate (test/unit-hook-command.ts)');
  const hookSurface = spawnSync(
    nodeExecutable,
    [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'test', 'unit-hook-command.ts')],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (hookSurface.status !== 0) {
    console.error(`#3: native CLI surface gate FAILED (exit ${hookSurface.status}) -- refusing to build`);
    process.exit(1);
  }

  const isNative = target === hostTarget();
  const vendor = vendorBinary(target);
  if (!existsSync(vendor)) {
    console.error(`§3: vendor binary missing for target '${target}': ${vendor}`);
    console.error(`  download easytier-core v2.6.4 for ${target} and place it there.`);
    console.error(`  (the GitHub Release workflow does this automatically; see .github/workflows/release.yml)`);
    process.exit(1);
  }

  const buildDir = join(ROOT, 'build');
  const embeddedDir = join(buildDir, 'embedded');
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(embeddedDir, { recursive: true });

  // Stage the vendor binary as the embedded file asset.
  const assetPath = join(embeddedDir, 'easytier-core.bin');
  copyFileSync(vendor, assetPath);

  // Generated entry: static import order guarantees set-global runs BEFORE
  // src/index.ts, and static imports are always bundled by bun --compile (a
  // dynamic import() would risk being left as a runtime resolution).
  writeFileSync(
    join(buildDir, 'set-global.ts'),
    `// AUTO-GENERATED by scripts/build.mjs (§3). Sets the embedded easytier-core\n` +
      `// asset path on the global so resolveBin() can materialize it at runtime.\n` +
      `// MUST run before src/index.ts (entry.ts import order enforces this).\n` +
      `import binPath from './embedded/easytier-core.bin' with { type: 'file' };\n` +
      `(globalThis as any).__MOYU_COMPILED__ = true;\n` +
      `(globalThis as any).__MOYU_EMBEDDED_EASYTIER = binPath;\n`,
  );
  writeFileSync(
    join(buildDir, 'entry.ts'),
    `// AUTO-GENERATED by scripts/build.mjs (§3). Do not edit; do not commit.\n` +
      `// Import order is significant: set-global sets the embedded-asset global,\n` +
      `// THEN src/index.ts starts the server (which reads it via materializeEmbeddedBin).\n` +
      `import './set-global.ts';\n` +
      `import '../src/index.ts';\n`,
  );

  const outExt = TARGETS[target].exe ? '.exe' : '';
  const distDir = join(ROOT, 'dist');
  const outfile = join(distDir, `moyu${outExt}`);
  mkdirSync(distDir, { recursive: true });

  const compileArgs = ['build', '--compile', join(buildDir, 'entry.ts'), '--outfile', outfile];
  if (!isNative) compileArgs.push('--target', TARGETS[target].triple);

  console.log(`§3: building moyu for ${target} (${isNative ? 'native' : 'cross ' + TARGETS[target].triple})`);
  // Reuse the Bun executable that is running this script. On Windows, Bun's Node-compatible
  // spawnSync can fail to resolve a bare `bun` command even when the parent was launched by an
  // absolute path, which makes an otherwise valid local release build report status=null.
  const r = spawnSync(process.execPath, compileArgs, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`§3: bun build failed (exit ${r.status})`);
    rmSync(buildDir, { recursive: true, force: true });
    process.exit(1);
  }

  // Clean the generated build scaffolding (the asset is now embedded in dist/).
  rmSync(buildDir, { recursive: true, force: true });

  if (selfcheck && isNative) {
    // §3 "single artifact, no external bin/PATH" smoke: run the compiled binary
    // from a TEMP cwd with a stripped PATH and confirm both the embedded network
    // core and the neutral local command alias can spawn. Only meaningful for a
    // native build (a foreign-arch binary can't execute on this host).
    // Keep the smoke cwd on the repository volume. On Windows, the compiled artifact may be
    // launched under a sandbox/job that denies nested ACL helpers when cwd is the OS TEMP root;
    // the runtime helper itself still materializes and executes from OS TEMP, so this does not
    // weaken the self-contained or stripped-PATH proof.
    const tmpCwd = join(distDir, `.artifact-check-${process.pid}`);
    // Remove a stale same-PID directory from an interrupted prior build before recreating it.
    rmSync(tmpCwd, { recursive: true, force: true });
    mkdirSync(tmpCwd, { recursive: true });
    const minimalPath = os.platform() === 'win32'
      ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`
      : '/usr/bin';
    const checkEnv = Object.fromEntries(
      Object.entries({ ...process.env, PATH: minimalPath })
        .filter(([key]) => !key.toUpperCase().startsWith('BUN_')),
    );
    const sc = spawnSync(outfile, ['--selfcheck'], { cwd: tmpCwd, env: checkEnv, stdio: 'inherit' });
    rmSync(tmpCwd, { recursive: true, force: true });
    if (sc.status !== 0) {
      console.error(`§3: selfcheck FAILED (exit ${sc.status}) -- compiled runtime helpers are unavailable`);
      process.exit(1);
    }
    console.log(`§3: selfcheck OK (artifact is self-contained: ${outfile})`);
  } else if (selfcheck && !isNative) {
    console.log(`§3: selfcheck skipped (cross-compiled ${target}; run \`moyu --selfcheck\` on the target platform)`);
  }
  console.log(`§3: done -> ${outfile}`);
}

build();
