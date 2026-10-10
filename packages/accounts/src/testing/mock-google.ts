// Google Cloud Code Assist sign-in, stood in for: PKCE authorize, the loopback callback, code exchange and refresh,
// userinfo, sign-out revoke, and the Code Assist project calls, all answered on 127.0.0.1 so a test drives the whole
// journey with no account and no real network. Two clients share the protocol and differ in the facts the kit reuses
// (callback port and path, scopes, Code Assist base and metadata): google-gemini-cli on :8085 and google-antigravity
// on :51121. Point the kit's Google flow at `base`, or run it alone:
//   node packages/accounts/src/testing/mock-google.ts [client] [port]
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

export type MockGoogleClient = 'google-gemini-cli' | 'google-antigravity';

/** The client facts the sign-in reuses, matching fixtures/conformance/google-oauth-typescript.json. */
export type MockGoogleProtocol = {
  authorize: string;
  authorizeParams: Record<string, string>;
  scopes: string[];
  callback: { hostname: string; port: number; path: string };
  codeAssist: string;
  metadata: Record<string, string>;
};

const PROTOCOLS: Record<MockGoogleClient, MockGoogleProtocol> = {
  'google-gemini-cli': {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
    callback: { hostname: '127.0.0.1', port: 8085, path: '/oauth2callback' },
    codeAssist: 'https://cloudcode-pa.googleapis.com',
    metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
  },
  'google-antigravity': {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile', 'https://www.googleapis.com/auth/cclog', 'https://www.googleapis.com/auth/experimentsandconfigs'],
    callback: { hostname: '127.0.0.1', port: 51121, path: '/oauth-callback' },
    codeAssist: 'https://daily-cloudcode-pa.googleapis.com',
    metadata: { ideType: 'ANTIGRAVITY' },
  },
};

const EXCHANGE = { access_token: 'recorded-access', refresh_token: 'recorded-refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/cloud-platform', token_type: 'Bearer' };
const ROTATION = { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 7200, token_type: 'Bearer' };
const INVALID_GRANT = { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' };
const USERINFO = { email: 'umer@example.com', verified_email: true };
const ELIGIBLE = { cloudaicompanionProject: 'recorded-project', currentTier: { id: 'standard-tier' } };
const PROVISION = {
  loadCodeAssist: { allowedTiers: [{ id: 'free-tier', isDefault: true }] },
  onboardUser: { name: 'operations/recorded-onboard', done: false },
  operation: { name: 'operations/recorded-onboard', done: true, response: { cloudaicompanionProject: { id: 'recorded-project' } } },
};
const INELIGIBLE = { ineligibleTiers: [{ tierId: 'free-tier', reasonMessage: 'This account is not eligible for Code Assist.', validationUrl: 'https://accounts.google.com/signin' }] };
const CODE_ASSIST_STREAM = [
  { response: { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello' }] } }] } },
  { response: { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: ' world' }] } }] } },
  { response: { candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } } },
];
const TIER_REFUSAL = { error: { code: 403, message: 'The caller does not have permission.' } };
const UNAUTHORIZED = { error: { code: 401, message: 'Request had invalid authentication credentials.' } };

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const challengeOf = (verifier: string) => base64url(createHash('sha256').update(verifier).digest());

export type MockGoogleOptions = { client?: MockGoogleClient; port?: number; host?: string; log?: (line: string) => void };

