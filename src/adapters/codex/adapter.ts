// Codex adapter (A2/#1). Streaming `codex exec --json` subprocess + PreToolUse command hook.
import type { Adapter, AuthProfile, SessionHandle, SessionOpts } from '../types';
import type { AdapterConfig } from '../../config/schema';
import type { HookRegistry } from '../../api/hooks';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { probeVersion, which } from '../../util/spawn';
import { getArch, isWindows } from '../../util/platform';
import { detectCodexAuth } from './auth';
import { CodexSession } from './session';
import { log } from '../../util/logger';
import { isSupportedCodexVersion } from './protocol';
import { mergeConfigDirectoryEnv } from '../config-location';

/**
 * Resolve the real codex binary (not the npm .cmd shim). On Windows the npm shim is a .cmd
 * that Node refuses to spawn without a shell; spawning the underlying native binary directly
 * avoids both the .cmd restriction and shell-injection risk (codex exec takes the user prompt
 * as a positional arg, which a shell would re-interpret). Mirrors resolveClaudeBinary.
 * Returns null if only the shim is available -- the caller surfaces a clear error so the user
 * knows to set adapters.codex.bin, instead of an opaque spawn EINVAL at runtime.
 */
export function resolveCodexBinary(configured?: string): string | null {
  const located = configured ? (which(configured) ?? configured) : which('codex');
  if (!located) return null;
  if (!/\.(cmd|bat)$/i.test(located)) return located;
  if (!isWindows) return null;

  const root = dirname(located);
  const arch = getArch();
  const packageName = arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const packageRoots = [
    join(root, 'node_modules', '@openai', packageName),
    join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', packageName),
    join(root, 'node_modules', '@openai', 'codex'),
  ];
  for (const packageRoot of packageRoots) {
    const executable = join(packageRoot, 'vendor', triple, 'bin', 'codex.exe');
    if (existsSync(executable)) return executable;
  }
  return null;
}

export interface CodexAdapterDeps {
  approvalTimeoutSec: number;
  adapterConfig: AdapterConfig; // v3: approval/sandbox/reviewer/model (activeProfileId resolved per-session via SessionOpts.profileEnv)
  /** Gateway port the per-session PreToolUse relay posts to. */
  port: number;
  /** #1: HookRegistry to register the per-session PreToolUse handler. */
  hooks: HookRegistry;
}

export class CodexAdapter implements Adapter {
  readonly kind = 'codex' as const;
  readonly displayName = 'Codex';
  readonly capabilities = {
    streaming: { text: true, thinking: true, tools: true },
    resume: true,
    interrupt: true,
    accountProfiles: true,
    approval: {
      transport: 'command-hook' as const,
      semantics: 'remote-every-tool-or-never' as const,
      policies: ['untrusted', 'on-failure', 'on-request', 'never'] as const,
    },
    configuration: {
      model: true,
      effortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'] as const,
      sandboxModes: ['read-only', 'workspace-write', 'danger-full-access'] as const,
      reviewers: ['user', 'auto_review', 'guardian_subagent'] as const,
    },
  };
  private compatibleBin: string | null = null;

  constructor(private deps: CodexAdapterDeps) {}

  private async checkCompatible(bin: string): Promise<boolean> {
    if (this.compatibleBin === bin) return true;
    const result = await probeVersion(bin);
    const compatible = result.ok && isSupportedCodexVersion(result.version);
    if (compatible) this.compatibleBin = bin;
    else log.warn('codex CLI version is unsupported', { expected: '0.146.x', detected: result.version ?? 'unavailable' });
    return compatible;
  }

  async isAvailable(): Promise<boolean> {
    const bin = resolveCodexBinary(this.deps.adapterConfig.bin);
    return bin ? await this.checkCompatible(bin) : false;
  }

  async detect(): Promise<AuthProfile> {
    return detectCodexAuth(this.deps.adapterConfig.configDir);
  }

  async startSession(opts: SessionOpts): Promise<SessionHandle> {
    // 高-1: resolve the real codex binary (bypass the .cmd shim). adapterConfig.bin wins;
    // else resolveCodexBinary() finds the native exe. If only the shim exists, throw a clear
    // error instead of an opaque spawn EINVAL at runTurn time.
    const bin = resolveCodexBinary(this.deps.adapterConfig.bin);
    if (!bin) {
      throw new Error(
        'codex native executable not found; install Codex CLI or set adapters.codex.bin',
      );
    }
    if (!(await this.checkCompatible(bin))) {
      throw new Error('unsupported Codex CLI version; this backend requires 0.146.x');
    }
    const session = new CodexSession({
      sessionId: opts.sessionId,
      cliSessionRef: opts.cliSessionRef ?? opts.sessionId,
      cwd: opts.cwd,
      extraDirs: opts.extraDirs,
      port: this.deps.port,
      hooks: this.deps.hooks,
      approvalTimeoutSec: this.deps.approvalTimeoutSec,
      model: opts.model ?? this.deps.adapterConfig.model,
      effort: opts.effort,
      approvalPolicy: this.deps.adapterConfig.approvalPolicy,
      sandbox: this.deps.adapterConfig.sandbox,
      approvalsReviewer: this.deps.adapterConfig.approvalsReviewer,
      profileEnv: mergeConfigDirectoryEnv(
        this.deps.adapterConfig.configDir,
        'CODEX_HOME',
        opts.profileEnv,
      ),
      spawnBin: bin,
    });
    // #4: create-or-dispose. If init() fails (e.g. codex binary missing, hook register clash),
    // reclaim the partially-constructed session (unregister hook, clear tracker) before rethrowing
    // -- otherwise a failed init leaks the hook handler and blocks the next startSession.
    try {
      await session.init();
    } catch (e) {
      log.warn('codex session init failed; disposing partial session', { err: String(e) });
      try {
        await session.dispose();
      } catch {
        // best-effort cleanup
      }
      throw e;
    }
    return session;
  }

  /** Live-apply a /config PATCH (review P1): approvalTimeoutSec + adapterConfig are captured at
   *  construction, so without this a PATCH never reaches NEW sessions. CAVEAT [M-L]: this only
   *  reconfigures adapter deps for FUTURE sessions; EXISTING sessions keep their construction-time
   *  approvalTimeoutSec/approvalPolicy/sandbox (ApprovalTracker + opts are frozen at construct),
   *  so a PATCH does NOT retroactively change a running session. */
  reconfigure(opts: { approvalTimeoutSec: number; adapterConfig: AdapterConfig }): void {
    this.deps = { ...this.deps, approvalTimeoutSec: opts.approvalTimeoutSec, adapterConfig: opts.adapterConfig };
    this.compatibleBin = null;
  }
}

export function createCodexAdapter(deps: CodexAdapterDeps): CodexAdapter {
  return new CodexAdapter(deps);
}
