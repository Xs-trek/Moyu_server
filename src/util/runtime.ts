// Runtime identity helpers shared by the single-binary entry and subprocess adapters.
// The build-generated entry sets this flag before importing src/index.ts. Source/tsx
// execution leaves it unset, which lets adapters choose a development bootstrap.

interface MoyuRuntimeGlobal {
  __MOYU_COMPILED__?: boolean;
}

export function isCompiledBinary(): boolean {
  return (globalThis as MoyuRuntimeGlobal).__MOYU_COMPILED__ === true;
}

/** Remove only moyu's own control-plane variables before spawning an AI CLI. These values
 * identify the integration and can otherwise be inherited by tool subprocesses and echoed
 * into the model transcript by a normal `env` command. Provider credentials are deliberately
 * untouched: profile selection must behave exactly like the user's native shell export. */
export function scrubMoyuEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith('RD_HOOK_') || key.startsWith('MOYU_') || key === 'REMOTE_DASHBOARD_CONFIG') {
      delete clean[key];
    }
  }
  return clean;
}
