// OpenAI's sign-in, stood in for: device code, its page where a person types the code, token exchange and refresh
// (rotating), revoke, ChatGPT's streamed answers (`/codex/responses`, echoing the question), and the same CORS answer the
// real sign-in endpoints give (the answers endpoint, like the real one, answers no web page), so a web page, a phone app or a test signs in
// end to end with no account and no real network. Run it alone for a demo or an emulator:
//   node packages/accounts/src/testing/mock-openai.ts [port]      (21455 by default, never ChatGPT's own 1455)
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

export type MockOpenAIOptions = { port?: number; host?: string; plan?: string; email?: string; expiresIn?: number; log?: (line: string) => void };

/** An access token as OpenAI shapes it: the account, the plan and the email in its claims. */
export const mockJwt = (plan = 'plus', email = 'sara@example.com', n = 0) => ['eyJhbGciOiJub25lIn0', Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: plan }, 'https://api.openai.com/profile': { email }, n,
  // As long as a real one, whose claims fill about 1.5 kB.
  scp: ['openid', 'profile', 'email', 'offline_access'], pad: 'x'.repeat(1200),
})).toString('base64url'), 'sig'].join('.');

export async function mockOpenAI({ port = 0, host = '127.0.0.1', plan = 'plus', email = 'sara@example.com', expiresIn = 864_000, log }: MockOpenAIOptions = {}) {
  const codes = new Map<string, { device: string; approved?: boolean; denied?: boolean }>();
  let issued = 0, asked = 0;
  const state = {
    /** Refresh tokens OpenAI still honours; a refresh spends the old one (rotation), sign-out revokes one. */
    live: new Set<string>(),
    requests: [] as { path: string; body: string }[],
    /** Refuse every refresh, as when the person signed out elsewhere. */
    refuse: false,
    /** Seconds each issued token lives. */
    expiresIn,
    /** Drop this many device-code polls on the floor, as a phone does to a backgrounded app. */
    dropPolls: 0,
    /** Answer the next question with this HTTP error instead (a limit, a lapsed sign-in), then answer normally. */
    fail: undefined as { status: number; body: string } | undefined,
  };
  const accessOf = new Map<string, string>(); // refresh token → the access token issued with it
  const issue = () => {
    const refresh = `rt_${++issued}`;
    state.live.add(refresh);
    accessOf.set(refresh, mockJwt(plan, email, issued));
    return { access_token: accessOf.get(refresh)!, refresh_token: refresh, expires_in: state.expiresIn, id_token: 'x' };
  };
  const approve = (userCode: string, deny = false) => {
    const c = codes.get(userCode.trim().toUpperCase());
    if (c) Object.assign(c, deny ? { denied: true } : { approved: true });
    return !!c;
  };
  const page = (words: string, form = true) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Stand-in OpenAI</title>
<body style="font:18px system-ui;max-width:28em;margin:3em auto;padding:0 1em"><h1>Stand-in OpenAI</h1><p id="words">${words}</p>${form ? `<form method="post">
<input name="user_code" id="code" autocomplete="off" placeholder="XXXX-XXXXX" style="font:inherit;padding:.4em"> <button id="continue" style="font:inherit;padding:.4em 1em">Continue</button></form>` : ''}</body>`;

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? '/', 'http://x');
    const form = new URLSearchParams(body);
    state.requests.push({ path: url.pathname, body });
    log?.(`${req.method} ${url.pathname} ${form.get('grant_type') ?? ''}`.trim());
    const send = (status: number, data: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, GET, OPTIONS' });
      res.end(typeof data === 'string' ? data : JSON.stringify(data));
    };
    const json = () => { try { return JSON.parse(body); } catch { return {}; } };
    if (req.method === 'OPTIONS') return send(200, '');
    switch (url.pathname) {
      case '/api/accounts/deviceauth/usercode': {
        const userCode = `MOCK-${String(10000 + ++asked).slice(-5)}`;
        codes.set(userCode, { device: `da_${asked}` });
        return send(200, { device_auth_id: codes.get(userCode)!.device, user_code: userCode, interval: '1' });
      }
      case '/api/accounts/deviceauth/token': {
        if (state.dropPolls > 0 && state.dropPolls--) return req.socket.destroy();
        const { device_auth_id, user_code } = json();
        const c = codes.get(user_code);
        if (!c || c.device !== device_auth_id) return send(400, { error: { code: 'deviceauth_invalid' } });
        if (c.denied) return send(400, { error: { code: 'access_denied', message: 'The user declined' } });
        return c.approved ? send(200, { authorization_code: `ac_${user_code}`, code_verifier: 'cv' }) : send(403, { error: { code: 'deviceauth_authorization_pending' } });
      }
      case '/oauth/token':
        if (form.get('grant_type') === 'authorization_code') {
          const c = codes.get(form.get('code')?.replace(/^ac_/, '') ?? '');
          if (!c?.approved) return send(401, { error: { code: 'token_expired' } });
          codes.delete(form.get('code')!.slice(3));
          return send(200, issue());
        }
        if (state.refuse || !state.live.delete(form.get('refresh_token') ?? '')) return send(401, { error: { code: 'refresh_token_reused', message: 'invalid_grant' } });
        return send(200, issue());
      case '/codex/responses': {
        const bearer = req.headers.authorization?.replace(/^Bearer /, '');
        if (state.fail) { const f = state.fail; state.fail = undefined; return send(f.status, f.body); }
        if (![...state.live].some((r) => accessOf.get(r) === bearer) || req.headers['chatgpt-account-id'] !== 'acct-1')
          return send(401, { error: { message: 'Provided authentication token is expired. Please try signing in again.' } });
        const text = `You said: ${json().input?.[0]?.content?.[0]?.text ?? ''}`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const delta of text.match(/[\s\S]{1,4}/g) ?? []) {
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`);
          await new Promise((r) => setTimeout(r, 5));
        }
        return res.end('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n');
      }
      case '/oauth/revoke':
        state.live.delete(json().token);
        return send(200, {});
      case '/codex/device':
        if (req.method !== 'POST') return send(200, page('Type the code the app shows you.'), 'text/html; charset=utf-8');
        return send(200, approve(form.get('user_code') ?? '') ? page('Signed in. Go back to the app.', false) : page("That code doesn't match. Try again."), 'text/html; charset=utf-8');
      default:
        return send(404, { error: 'not found' });
    }
  });
  await new Promise<void>((r) => server.listen(port, host, r));
  const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${(server.address() as AddressInfo).port}`;
  return {
    base, state, approve,
    /** The code most recently handed out. */
    lastCode: () => [...codes.keys()].at(-1),
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const m = await mockOpenAI({ port: Number(process.argv[2] ?? 21455), host: '0.0.0.0', log: (line) => console.log(new Date().toISOString().slice(11, 19), line) });
  console.log(`stand-in OpenAI on ${m.base}; approve codes at ${m.base}/codex/device`);
}
