// The scripted OpenAI-compatible model the contract and engine tests run against (5.11): ported from Crewhouse's
// test/openclaw-stub.ts with its script grammar unchanged. One loopback HTTP server; sessions, tools, the gate and
// the run events stay the engine's own code path. No network, no account, no quota, no sign-ins anywhere.
// Script (read from the latest user message):
//   [tool NAME {json}]   call that tool once, then reply with what it returned; several are called in turn, the reply
//                        saying what the last one returned (the json may nest: braces are matched, not guessed)
//   hit the limit        answer with the account's own usage-limit error (rests it)
//   no helpers in plan   answer as a plan without helpers does
//   sign me out          answer as an account whose sign-in stopped working does
//   ask permission       hold the turn (after its tool calls) until `releaseStub` lets it finish
//   [route ID]           asked who should take a request: ID, fairly sure; [route ?]: torn evenly; neither: Chief, sure
//   anything else        reply `stub <bot>: done with "<the last line of the message>"`
// The bot id (`idPattern`, default /Your id is ([a-z0-9-]+)\./) is read from the system prompt, and routing
// requests start with `routingMarker` (default '[routing]'); pass both explicitly to mirror another app's grammar.
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { OpenClawKit } from '../kit.ts';

export type StubCall = { authorization: string; path: string; body: any };

export type ModelStub = { port: number; url: string; calls: StubCall[]; close(): Promise<void> };

