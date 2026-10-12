// Claude's plan sign-in, stood in for: the authorize page the app opens (it shows the exact code to paste back),
// the token exchange and refresh, the plan profile, and the recorded Messages stream. Used by e2e-android.sh:
//   node e2e-claude-standin.mts [port]      (21458 by default)
// Loopback only: the emulator reaches it at http://10.0.2.2:<port>, a shell at http://127.0.0.1:<port>. Every answer
// replays fixtures/conformance/claude-plan-typescript.json (exchange, rotation, invalid-grant refusal) and
// fixtures/conformance/claude-messages-typescript.json (the first recorded stream); no account and no real network.
// The phone app reaches the authorize/token/profile endpoints through EXPO_PUBLIC_CLAUDE_BASE. Its Claude answers
// still go to the real Messages endpoint (Accounts has no Messages-base override), so the e2e signs Claude in,
// checks the Claude Max badge across a restart and signs out, but never asks; the replayed stream is proven with
// curl below instead:
//   curl -s -X POST --data '{}' http://127.0.0.1:21458/v1/messages | head -c 200
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const port = Number(process.argv[2] ?? 21458);
const plan = JSON.parse(readFileSync(new URL('../../fixtures/conformance/claude-plan-typescript.json', import.meta.url), 'utf8')) as {
  exchange: Record<string, unknown>; rotation: Record<string, unknown>; invalidGrant: Record<string, unknown> };
const stream = (JSON.parse(readFileSync(new URL('../../fixtures/conformance/claude-messages-typescript.json', import.meta.url), 'utf8')) as {
  cases: { stream: string; text: string }[] }).cases[0].stream;

let lastState = '';
const requests: string[] = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url ?? '/', 'http://x');
  requests.push(`${req.method} ${url.pathname}`);
  console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${url.pathname}`);
  const json = (status: number, data: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(data));
  };
  if (url.pathname === '/oauth/authorize') {
    // The app hands this URL to the system browser; the browser's visit tells the stand-in the sign-in's state,
    // which GET /state then hands to the e2e shell so it can paste `recorded-code#<state>` back into the app.
    lastState = url.searchParams.get('state') ?? '';
    const paste = `recorded-code#${lastState}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Stand-in Claude</title>
<body style="font:18px system-ui;max-width:28em;margin:3em auto;padding:0 1em"><h1>Stand-in Claude</h1>
<p>In the app, paste this code, then tap Connect:</p><p id="paste" style="font-size:24px;font-weight:700">${paste}</p></body>`);
  }
  if (url.pathname === '/state') return json(200, { state: lastState });
  if (url.pathname === '/v1/oauth/token') {
    let j: any = {};
    try { j = JSON.parse(body); } catch {}
    if (j?.grant_type === 'refresh_token')
      return j?.refresh_token === plan.exchange.refresh_token ? json(200, plan.rotation) : json(400, plan.invalidGrant);
    return json(200, plan.exchange);
  }
  if (url.pathname === '/api/oauth/profile')
    return json(200, { account: { email: 'umer@example.com' }, organization: { organization_type: 'claude_max' } });
  if (url.pathname === '/v1/messages') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
    return res.end(stream);
  }
  if (url.pathname === '/requests') return json(200, requests);
  return json(404, { error: 'not_found' });
});
server.listen(port, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`stand-in Claude on ${base}; paste recorded-code#<state> after opening ${base}/oauth/authorize?state=<state>`);
});
