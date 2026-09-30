export type RealtimeAuthStatus = 'ready' | 'signed-out' | 'unknown';
export type RealtimeAuthCheckOptions = {
  /** Read-only saved-sign-in check. Must never start login, refresh access or prompt. */
  peek(signal: AbortSignal): Promise<boolean>;
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
  const finish = (status: RealtimeAuthStatus, notify = true) => {
    if (settled) return;
    settled = true; clearTimeout(timer); controller.abort(); resolve(status);
    // A settings observer cannot fail a call or create an unhandled rejection.
    if (notify) { try { options.onStatus?.(status); } catch {} }
  };
  const timeout = options.timeoutMs ?? 1000;
  const timer = setTimeout(() => finish('unknown'), Number.isFinite(timeout) ? Math.min(10000, Math.max(1, timeout)) : 1000);
  void Promise.resolve().then(() => {
    if (!settled) return options.peek(controller.signal);
  }).then(value => finish(value === true ? 'ready' : value === false ? 'signed-out' : 'unknown'), () => finish('unknown'));
  return { result, close() { finish('unknown', false); } };
}
