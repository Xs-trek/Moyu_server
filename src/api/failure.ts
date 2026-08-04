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
  const safe = safeFailure(error);
  return { status: 500, code: 'internal', retryable: false, category: safe.category, summary: 'operation failed' };
}
