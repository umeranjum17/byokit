# Accounts key-route refusals

A key-route ask that the provider refuses reads as its own typed `KeyRouteError`, so an app can say what is wrong instead of "Try again".

## Sub-features

- `refusal-credit`: a `402` (OpenRouter's "requires more credits" body, or an empty body) rejects with `out_of_credit` and the words "This account is out of credit. Add credit with the provider, then try again."
- `refusal-key`: a `401` (or `403` that is not the OpenCode workspace refusal) rejects with `key_refused`.
- `refusal-rate`: a `429` rejects with `rate_limited`, never retried.
- `refusal-unknown`: any other failure (a `500`, a dropped connection, even right after a `402`) stays `request`.

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

const credits = JSON.stringify({ error: { code: 402, message: 'This request requires more credits, or fewer max_tokens.' } });
const answers = [[402, credits], [401, '{"error":{"code":401,"message":"User not found."}}'], [429, '{"error":{"code":429}}'], [402, ''], 'drop', [500, '{}']];
const server = createServer((req, res) => {
  const a = answers.shift();
  console.log(`fake: ${req.method} ${req.url} -> ${a === 'drop' ? 'dropped' : a[0]}`);
  if (a === 'drop') return req.socket.destroy();
  res.writeHead(a[0], { 'content-type': 'application/json' }).end(a[1]);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let data = {}; const secrets = new Map();
const kit = new Accounts({ store: () => recordStore(async () => data, async (next) => { data = next; }),
  keyStore: () => ({ get: async (k) => secrets.get(k) ?? null, set: async (k, v) => { secrets.set(k, v); }, delete: async (k) => secrets.delete(k) }) });
const { id } = await kit.add('Umer', 'openrouter:key', { key: 'sk-or-fixture-not-a-key' });
const model = { id: 'fixture-model', name: 'Fixture', provider: 'openrouter', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`,
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 128 };
const got = [];
for (const label of ['402 credits body', '401', '429', '402 empty body', 'dropped after 402', '500']) {
  try { await kit.respond('Umer', { account: id, model, context: { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] } }); got.push('answered'); console.log(`${label}: answered (unexpected)`); }
  catch (e) { got.push(e.code); console.log(`${label}: ${e.name} ${e.code} — ${e.message}`); }
}
server.close();
const want = ['out_of_credit', 'key_refused', 'rate_limited', 'out_of_credit', 'request', 'request'];
if (JSON.stringify(got) !== JSON.stringify(want)) { console.log('FAIL want', want.join(','), 'got', got.join(',')); process.exit(1); }
console.log('PASS', got.join(','));
```

```bash
feature=accounts-key-refusals
entry="$scratch_dir/verify-key-refusals.mjs"
drive=(node "$scratch_dir/verify-key-refusals.mjs")
```

Run the SKILL.md Evidence block. The `dropped after 402` leg follows a served `402` on the same kit (the fake serves answers in order, one per ask), so it proves no earlier status leaks into a later ask.

- **Happy path shows.** One `fake:` line per ask (no repeats: never retried), then `402 credits body: KeyRouteError out_of_credit — This account is out of credit. Add credit with the provider, then try again.`, `401: … key_refused — …`, `429: … rate_limited — …`, `402 empty body: … out_of_credit — …`, and `PASS`.
- **Missing and error cases show.** `dropped after 402: KeyRouteError request — This account could not answer. Try again.` and `500: KeyRouteError request — …`.

Regression: against a build without the mapping every leg reads `request` and the drive exits 1.

## Gotchas

- Loopback only (`127.0.0.1`, ephemeral port); the key is a fixture string, never a real credential. No paid call.
- The integration test `packages/accounts/test/key-routes.test.ts` ("a provider refusal reads as its own typed error") runs the same sequence on the source.
