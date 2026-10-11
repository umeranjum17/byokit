// One provider's RFC 8628 device sign-in, stood in for: the code the person types, the page that approves it, polling
// until the provider says yes, and refresh (with and without rotation). The same answers and the same CORS answer any
// provider's own page gets, so a phone, a web page or a test signs in end to end with no account and no real network.
// Point a provider's catalogue `device` data at this with `deviceBase` (`Accounts`' `deviceBase` option):
//   node packages/accounts/src/testing/mock-device.ts [port]      (21555 by default)
// `dialect: 'minimax'` replays the pinned engine's MiniMax user-code shape instead (see below).
// `dialect: 'copilot'` replays GitHub Copilot: the device grant answers an intermediate GitHub token, which an exchange
// POSTs as `Authorization: Bearer` to /copilot_internal/v2/token for the credential. `domain` names the GitHub host
// (github.com by default, or an enterprise domain), separate from `host`, the bind address.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

/** `expiresIn` is how long each token lives; a device code always has the 15 minutes RFC 8628's own clients use.
 *  `rotate: false` is a provider that keeps its grant: a refresh answers a new access token and no refresh token.
 *  `dialect: 'minimax'` replays the pinned engine's MiniMax user-code sign-in for one region (`region`, global by
 *  default): an absolute `expired_in` at the code step and pending/success/error token bodies. Every answer equals
 *  fixtures/conformance/minimax-oauth-typescript.json; the minimax journey asserts that stays true. */
export type MockDeviceOptions = { port?: number; host?: string; expiresIn?: number; rotate?: boolean; dialect?: 'minimax' | 'copilot'; region?: 'global' | 'cn'; domain?: string; log?: (line: string) => void };
const CODE_LIVES_S = 900;

/** Each provider's own documented device endpoints, answered under whatever base the kit is given. */
const AUTHORIZATIONS = ['/oauth2/device/code', '/api/oauth/device_authorization'];
const TOKENS = ['/oauth2/token', '/api/oauth/token'];
/** GitHub Copilot's own endpoints (`pi-ai github-copilot.js`): the device and token steps on the named GitHub host, the
 *  credential exchange on its `api.` sibling. */
const COPILOT_DEVICE = '/login/device/code';
const COPILOT_ACCESS = '/login/oauth/access_token';
const COPILOT_EXCHANGE = '/copilot_internal/v2/token';
const COPILOT_CODE = 'FIXTURE-COPILOT-CODE';

/** The pinned engine's MiniMax facts (extensions/minimax/oauth.ts): two regions share one client id and the same
 *  /oauth2 paths. Mirrors fixtures/conformance/minimax-oauth-typescript.json. */
const MINIMAX = {
  global: { oauthBaseUrl: 'https://account.minimax.io', baseUrl: 'https://api.minimax.io' },
  cn: { oauthBaseUrl: 'https://account.minimaxi.com', baseUrl: 'https://api.minimaxi.com' },
} as const;
const MINIMAX_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:user_code';
const MINIMAX_USER_CODE = 'FIXTURE-MINIMAX-CODE';
type MiniMaxRegion = 'global' | 'cn';
/** The exact case bodies of fixtures/conformance/minimax-oauth-typescript.json, by region. */
const MINIMAX_CASES = (region: MiniMaxRegion) => ({
  start: { status: 200, body: { user_code: MINIMAX_USER_CODE, verification_uri: `${MINIMAX[region].oauthBaseUrl}/activate`, expired_in: 4102444800000, interval: 2 } },
  pending: { status: 200, body: { status: 'pending' } },
  success: { status: 200, body: { status: 'success', access_token: 'recorded-access', refresh_token: 'recorded-refresh', expired_in: 3600, resource_url: MINIMAX[region].baseUrl, notification_message: 'MiniMax sign-in complete' } },
  error: { status: 200, body: { status: 'error' } },
  expired: { status: 400, body: { base_resp: { status_msg: 'the user code is invalid or has expired' } } },
});
/** GitHub Copilot's recorded answers (`pi-ai github-copilot.js`). Mirrors the `cases` of
 *  fixtures/conformance/device-code-rfc8628-typescript.json, with `{host}` rendered as `domain`. */