export async function mockGoogle({ client = 'google-gemini-cli', port = 0, host = '127.0.0.1', log }: MockGoogleOptions = {}) {
  const challenges = new Map<string, string>();
  let codes = 0;
  const state = {
    /** Refresh tokens the provider still honours; the first refresh spends the exchange grant. */
    live: new Set<string>(),
    requests: [] as { method: string; path: string; query: string; body: string }[],
    /** Refresh tokens the provider has revoked; the next refresh with one answers invalid_grant. */
    revoked: [] as string[],
    /** Answer `/revoke` with invalid_grant instead of 200. */
    refuseRevoke: false,
    /** The authorize query parameters most recently seen, and the callback the person's return landed on. */
    authorize: undefined as Record<string, string> | undefined,
    callback: undefined as Record<string, string> | undefined,
    /** Refuse every refresh with invalid_grant, as after the person signed out elsewhere. */
    refuse: false,
    /** Answer loadCodeAssist with an individual account that has no Code Assist tier. */
    ineligible: false,
    /** Answer loadCodeAssist with no project, so onboardUser provisions one. */
    provision: false,
    /** Answer the next streamGenerateContent calls with 401 (a count), to drive the refresh-once path. */
    unauthorized: 0,
    /** Answer streamGenerateContent with a 403 tier refusal. */
    tierRefusal: false,
    /** Wait this long between streamed frames, to prove each delta lands before the answer ends. */
    frameDelayMs: 0,
  };

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? '/', 'http://x');
    state.requests.push({ method: req.method ?? 'GET', path: url.pathname, query: url.search, body });
    log?.(`${req.method} ${url.pathname}`.trim());
    const form = new URLSearchParams(body);
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...headers });
      res.end(JSON.stringify(data));
    };
    switch (url.pathname) {
      case '/o/oauth2/v2/auth': {
        const params = Object.fromEntries(url.searchParams);
        state.authorize = params;
        if (params.response_type !== 'code' || params.code_challenge_method !== 'S256' || !params.code_challenge || !params.redirect_uri || params.client_id === undefined)
          return send(400, { error: 'invalid_request' });
        const code = `gc_${++codes}`;
        challenges.set(code, params.code_challenge);
        const redirect = new URL(params.redirect_uri);
        redirect.searchParams.set('code', code);
        if (params.state !== undefined) redirect.searchParams.set('state', params.state);
        res.writeHead(303, { location: redirect.toString() });
        return res.end();
      }
      case '/oauth2callback':
      case '/oauth-callback':
        state.callback = Object.fromEntries(url.searchParams);
        return send(200, { ok: true });
      case '/token': {
        if (form.get('grant_type') === 'refresh_token') {
          const grant = form.get('refresh_token') ?? '';
          if (state.refuse || !state.live.delete(grant)) return send(400, INVALID_GRANT);
          state.live.add(ROTATION.refresh_token);
          return send(200, ROTATION);
        }
        const code = form.get('code') ?? '';
        const challenge = challenges.get(code);
        if (!challenge || challengeOf(form.get('code_verifier') ?? '') !== challenge) return send(400, INVALID_GRANT);
        challenges.delete(code);
        state.live.add(EXCHANGE.refresh_token);
        return send(200, EXCHANGE);
      }
      case '/oauth2/v1/userinfo':
        return send(200, USERINFO);
      case '/revoke': {
        const token = form.get('token') ?? '';
        if (state.refuseRevoke) return send(400, INVALID_GRANT);
        state.revoked.push(token);
        state.live.delete(token);
        return send(200, {});
      }
      case '/v1internal:loadCodeAssist':
        return send(200, state.ineligible ? INELIGIBLE : state.provision ? PROVISION.loadCodeAssist : ELIGIBLE);
      case '/v1internal:onboardUser':
        return send(200, PROVISION.onboardUser);
      case '/v1internal:streamGenerateContent': {
        if (state.unauthorized > 0) { state.unauthorized--; return send(401, UNAUTHORIZED); }
        if (state.tierRefusal) return send(403, TIER_REFUSAL);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
        for (const frame of CODE_ASSIST_STREAM) {
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
          if (state.frameDelayMs) await new Promise((r) => setTimeout(r, state.frameDelayMs));
        }
        return res.end();
      }
      default:
        if (url.pathname.startsWith('/v1internal/')) return send(200, PROVISION.operation);
        return send(404, { error: 'not_found' });
    }
  });
  await new Promise<void>((r) => server.listen(port, host, r));
  const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${(server.address() as AddressInfo).port}`;
  return {
    client, base, state,
    protocol: PROTOCOLS[client],
    answers: { exchange: EXCHANGE, rotation: ROTATION, invalidGrant: INVALID_GRANT, userinfo: USERINFO, eligible: ELIGIBLE, provision: PROVISION, ineligible: INELIGIBLE,
      codeAssistStream: CODE_ASSIST_STREAM, tierRefusal: TIER_REFUSAL, unauthorized: UNAUTHORIZED },
    /** The provider page to open, with the client's recorded authorize parameters and the caller's PKCE values. */
    authorizeUrl: ({ redirectUri, state: authState, codeChallenge }: { redirectUri: string; state?: string; codeChallenge: string }) => {
      const u = new URL(`${base}/o/oauth2/v2/auth`);
      u.search = new URLSearchParams({ response_type: 'code', client_id: 'byokit-test-client', redirect_uri: redirectUri,
        scope: PROTOCOLS[client].scopes.join(' '), state: authState ?? 'state', code_challenge: codeChallenge, code_challenge_method: 'S256', ...PROTOCOLS[client].authorizeParams }).toString();
      return u.toString();
    },
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const client = (process.argv[2] ?? 'google-gemini-cli') as MockGoogleClient;
  const m = await mockGoogle({ client, port: Number(process.argv[3] ?? PROTOCOLS[client].callback.port), host: '0.0.0.0', log: (line) => console.log(new Date().toISOString().slice(11, 19), line) });
  console.log(`stand-in ${client} sign-in on ${m.base}`);
}
