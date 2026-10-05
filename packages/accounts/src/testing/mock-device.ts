// One provider's RFC 8628 device sign-in, stood in for: the code the person types, the page that approves it, polling
// until the provider says yes, and refresh (with and without rotation). The same answers and the same CORS answer any
// provider's own page gets, so a phone, a web page or a test signs in end to end with no account and no real network.
// Point a provider's catalogue `device` data at this with `deviceBase` (`Accounts`' `deviceBase` option):
//   node packages/accounts/src/testing/mock-device.ts [port]      (21555 by default)
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

/** `expiresIn` is how long each token lives; a device code always has the 15 minutes RFC 8628's own clients use. */
export type MockDeviceOptions = { port?: number; host?: string; expiresIn?: number; log?: (line: string) => void };
const CODE_LIVES_S = 900;

/** Each provider's own documented device endpoints, answered under whatever base the kit is given. */
const AUTHORIZATIONS = ['/oauth2/device/code', '/api/oauth/device_authorization'];
const TOKENS = ['/oauth2/token', '/api/oauth/token'];

export async function mockDevice({ port = 0, host = '127.0.0.1', expiresIn = 3600, log }: MockDeviceOptions = {}) {
  const codes = new Map<string, { device: string; approved?: boolean; denied?: boolean }>();
  let asked = 0, issued = 0;
  const state = { live: new Set<string>(), requests: [] as { path: string; body: string }[], /** Drop this many polls, as a phone cuts a backgrounded app's network. */ dropPolls: 0 };
  const accessOf = new Map<string, string>(); // refresh token → the access token issued with it
  // Every token response rotates the refresh token, as Pi's own store requires: the grant it replaces is spent.
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
        const userCode = `FIXTURE-${String(10000 + ++asked).slice(-5)}`;
        codes.set(userCode, { device: `dc_${asked}` });
        return send(200, { device_code: codes.get(userCode)!.device, user_code: userCode, verification_uri: `${base()}/activate`, interval: 1, expires_in: CODE_LIVES_S });
      }
      case TOKENS[0]: case TOKENS[1]: {
        if (form.get('grant_type') === 'refresh_token') {
          if (!state.live.delete(form.get('refresh_token') ?? '')) return send(400, { error: 'invalid_grant' });
          return send(200, issue());
        }
        const c = [...codes.values()].find((c) => c.device === form.get('device_code'));
        if (state.dropPolls > 0 && state.dropPolls--) return req.socket.destroy();
        if (!c) return send(400, { error: 'invalid_grant' });
        if (c.denied) return send(400, { error: 'access_denied' });
        // An approved code is spent once, as a real provider does.
        if (c.approved) { codes.delete([...codes.keys()].find((k) => codes.get(k) === c)!); return send(200, issue()); }
        return send(400, { error: 'authorization_pending' });
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
