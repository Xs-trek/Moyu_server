// Claude adapter (A1). Subprocess `claude -p --output-format stream-json` + PreToolUse hook.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Adapter, AuthProfile, SessionHandle, SessionOpts } from '../types';
import type { AdapterConfig } from '../../config/schema';
import { probeVersion, which } from '../../util/spawn';
import { isWindows } from '../../util/platform';
import { detectClaudeAuth } from './auth';
import { ClaudeSession } from './session';
import type { HookRegistry } from '../../api/hooks';
import { mergeConfigDirectoryEnv } from '../config-location';

/**
 * Resolve the real claude binary (not the npm shim). On Windows the npm shim is
 * a .cmd that Node 24 refuses to spawn without a shell; spawning the underlying
 * native binary directly avoids both the .cmd restriction and shell-injection risk.
 */
export function resolveClaudeBinary(): string | null {
  const shim = which('claude');
  if (!shim) return null;
  const dir = dirname(shim);
  const exe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', isWindows ? 'claude.exe' : 'claude');
  if (existsSync(exe)) return exe;
  // legacy JS entry (older versions)
  const js = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  if (existsSync(js)) return js;
  return null;
}

export interface ClaudeAdapterDeps {
  port: number;
  approvalTimeoutSec: number;
  hooks: HookRegistry;
  adapterConfig: AdapterConfig; // v3: approvalPolicy (hook behavior); activeProfileId resolved per-session
}

export class ClaudeAdapter implements Adapter {
  readonly kind = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly capabilities = {
    streaming: { text: true, thinking: true, tools: true },
    resume: true,
    interrupt: true,
    accountProfiles: true,
    approval: {
      transport: 'http-hook' as const,
      semantics: 'remote-every-tool-or-never' as const,
      policies: ['untrusted', 'on-failure', 'on-request', 'never'] as const,
    },
    configuration: {
      model: true,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
      sandboxModes: [] as const,
      reviewers: [] as const,
    },
  };

  constructor(private deps: ClaudeAdapterDeps) {}

  async isAvailable(): Promise<boolean> {
    const bin = this.deps.adapterConfig.bin;
    if (bin) return (await probeVersion(bin)).ok; // pinned binary must actually run
    if (resolveClaudeBinary()) return true;
    return (await probeVersion('claude')).ok;
  }

  async detect(): Promise<AuthProfile> {
    return detectClaudeAuth(this.deps.adapterConfig.configDir);
  }

  async startSession(opts: SessionOpts): Promise<SessionHandle> {
    const bin = this.deps.adapterConfig.bin ?? resolveClaudeBinary();
    if (!bin) throw new Error('claude binary not found (set adapters.claude.bin or install claude-code)');
    const session = new ClaudeSession({
      sessionId: opts.sessionId,
      cliSessionRef: opts.cliSessionRef ?? opts.sessionId,
      cwd: opts.cwd,
      extraDirs: opts.extraDirs,
      port: this.deps.port,
      approvalTimeoutSec: this.deps.approvalTimeoutSec,
      hooks: this.deps.hooks,
      approvalPolicy: this.deps.adapterConfig.approvalPolicy,
      model: opts.model ?? this.deps.adapterConfig.model,
      effort: opts.effort,
      profileEnv: mergeConfigDirectoryEnv(
        this.deps.adapterConfig.configDir,
        'CLAUDE_CONFIG_DIR',
        opts.profileEnv,
      ),
      bin,
    });
    // #4: create-or-dispose -- if init throws, reclaim the temp settings dir + unregister the
    // hook before rethrowing, so a failed start leaks no resources.
    try {
      await session.init();
    } catch (e) {
      await session.dispose();
      throw e;
    }
    return session;
  }

  /** Live-apply a /config PATCH (review P1): approvalTimeoutSec + adapterConfig are captured at
   *  construction, so without this a PATCH never reaches NEW sessions. CAVEAT [M-L]: this only
   *  reconfigures adapter deps for FUTURE sessions; EXISTING sessions keep their construction-time
   *  approvalTimeoutSec/approvalPolicy/sandbox (frozen at construct), so a PATCH does NOT
   *  retroactively change a running session. */
  reconfigure(opts: { approvalTimeoutSec: number; adapterConfig: AdapterConfig }): void {
    this.deps = { ...this.deps, approvalTimeoutSec: opts.approvalTimeoutSec, adapterConfig: opts.adapterConfig };
  }
}

export function createClaudeAdapter(deps: ClaudeAdapterDeps): ClaudeAdapter {
  return new ClaudeAdapter(deps);
}
