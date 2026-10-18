// Account link without pasting a key (docs/cloud-kit.md 11.5, G1, K-CLAIM).
// Boat's agent sign-in (https://boat.dev/auth.md, the WorkOS agent-registration contract):
// discover the endpoints, register with service_auth for the person's email, show the
// claim link and then the code the person types on the provider's own page (the code
// never comes back), poll the token endpoint, and finish with the Boat key. The key
// reaches the caller only, in `done`: never a log, error text, argv or file.
// `revokeClaim()` ends a claimed key with RFC 7009 at the metadata's revocation_endpoint.
// Billing checkout and the trial (auth.md step 7) are not claim and stay out.
import { MachineError } from './errors.ts';

export type ClaimStep =
  | { step: 'open-page'; url: string }
  | { step: 'type-code'; url: string; code: string }
  | { step: 'waiting' }
  | { step: 'done'; key: string; expires: string | null; scopes: readonly string[] }
  | { step: 'failed'; why: 'refused' | 'expired' | 'unreachable' | 'provider' };

const METADATA = '/api/boat/.well-known/oauth-authorization-server';
const CLAIM_GRANT = 'urn:workos:agent-auth:grant-type:claim';
const ASSERT_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

// Internal outcomes: an abort ends the iterator with no step; every other failure ends
// it with one `failed` step, so the app re-runs claim() to retry.
class ClaimAbort extends Error {}
class ClaimRefused extends Error {}
class ClaimExpired extends Error {}
class ClaimUnreachable extends Error {}

const form = (entries: readonly (readonly [string, string])[]): string =>
  entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

const field = (json: unknown, name: string): unknown =>
  typeof json === 'object' && json !== null ? (json as Record<string, unknown>)[name] : undefined;

const errCode = (json: unknown): string | null => {
  const e = field(json, 'error');
  return typeof e === 'string' ? e : null;
};