/** The tool calls in the script, each with its arguments. Braces are balanced, so a script may nest. */
export function toolCalls(text: string): { name: string; input: Record<string, unknown> }[] {
  const out: { name: string; input: Record<string, unknown> }[] = [];
  for (const m of text.matchAll(/\[tool (\w+) \{/g)) {
    const from = m.index! + m[0].length - 1;
    let depth = 0, i = from, quote = false, esc = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { quote = !quote; continue; }
      if (quote) continue;
      if (c === '{') depth++;
      else if (c === '}' && !--depth) break;
    }
    out.push({ name: m[1], input: JSON.parse(text.slice(from, i + 1)) });
  }
  return out;
}

// A turn whose message says `ask permission` holds until released; the key is the request's Authorization header.
const holds = new Map<string, (reply: string) => void>();
export const releaseStub = (key?: string, reply = '') => {
  for (const [k, release] of holds) if (!key || k === key) { release(reply); holds.delete(k); }
};
export const stubHolding = (key?: string) => (key ? holds.has(key) : holds.size > 0);

const words = (m: any) =>
  typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((c: any) => c.text ?? '').join('') : '';

/**
 * One loopback HTTP server that speaks the script. `script` queues plain replies consumed one per completion
 * request before the message-embedded grammar applies.
 */
export type ModelStubOptions = { idPattern?: RegExp; routingMarker?: string };

export function startModelStub(script: string[] = [], o: ModelStubOptions = {}): Promise<ModelStub> {
  const calls: StubCall[] = [];
  const queue = [...script];
  const idPattern = o.idPattern ?? /Your id is ([a-z0-9-]+)\./;
  const routingMarker = o.routingMarker ?? '[routing]';
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    let body: any;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400).end(); return; }
    calls.push({ authorization: String(req.headers.authorization ?? ''), path: req.url ?? '', body });
    if (req.url === '/api/embed' || req.url === '/api/embeddings') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        embeddings: (Array.isArray(body.input) ? body.input : [body.input]).map(() => [0.1, 0.2, 0.3]),
      }));
    }
    const messages: any[] = body.messages ?? [];
    const system = messages.filter((m: any) => m.role === 'system').map((m: any) => words(m)).join('\n');
    const bot = idPattern.exec(system)?.[1] ?? 'bot';
    // The engine appends runtime-context user messages after the person's own (O11): the script lives in the
    // last user message that carries a script marker, falling back to the last user message for plain replies.
    // Tool results count from that same message, or the first scripted call replays forever: each follow-up
    // request carries a fresh trailing runtime-context user message with zero tool results after it.
    const users = messages.filter((m: any) => m.role === 'user');
    const structural = (text: string) => /\[tool \w+ \{|\[route [\w?-]+\]/.test(text) || text.startsWith(routingMarker);
    const phrased = (text: string) => /hit the limit|no helpers in plan|sign me out|ask permission/i.test(text);
    const lastUser = [...users].reverse().find((m: any) => structural(words(m)))
      ?? [...users].reverse().find((m: any) => phrased(words(m)))
      ?? users.at(-1);
    const said = words(lastUser);
    const anchor = messages.lastIndexOf(lastUser);
    const results = anchor < 0 ? [] : messages.slice(anchor + 1).filter((m: any) => m.role === 'tool');
    const scripted = toolCalls(said);
    const lastResult = results.at(-1);
    const done = () => {
      if (results.length && lastResult) return `stub ${bot}: ${lastResult.name ?? 'tool'} said ${words(lastResult).slice(0, 300)}`;
      const asked = said.split('\n').map((l: string) => l.trim()).filter((l: string) => l && !l.startsWith(routingMarker) && !/^\[route /.test(l)).pop() ?? '';
      return `stub ${bot}: done with "${asked.slice(0, 60)}"`;
    };
    // Routing asks who takes a request; the script answers in the kit's own shape.
    if (said.startsWith(routingMarker)) {
      const options = [...said.matchAll(/^- ([a-z0-9-]+):/gm)].map((m) => m[1]);
      const pick = /\[route ([a-z0-9-]+|\?)\]/.exec(said)?.[1] ?? 'chief';
      return plain(res, body, JSON.stringify(Object.fromEntries(options.map((o) => [o, pick === '?' ? 1 / options.length : o === pick ? 0.9 : 0.1 / (options.length - 1)]))));
    }
    if (/sign me out/i.test(said)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: '401 Unauthorized: your sign-in has expired' } }));
    }
    if (/hit the limit/i.test(said)) {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'You have hit your ChatGPT usage limit (plus plan). Try again in ~30 min.' } }));
    }
    if (/no helpers in plan/i.test(said)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: "Your plan doesn't include this model." } }));
    }
    const next = scripted[results.length];
    const id = randomUUID();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (delta: object, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (next) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.input) } }] });
      send({}, 'tool_calls');
      return void res.end('data: [DONE]\n\n');
    }
    let text = queue.length ? queue.shift()! : done();
    if (/ask permission/i.test(said)) {
      const key = String(req.headers.authorization ?? 'hold');
      text = await new Promise<string>((resolve) => {
        holds.set(key, (reply) => resolve(reply || text));
        res.once('close', () => holds.delete(key));
      });
    }
    send({ role: 'assistant', content: text });
    send({}, 'stop');
    res.end('data: [DONE]\n\n');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address !== 'string' ? address.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/v1`,
        calls,
        close: () => new Promise<void>((yes) => server.close(() => yes())),
      });
    });
  });
}

const plain = (res: import('node:http').ServerResponse, body: any, text: string) => {
  const id = randomUUID();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (delta: object, finish: string | null = null) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  chunk({ role: 'assistant', content: text });
  chunk({}, 'stop');
  res.end('data: [DONE]\n\n');
};

// provider id 'byokit-stub', model 'test': the stub becomes every agent's primary model.
export async function useModelStub(kit: OpenClawKit, stub: ModelStub): Promise<void> {
  // The generated method table arrives with O2; until then kit.call's typed surface accepts no method names, so
  // configure through this string-typed view of the same runtime path.
  const call = (kit as unknown as { call(m: string, p?: unknown): Promise<any> }).call.bind(kit);
  const current = await call('config.get');
  await call('config.patch', { baseHash: current.hash, raw: JSON.stringify({
    models: { providers: { 'byokit-stub': {
      baseUrl: stub.url, apiKey: 'byokit-stub', api: 'openai-completions',
      models: [{ id: 'test', name: 'Test', reasoning: true, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048,
        compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ['off', 'low', 'medium', 'high'] } }],
    } } },
    agents: { defaults: { model: { primary: 'byokit-stub/test' } } },
  }) });
}
