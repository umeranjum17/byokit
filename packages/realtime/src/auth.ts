export type RealtimeAuthStatus = 'ready' | 'signed-out' | 'unknown';
/** Additional app-defined reasons are allowed without changing the state contract. */
export type RealtimeAuthReason = 'credential-permissions' | 'login-expired' | 'missing' | 'unknown' | (string & {});
export type RealtimeAuthResult = { state: RealtimeAuthStatus; reason?: RealtimeAuthReason; message?: string };
export type RealtimeAuthPeekResult = boolean | { state: RealtimeAuthStatus; reason?: RealtimeAuthReason };

function describe(state: RealtimeAuthStatus, reason?: RealtimeAuthReason): RealtimeAuthResult {
  if (!reason) return { state };
  const message = reason === 'credential-permissions' ? 'Your saved sign-in must be readable only by you.'
    : reason === 'login-expired' ? 'Your saved sign-in has expired. Sign in again in settings.'
    : reason === 'missing' ? 'No saved sign-in was found. Sign in in settings.'
    : 'Your saved sign-in could not be checked.';
  return { state, reason, message };
}

function failure(error: unknown): RealtimeAuthResult {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const reason = error && typeof error === 'object' && 'reason' in error ? error.reason : undefined;
  if (reason === 'credential-permissions' || reason === 'login-expired' || reason === 'missing' || reason === 'unknown') return describe(reason === 'unknown' ? 'unknown' : 'signed-out', reason);
  if (code === 'ENOENT') return describe('signed-out', 'missing');
  if (code === 'EACCES' || code === 'EPERM' || code === 'credential-permissions' || (error instanceof Error && /owner.only|readable only by|permissions.*(?:credential|sign-in)|(?:credential|sign-in).*permissions/i.test(error.message))) return describe('signed-out', 'credential-permissions');
  if (code === 'login-expired' || code === 'TOKEN_EXPIRED' || (error instanceof Error && /\b(?:login|sign-in|token|credential)\b.*\bexpired\b/i.test(error.message))) return describe('signed-out', 'login-expired');
  return describe('unknown', 'unknown');
}

export type RealtimeAuthCheckOptions = {
  /** Read-only saved-sign-in check. Must never start login, refresh access or prompt. */
  peek(signal: AbortSignal): Promise<RealtimeAuthPeekResult>;
  /** Diagnostic observer, also available through the standalone details promise. */
  onResult?(result: RealtimeAuthResult): void;
  onStatus?(status: RealtimeAuthStatus): void;
  /** Defaults to 1 second; capped at 10 seconds. */
  timeoutMs?: number;
};

/** Advisory only: session startup must proceed independently of this check. */
export function realtimeAuthCheck(options: RealtimeAuthCheckOptions) {
  const controller = new AbortController();
  let settled = false;
  let resolve!: (status: RealtimeAuthStatus) => void;
  const result = new Promise<RealtimeAuthStatus>(done => { resolve = done; });
  let resolveDetails!: (result: RealtimeAuthResult) => void;
  const details = new Promise<RealtimeAuthResult>(done => { resolveDetails = done; });
  const finish = (value: RealtimeAuthResult, notify = true) => {
    if (settled) return;
    settled = true; clearTimeout(timer); controller.abort(); resolve(value.state); resolveDetails(value);
    // A settings observer cannot fail a call or create an unhandled rejection.
    if (notify) {
      try { options.onStatus?.(value.state); } catch {}
      try { options.onResult?.(value); } catch {}
    }
  };
  const timeout = options.timeoutMs ?? 1000;
  const timer = setTimeout(() => finish(describe('unknown', 'unknown')), Number.isFinite(timeout) ? Math.min(10000, Math.max(1, timeout)) : 1000);
  void Promise.resolve().then(() => {
    if (!settled) return options.peek(controller.signal);
  }).then(value => finish(typeof value === 'object' && value !== null ? describe(value.state, value.reason) : describe(value === true ? 'ready' : value === false ? 'signed-out' : 'unknown')), error => finish(failure(error)));
  return { result, details, close() { finish(describe('unknown', 'unknown'), false); } };
}