// RFC 7009 at the metadata's revocation_endpoint. The service_auth registration issues no
// client id or secret, so the claimed key is the client authentication. Each failure is a
// MachineError naming its cause; the provider's own error code is kept, the token never.
const revokeAt = async (
  fetchFn: typeof fetch, endpoint: unknown, key: string, token: string, hint: string | null, signal?: AbortSignal,
): Promise<void> => {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new MachineError('unsupported', 'the provider metadata has no revocation_endpoint');
  }
  let res: Response;
  try {
    res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${key}` },
      body: form(hint === null ? [['token', token]] : [['token', token], ['token_type_hint', hint]]),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new MachineError('unreachable', 'the provider could not be reached');
  }
  if (res.ok) return;
  let code = '';
  try {
    const e = errCode(JSON.parse(await res.text()));
    if (e !== null && e !== token && e !== key) code = `: ${e.slice(0, 64)}`;
  } catch {
    code = '';
  }
  if (res.status === 401 || res.status === 403) {
    throw new MachineError('unauthorized', `the provider refused the revoke with ${res.status}${code}`);
  }
  throw new MachineError('provider', `the provider answered the revoke with ${res.status}${code}`);
};

/** End a key `claim()` returned (RFC 7009); once it resolves the provider refuses the key. */
export async function revokeClaim(o: {
  baseUrl: string; key: string; fetch?: typeof fetch; signal?: AbortSignal;
}): Promise<void> {
  const fetchFn = o.fetch ?? globalThis.fetch;
  let origin: string;
  try {
    origin = new URL(o.baseUrl).origin;
  } catch {
    throw new MachineError('provider', 'the provider address is not a URL');
  }
  let meta: Response;
  try {
    meta = await fetchFn(`${origin}${METADATA}`, {
      headers: { Accept: 'application/json' },
      ...(o.signal === undefined ? {} : { signal: o.signal }),
    });
  } catch (e) {
    if (o.signal?.aborted) throw e;
    throw new MachineError('unreachable', 'the provider could not be reached');
  }
  const json: unknown = await meta.json().catch(() => null);
  if (!meta.ok) throw new MachineError('provider', `the provider metadata answered ${meta.status}`);
  await revokeAt(fetchFn, field(json, 'revocation_endpoint'), o.key, o.key, 'access_token', o.signal);
}

const tokenResult = (json: unknown): { key: string; expires: string | null; scopes: readonly string[] } | null => {
  const key = typeof json === 'object' && json !== null ? (json as Record<string, unknown>)['access_token'] : undefined;
  if (typeof key !== 'string' || key.length === 0) return null;
  const record = json as Record<string, unknown>;
  const inSecs = record['expires_in'];
  const scope = record['scope'];
  return {
    key,
    expires: typeof inSecs === 'number' ? new Date(Date.now() + inSecs * 1000).toISOString() : null,
    scopes: typeof scope === 'string' ? scope.split(' ').filter((s) => s.length > 0) : [],
  };
};

export function claim(o: {
  baseUrl: string; email: string; fetch?: typeof fetch; signal?: AbortSignal;
}): AsyncIterable<ClaimStep> {
  const fetchFn = o.fetch ?? globalThis.fetch;
  const signal = o.signal;

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new ClaimAbort());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });

  const call = async (url: string, init: RequestInit): Promise<{ status: number; json: unknown }> => {
    let res: Response;
    try {
      res = await fetchFn(url, signal === undefined ? init : { ...init, signal });
    } catch {
      if (signal?.aborted) throw new ClaimAbort();
      throw new ClaimUnreachable();
    }
    if (signal?.aborted) throw new ClaimAbort();
    const text = await res.text().catch(() => {
      throw new ClaimUnreachable();
    });
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };

  return (async function* (): AsyncGenerator<ClaimStep> {
    if (signal?.aborted) return;
    try {
      let origin: string;
      try {
        origin = new URL(o.baseUrl).origin;
      } catch {
        throw new Error('the provider address is not a URL');
      }
      // 1. Discover the sign-in endpoints from the provider's own metadata.
      const meta = await call(`${origin}${METADATA}`, {
        headers: { Accept: 'application/json' },
      });
      const identityEndpoint = field(field(meta.json, 'agent_auth'), 'identity_endpoint');
      const tokenEndpoint = field(meta.json, 'token_endpoint');
      const revocationEndpoint = field(meta.json, 'revocation_endpoint');
      // The key arrives beside a fresh identity_assertion the app never sees: revoke it before
      // `done`, ignoring the abort, so no spare sign-in outlives the claim. If that fails, the
      // key is revoked too and the claim fails, rather than hand out a key with one left live.
      const dropSpare = async (json: unknown, key: string): Promise<void> => {
        const spare = field(json, 'identity_assertion');
        if (typeof spare !== 'string' || spare.length === 0) return;
        try {
          await revokeAt(fetchFn, revocationEndpoint, key, spare, null);
        } catch (e) {
          await revokeAt(fetchFn, revocationEndpoint, key, key, 'access_token').catch(() => undefined);
          throw e;
        }
      };
      if (meta.status < 200 || meta.status >= 300 || typeof identityEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
        throw new Error(`the provider metadata answered ${meta.status}`);
      }
      // 2. Register with service_auth for the person's email.
      const registered = await call(identityEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'service_auth', login_hint: o.email }),
      });
      if (registered.status === 400 || registered.status === 403 || registered.status === 404) {
        throw new ClaimRefused();
      }
      const claimToken = field(registered.json, 'claim_token');
      const ceremony = field(registered.json, 'claim');
      const code = field(ceremony, 'user_code');
      const verificationUri = field(ceremony, 'verification_uri');
      const rawInterval = field(ceremony, 'interval');
      let interval = typeof rawInterval === 'number' && rawInterval >= 0 ? rawInterval : 5;
      if (registered.status < 200 || registered.status >= 300 || typeof claimToken !== 'string' || claimToken.length === 0 ||
        typeof code !== 'string' || !/^\d{6}$/.test(code) || typeof verificationUri !== 'string' || verificationUri.length === 0) {
        throw new Error(`the provider registration answered ${registered.status}`);
      }
      // 3. Hand the ceremony to the person: the link first, then the code they type on
      // the provider's page. Neither comes back to the app.
      yield { step: 'open-page', url: verificationUri };
      if (signal?.aborted) return;
      yield { step: 'type-code', url: verificationUri, code };
      if (signal?.aborted) return;
      // 4. Poll until the person finishes, the code lapses, or the app aborts.
      yield { step: 'waiting' };
      const pollBody = form([['grant_type', CLAIM_GRANT], ['claim_token', claimToken]]);
      for (;;) {
        if (signal?.aborted) return;
        const polled = await call(tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: pollBody,
        });
        if (polled.status >= 200 && polled.status < 300) {
          const done = tokenResult(polled.json);
          if (done !== null) {
            await dropSpare(polled.json, done.key);
            yield { step: 'done', ...done };
            return;
          }
          // No key yet but a fresh assertion: exchange it once (auth.md step 5).
          const assertion = field(polled.json, 'identity_assertion');
          if (typeof assertion === 'string' && assertion.length > 0) {
            let resource: string;
            try {
              const href = new URL(o.baseUrl).href;
              resource = href.endsWith('/') ? href : `${href}/`;
            } catch {
              throw new Error('the provider address is not a URL');
            }
            const exchanged = await call(tokenEndpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: form([['grant_type', ASSERT_GRANT], ['assertion', assertion], ['resource', resource]]),
            });
            const rotated = exchanged.status >= 200 && exchanged.status < 300 ? tokenResult(exchanged.json) : null;
            if (rotated !== null) {
              await dropSpare(exchanged.json, rotated.key);
              yield { step: 'done', ...rotated };
              return;
            }
            if (errCode(exchanged.json) === 'invalid_grant') throw new ClaimRefused();
            throw new Error(`the sign-in exchange answered ${exchanged.status}`);
          }
          throw new Error(`the sign-in poll answered ${polled.status}`);
        }
        switch (errCode(polled.json)) {
          case 'authorization_pending':
            await wait(interval * 1000);
            continue;
          case 'slow_down':
            interval += 5;
            await wait(interval * 1000);
            continue;
          case 'expired_token': throw new ClaimExpired();
          case 'invalid_grant': throw new ClaimRefused();
          default: throw new Error(`the sign-in poll answered ${polled.status}`);
        }
      }
    } catch (e) {
      if (e instanceof ClaimAbort) return;
      if (e instanceof ClaimRefused) yield { step: 'failed', why: 'refused' };
      else if (e instanceof ClaimExpired) yield { step: 'failed', why: 'expired' };
      else if (e instanceof ClaimUnreachable || (e instanceof MachineError && e.code === 'unreachable')) yield { step: 'failed', why: 'unreachable' };
      else yield { step: 'failed', why: 'provider' };
    }
  })();
}
