// Opencode adapter (A3). `opencode serve` HTTP + SSE subprocess.
import type { Adapter, AuthProfile, SessionHandle, SessionOpts } from '../types';
import { probeVersion, which } from '../../util/spawn';
import { detectOpencodeAuth } from './auth';
import { OpencodeSession } from './session';

export interface OpencodeAdapterDeps {
  approvalTimeoutSec: number;
  password?: string;
  model?: string;
}

export class OpencodeAdapter implements Adapter {
  readonly kind = 'opencode' as const;
  readonly displayName = 'Opencode';
  readonly capabilities = {
    streaming: { text: true, thinking: false, tools: true },
    resume: true,
    interrupt: true,
    accountProfiles: false,
    approval: {
      transport: 'native' as const,
      semantics: 'native' as const,
      policies: [] as const,
    },
    configuration: {
      model: true,
      modelSelection: 'freeform' as const,
      effortLevels: [] as const,
      permissionModes: [] as const,
      sandboxModes: [] as const,
      reviewers: [] as const,
    },
  };

  constructor(private deps: OpencodeAdapterDeps) {}

  async isAvailable(): Promise<boolean> {
    if (which('opencode')) return true;
    return (await probeVersion('opencode')).ok;
  }

  async detect(): Promise<AuthProfile> {
    return detectOpencodeAuth();
  }

  async startSession(opts: SessionOpts): Promise<SessionHandle> {
    const session = new OpencodeSession({
      sessionId: opts.sessionId,
      cliSessionRef: opts.cliSessionRef ?? opts.sessionId,
      cwd: opts.cwd,
      approvalTimeoutSec: this.deps.approvalTimeoutSec,
      password: this.deps.password,
      model: opts.model ?? this.deps.model,
    });
    await session.init();
    return session;
  }
}

export function createOpencodeAdapter(deps: OpencodeAdapterDeps): OpencodeAdapter {
  return new OpencodeAdapter(deps);
}