const COPILOT_CASES = (domain: string) => ({
  start: { status: 200, body: { device_code: 'FIXTURE-COPILOT-DEVICE', user_code: COPILOT_CODE, verification_uri: `https://${domain}/login/device`, interval: 2, expires_in: CODE_LIVES_S } },
  pending: { status: 400, body: { error: 'authorization_pending' } },
  success: { status: 200, body: { access_token: 'FIXTURE-GITHUB-TOKEN', token_type: 'bearer', scope: 'read:user' } },
  decline: { status: 400, body: { error: 'access_denied' } },
  exchange: { status: 200, body: { token: 'FIXTURE-COPILOT-TOKEN', expires_at: 4102444800 } },
  unauthorized: { status: 401, body: { error: 'unauthorized' } },
});
const challengeOf = (verifier: string) => Buffer.from(createHash('sha256').update(verifier).digest()).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function mockDevice({ port = 0, host = '127.0.0.1', expiresIn = 3600, rotate = true, dialect, region = 'global', domain = 'github.com', log }: MockDeviceOptions = {}) {
  const codes = new Map<string, { device: string; approved?: boolean; denied?: boolean; challenge?: string }>();
  let asked = 0, issued = 0;
  const state = { live: new Set<string>(), requests: [] as { path: string; body: string }[], /** Drop this many polls, as a phone cuts a backgrounded app's network. */ dropPolls: 0, /** Answer the minimax token step as an expired user code. */ expire: false,
    /** Refuse the next Copilot exchange with this status (401 by default), as a revoked GitHub grant does. */ refuse: false, refuseStatus: 401 };
  const accessOf = new Map<string, string>(); // refresh token → the access token issued with it
  // Every sign-in issues a new refresh token; a rotating refresh spends the grant it replaces.
  const issue = () => {
    const refresh = `rt_${++issued}`;
    state.live.add(refresh);
    accessOf.set(refresh, `at_${accessOf.size + 1}`);
    return { access_token: accessOf.get(refresh)!, refresh_token: refresh, expires_in: expiresIn, token_type: 'Bearer' };
  };

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? '/', 'http://x');
    const form = new URLSearchParams(body);
    state.requests.push({ path: url.pathname, body });
    log?.(`${req.method} ${url.pathname} ${form.get('grant_type') ?? ''}`.trim());
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, GET, OPTIONS' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'OPTIONS') return send(200, {});
    switch (url.pathname) {
      case AUTHORIZATIONS[0]: case AUTHORIZATIONS[1]: {
        if (dialect === 'minimax') {
          codes.set(MINIMAX_USER_CODE, { device: `dc_${++asked}`, challenge: form.get('code_challenge') ?? '' });
          const { status, body } = MINIMAX_CASES(region).start;
          return send(status, body);
        }
        const userCode = `FIXTURE-${String(10000 + ++asked).slice(-5)}`;
        codes.set(userCode, { device: `dc_${asked}` });
        return send(200, { device_code: codes.get(userCode)!.device, user_code: userCode, verification_uri: `${base()}/activate`, interval: 1, expires_in: CODE_LIVES_S });
      }
      case TOKENS[0]: case TOKENS[1]: {
        if (dialect === 'minimax') {
          const cases = MINIMAX_CASES(region);
          if (state.expire) return send(cases.expired.status, cases.expired.body);
          const c = codes.get(form.get('user_code') ?? '');
          // A code_verifier that does not hash to the code step's challenge is refused, as a wrong PKCE verifier is.
          if (form.get('grant_type') !== MINIMAX_GRANT_TYPE || !c || challengeOf(form.get('code_verifier') ?? '') !== c.challenge)
            return send(cases.error.status, cases.error.body);
          // A code the person refused on the page answers the provider's own error status, and keeps no token.
          if (c.denied) return send(cases.error.status, cases.error.body);
          if (c.approved) { codes.delete(form.get('user_code')!); return send(cases.success.status, cases.success.body); }
          return send(cases.pending.status, cases.pending.body);
        }
        if (form.get('grant_type') === 'refresh_token') {
          const grant = form.get('refresh_token') ?? '';
          if (!state.live.has(grant)) return send(400, { error: 'invalid_grant' });
          if (rotate) { state.live.delete(grant); return send(200, issue()); }
          accessOf.set(grant, `at_${accessOf.size + 1}`);
          return send(200, { access_token: accessOf.get(grant)!, expires_in: expiresIn, token_type: 'Bearer' });
        }
        const c = [...codes.values()].find((c) => c.device === form.get('device_code'));
        if (state.dropPolls > 0 && state.dropPolls--) return req.socket.destroy();
        if (!c) return send(400, { error: 'invalid_grant' });
        if (c.denied) return send(400, { error: 'access_denied' });
        // An approved code is spent once, as a real provider does.
        if (c.approved) { codes.delete([...codes.keys()].find((k) => codes.get(k) === c)!); return send(200, issue()); }
        return send(400, { error: 'authorization_pending' });
      }
      case COPILOT_DEVICE: {
        codes.set(COPILOT_CODE, { device: 'FIXTURE-COPILOT-DEVICE' });
        const { status, body } = COPILOT_CASES(domain).start;
        return send(status, body);
      }
      case COPILOT_ACCESS: {
        if (form.get('grant_type') === 'refresh_token') {
          const grant = form.get('refresh_token') ?? '';
          if (!state.live.has(grant)) return send(400, { error: 'invalid_grant' });
          const rotated = `gho_${++issued}`;
          state.live.add(rotated);
          return send(200, { access_token: rotated, token_type: 'bearer', scope: 'read:user' });
        }
        const c = [...codes.values()].find((c) => c.device === form.get('device_code'));
        if (!c) return send(400, { error: 'invalid_grant' });
        if (c.denied) { const { status, body } = COPILOT_CASES(domain).decline; return send(status, body); }
        // An approved code is spent once and lets its intermediate GitHub token through the exchange.
        if (c.approved) { codes.delete([...codes.keys()].find((k) => codes.get(k) === c)!); state.live.add('FIXTURE-GITHUB-TOKEN'); const { status, body } = COPILOT_CASES(domain).success; return send(status, body); }
        const { status, body } = COPILOT_CASES(domain).pending;
        return send(status, body);
      }
      case COPILOT_EXCHANGE: {
        const cases = COPILOT_CASES(domain);
        const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        // A revoked grant (or a token this stand-in never issued) is refused: signed out, not a retry.
        if (state.refuse || !state.live.has(bearer)) return send(state.refuse ? state.refuseStatus : 401, cases.unauthorized.body);
        return send(cases.exchange.status, cases.exchange.body);
      }
      default:
        return send(404, { error: 'not_found' });
    }
  });
  const base = () => `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${(server.address() as AddressInfo).port}`;
  await new Promise<void>((r) => server.listen(port, host, r));
  return {
    /** The `deviceBase` to hand `Accounts`: every provider's device sign-in lands here. */
    base: base(),
    state,
    /** With `dialect: 'minimax'`, the exact start/pending/success/error/expired answers this stand-in replays;
     *  with `dialect: 'copilot'`, its start/pending/success/decline/exchange/unauthorized answers. */
    answers: dialect === 'minimax' ? MINIMAX_CASES(region) : dialect === 'copilot' ? COPILOT_CASES(domain) : undefined,
    /** The provider's page where the person types the code; true once the code is a real one. */
    approve: (userCode: string, deny = false) => {
      const c = codes.get(userCode.trim().toUpperCase());
      if (c) Object.assign(c, deny ? { denied: true } : { approved: true });
      return !!c;
    },
    /** The code most recently handed out. */
    lastCode: () => [...codes.keys()].at(-1),
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const m = await mockDevice({ port: Number(process.argv[2] ?? 21555), host: '0.0.0.0', log: (line) => console.log(new Date().toISOString().slice(11, 19), line) });
  console.log(`stand-in device sign-in on ${m.base}; the code is approved at POST ${m.base}/activate with user_code`);
}
