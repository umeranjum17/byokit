# Accounts key-route refusals

A key-route ask that the provider refuses reads as its own typed `KeyRouteError`, so an app can say what is wrong instead of "Try again". Every failed ask also says why: `status` and `detail` ride along under the same calm `message`.

## Sub-features

- `refusal-credit`: a `402` (OpenRouter's "requires more credits" body, or an empty body) rejects with `out_of_credit` and the words "This account is out of credit. Add credit with the provider, then try again."
- `refusal-key`: a `401` (or `403` that is not the OpenCode workspace refusal) rejects with `key_refused`.
- `refusal-rate`: a `429` rejects with `rate_limited`, never retried.
- `refusal-unknown`: any other failure (a `500`, a dropped connection, even right after a `402`) stays `request`.
- `refusal-detail`: each failure carries `status` (the HTTP status answered, absent when none came back) and `detail` (the provider's own message, or the network error), one line of at most 300 characters with the account's key replaced by `[redacted]`: a `500` `{"error":{"message":"model not enabled for umer-test <key>"}}` gives `detail` `model not enabled for umer-test [redacted]`; a 5 MB HTML body gives at most 300 characters; a closed loopback port gives `fetch failed: connect ECONNREFUSED …` and no `status`.

The status is read from the kit's own `fetch` that the request goes out through; Pi's error event only carries it inside its message. Adapters that take no `fetch` (Google AI Studio, Vertex, Bedrock) stay `request`.

## How to get to it (user POV)

Connect an OpenRouter key with no credit and ask a question. The app used to show the generic "This account could not answer. Try again." (Crewhouse showed "Check your internet connection"); now it gets `out_of_credit` and the kit's words.

## Driving it with a node scratch consumer

Preconditions: baseline (features/README.md), including a completed `npm run build`.

Write `"$scratch_dir/verify-key-refusals.mjs"`:

```js
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Accounts, recordStore } from '@byokit/accounts';

const key = 'sk-umer-test-SECRET';
const credits = JSON.stringify({ error: { code: 402, message: 'This request requires more credits, or fewer max_tokens.' } });
const answers = [[402, credits], [401, '{"error":{"code":401,"message":"User not found."}}'], [429, '{"error":{"code":429}}'], [402, ''], 'drop', [500, '{}'],
  [500, JSON.stringify({ error: { message: `model not enabled for umer-test ${key}` } })], [500, `<html>${'x'.repeat(5_000_000)}</html>`]];
const server = createServer((req, res) => {
  const a = answers.shift();
  console.log(`fake: ${req.method} ${req.url} -> ${a === 'drop' ? 'dropped' : a[0]}`);
  if (a === 'drop') return req.socket.destroy();
  res.writeHead(a[0], { 'content-type': a[1].startsWith('<') ? 'text/html' : 'application/json' }).end(a[1]);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const closed = createServer().listen(0, '127.0.0.1'); await once(closed, 'listening');
const closedPort = closed.address().port; closed.close();
let data = {}; const secrets = new Map();
const kit = new Accounts({ store: () => recordStore(async () => data, async (next) => { data = next; }),
  keyStore: () => ({ get: async (k) => secrets.get(k) ?? null, set: async (k, v) => { secrets.set(k, v); }, delete: async (k) => secrets.delete(k) }) });
const { id } = await kit.add('Umer', 'openrouter:key', { key });
const model = (port) => ({ id: 'fixture-model', name: 'Fixture', provider: 'openrouter', api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/api/v1`,
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 128 });
const got = []; const errors = [];
for (const label of ['402 credits body', '401', '429', '402 empty body', 'dropped after 402', '500', '500 echoes key', '500 5 MB html', 'closed port']) {
  try { await kit.respond('Umer', { account: id, model: model(label === 'closed port' ? closedPort : server.address().port), context: { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] } }); got.push('answered'); console.log(`${label}: answered (unexpected)`); }
  catch (e) { got.push(e.code); errors.push(e); console.log(`${label}: ${e.name} ${e.code} — ${e.message} | status ${e.status} | detail (${e.detail?.length ?? 0} chars) ${JSON.stringify(e.detail?.slice(0, 80))}`); }
}
server.close();
const want = ['out_of_credit', 'key_refused', 'rate_limited', 'out_of_credit', 'request', 'request', 'request', 'request', 'request'];
const [echoed, huge, offline] = errors.slice(-3);
const checks = { codes: JSON.stringify(got) === JSON.stringify(want), echoed: echoed.status === 500 && echoed.detail === 'model not enabled for umer-test [redacted]',
  huge: huge.status === 500 && huge.detail.length <= 300, offline: offline.status === undefined && /ECONNREFUSED|connect/.test(offline.detail),
  noKey: errors.every((e) => !JSON.stringify({ ...e, message: e.message }).includes(key)) };
if (!Object.values(checks).every(Boolean)) { console.log('FAIL', JSON.stringify(checks), 'got', got.join(',')); process.exit(1); }
console.log('PASS', got.join(','), JSON.stringify(checks));
```

```bash
feature=accounts-key-refusals
entry="$scratch_dir/verify-key-refusals.mjs"
drive=(node "$scratch_dir/verify-key-refusals.mjs")
```

Run the SKILL.md Evidence block. The `dropped after 402` leg follows a served `402` on the same kit (the fake serves answers in order, one per ask), so it proves no earlier status leaks into a later ask.

- **Happy path shows.** One `fake:` line per ask (no repeats: never retried), then `402 credits body: KeyRouteError out_of_credit — This account is out of credit. Add credit with the provider, then try again.`, `401: … key_refused — …`, `429: … rate_limited — …`, `402 empty body: … out_of_credit — …`, and `PASS`.
- **Missing and error cases show.** `dropped after 402: KeyRouteError request — This account could not answer. Try again.` and `500: KeyRouteError request — …`.
- **Detail shows.** `500 echoes key: … request — This account could not answer. Try again. | status 500 | detail (42 chars) "model not enabled for umer-test [redacted]"`, `500 5 MB html: … | status 500 | detail (300 chars) "<html>xxx…"`, `closed port: … | status undefined | detail (…) "fetch failed: connect ECONNREFUSED 127.0.0.1:…"`, and the key never in any error.

Regression: against a build without the mapping every leg reads `request` and the drive exits 1; against a build without `detail` the `echoed`, `huge` and `offline` checks fail.

## Gotchas

- Loopback only (`127.0.0.1`, ephemeral port); the key is a fixture string, never a real credential. No paid call.
- The integration tests `packages/accounts/test/key-routes.test.ts` ("a provider refusal reads as its own typed error", "a failed ask says why") run the same sequences on the source.
- The closed port is a loopback listener opened and closed again; a fixed low port such as `1` is refused by Node's fetch as `bad port` before any connect.
