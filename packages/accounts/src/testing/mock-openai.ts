// OpenAI's sign-in, stood in for: device code, its page where a person types the code, token exchange and refresh
// (rotating), revoke, ChatGPT's streamed answers (`/codex/responses`, echoing the question), and the same CORS answer the
// real sign-in endpoints give (the answers endpoint, like the real one, answers no web page), so a web page, a phone app or a test signs in
// end to end with no account and no real network. Run it alone for a demo or an emulator:
//   node packages/accounts/src/testing/mock-openai.ts [port]      (21455 by default, never ChatGPT's own 1455)
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { ResponseUsage } from '../responses.ts';

/** First matching script wins. Strings match a substring; regexes and predicates inspect the joined input text.
 * Unmatched prompts retain the echo/tool behavior. Counts are supplied explicitly, never estimated. */
export type MockOpenAIAnswer = { match: string | RegExp | ((prompt: string) => boolean); text: string; usage?: ResponseUsage };
export type MockOpenAIOptions = { port?: number; host?: string; plan?: string; email?: string; expiresIn?: number;
  answers?: readonly MockOpenAIAnswer[]; log?: (line: string) => void };

/** An access token as OpenAI shapes it: the account, the plan and the email in its claims. */
export const mockJwt = (plan = 'plus', email = 'sara@example.com', n = 0, accountId = 'acct-1') => ['eyJhbGciOiJub25lIn0', Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: plan }, 'https://api.openai.com/profile': { email }, n,
  // As long as a real one, whose claims fill about 1.5 kB.
  scp: ['openid', 'profile', 'email', 'offline_access'], pad: 'x'.repeat(1200),
})).toString('base64url'), 'sig'].join('.');

export async function mockOpenAI({ port = 0, host = '127.0.0.1', plan = 'plus', email = 'sara@example.com', expiresIn = 864_000, answers = [], log }: MockOpenAIOptions = {}) {
  const codes = new Map<string, { device: string; approved?: boolean; denied?: boolean }>();
  let issued = 0, asked = 0;
  const state = {
    /** Refresh tokens OpenAI still honours; a refresh spends the old one (rotation), sign-out revokes one. */
    live: new Set<string>(),
    requests: [] as { path: string; body: string }[],
    /** Scripts may be replaced between requests, without restarting the sign-in stand-in. */
    answers: [...answers],
    /** Refuse every refresh, as when the person signed out elsewhere. */
    refuse: false,
    /** Seconds each issued token lives. */
    expiresIn,
    accountId: 'acct-1', email, plan,
    /** Drop this many device-code polls on the floor, as a phone does to a backgrounded app. */
    dropPolls: 0,
    /** Answer the next question with this HTTP error instead (a limit, a lapsed sign-in), then answer normally. */
    fail: undefined as { status: number; body: string } | undefined,
  };
  const accessOf = new Map<string, string>(); // refresh token → the access token issued with it
  const issue = (identity = { accountId: state.accountId, email: state.email, plan: state.plan }) => {
    const refresh = `rt_${++issued}`;
    state.live.add(refresh);
    accessOf.set(refresh, mockJwt(identity.plan, identity.email, issued, identity.accountId));
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
        {
          const access = accessOf.get(form.get('refresh_token')!)!;
          const claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString());
          return send(200, issue({ accountId: claims['https://api.openai.com/auth'].chatgpt_account_id, plan: claims['https://api.openai.com/auth'].chatgpt_plan_type, email: claims['https://api.openai.com/profile'].email }));
        }
      case '/codex/responses': {
        const bearer = req.headers.authorization?.replace(/^Bearer /, '');
        if (state.fail) { const f = state.fail; state.fail = undefined; return send(f.status, f.body); }
        if (![...state.live].some((r) => accessOf.get(r) === bearer) || req.headers['chatgpt-account-id'] !== (bearer && JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString())['https://api.openai.com/auth'].chatgpt_account_id))
          return send(401, { error: { message: 'Provided authentication token is expired. Please try signing in again.' } });
        const asked = json();
        const turns = Array.isArray(asked.input) ? asked.input : [];
        const said: string[] = [];
        let answered: string | undefined;
        for (const item of turns) {
          if (item?.type === 'function_call_output') { answered ??= String(item.output ?? ''); continue; }
          const content = typeof item?.content === 'string' ? [{ type: 'input_text', text: item.content }] : Array.isArray(item?.content) ? item.content : [];
          for (const part of content) if (part?.type === 'input_text' && typeof part.text === 'string') said.push(part.text);
        }
        const words = said.join(' ');
        let scripted: MockOpenAIAnswer | undefined;
        try {
          scripted = state.answers.find(({ match }) => typeof match === 'string' ? words.includes(match)
            : typeof match === 'function' ? match(words) : new RegExp(match.source, match.flags).test(words));
        } catch { return send(500, { error: { message: 'The stand-in could not match this prompt.' } }); }
        const schema = (asked.text as any)?.format?.type === 'json_schema';
        const text = scripted ? scripted.text : answered !== undefined ? `You did: ${answered}`
          : schema ? JSON.stringify({ echo: words ? `You said: ${words}` : 'You said nothing' })
          : `You said: ${words}`;
        const called = Array.isArray(asked.tools) ? asked.tools.filter((t: any) => t?.type === 'function') : [];
        if (!scripted && called.length > 0 && answered === undefined) {
          // A tool turn: the model calls the first function tool, streamed as argument deltas and one finished item,
          // then the completion with the output list. The app answers with a `function_call_output` turn next.
          const name = String(called[0].name ?? 'tool');
          const args = JSON.stringify({ input: words });
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name, arguments: '' } })}\n\n`);
          for (const delta of args.match(/[\s\S]{1,4}/g) ?? []) {
            res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'call_1', delta })}\n\n`);
            await new Promise((r) => setTimeout(r, 5));
          }
          const item = { type: 'function_call', call_id: 'call_1', name, arguments: args };
          res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`);
          return res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [item] } })}\n\ndata: [DONE]\n\n`);
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const delta of text.match(/[\s\S]{1,4}/g) ?? []) {
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`);
          await new Promise((r) => setTimeout(r, 5));
        }
        return res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: {
          status: 'completed', ...(scripted?.usage && { usage: scripted.usage }),
        } })}\n\ndata: [DONE]\n\n`);
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
