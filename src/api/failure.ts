// Small, stable client-error vocabulary. Expected operational failures are actionable;
// unexpected errors remain generic so internal paths, CLI stderr and credentials never leak.
import { safeFailure, type FailureCategory } from '../util/logger';

export interface ClientFailure {
  status: number;
  code: string;
  retryable: boolean;
  category?: FailureCategory;
  summary: string;
}

export function toClientFailure(error: unknown): ClientFailure {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (message === 'session not found')
    return { status: 404, code: 'session_not_found', retryable: false, summary: 'session not found' };
  if (message === 'active session limit reached')
    return { status: 429, code: 'session_limit', retryable: true, summary: 'active session limit reached' };
  if (message === 'session input queue full')
    return { status: 429, code: 'queue_full', retryable: true, summary: 'session input queue full' };
  if (message === 'session disposed')
    return { status: 409, code: 'session_disposed', retryable: false, summary: 'session is closed' };
  if (message === 'approval is not pending')
    return { status: 409, code: 'approval_not_pending', retryable: false, summary: 'approval is no longer pending' };
  if (message === 'body too large')
    return { status: 413, code: 'body_too_large', retryable: false, summary: 'request body is too large' };
  if (message.startsWith('adapter not available:'))
    return { status: 409, code: 'adapter_unavailable', retryable: false, category: 'not-found', summary: 'adapter CLI is unavailable' };
  // Expected create/config failures need a stable, actionable code without exposing the
  // user-controlled profile id, local path, or raw CLI stderr carried by the internal message.
  if (message.startsWith('unknown profile id:'))
    return { status: 409, code: 'profile_unavailable', retryable: false, category: 'auth', summary: 'selected account profile is unavailable; refresh accounts and select an available profile' };
  if (message.startsWith('unsupported effort for'))
    return { status: 400, code: 'unsupported_effort', retryable: false, summary: 'selected reasoning effort is unsupported by this adapter' };
  if (message.startsWith('unsupported permission mode for'))
    return { status: 400, code: 'unsupported_permission_mode', retryable: false, summary: 'selected permission mode is unsupported by this adapter' };
  if (message === 'unable to apply private Windows ACL')
    return { status: 503, code: 'local_security_unavailable', retryable: false, summary: 'local private-file protection is unavailable; run moyu -check on the PC' };
  if (message === 'Claude required command hooks are disabled or unavailable')
    return { status: 409, code: 'approval_guard_unavailable', retryable: false, summary: 'Claude command-hook approval guard is unavailable; check Claude policy and run moyu -check on the PC' };
  const safe = safeFailure(error);
  return { status: 500, code: 'internal', retryable: false, category: safe.category, summary: 'operation failed' };
}
