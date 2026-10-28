# Decide refusal codes

When the provider refuses the key or account, the abstained answer says so with a typed `failure: { code, status }`, so an app words it ("your writer account refused") instead of "the rating did not come back clearly". The codes are `@byokit/accounts`' `KeyRouteError` refusal codes.

## Sub-features

- `refusal-key`: a `401`/`403` on a plain key and on a plan account alike (OpenCode Go's "Workspace access denied") abstains with `failure: { code: 'key_refused', status }`; a plan account no longer throws `UnsupportedAccountError` for it.
- `refusal-credit`: a `402` abstains with `out_of_credit`.
- `refusal-rate`: a `429` that outlasts the retries abstains with `rate_limited`; the retries still happen.
- `refusal-answerer`: an `answerer` whose callback rethrows `accounts.respond`'s `KeyRouteError` refusal keeps its code and status.
- `refusal-none`: any other failure (a `500`) has no `failure`, only its `reason`; a plan account the endpoint cannot serve (`404`) still throws `UnsupportedAccountError`.
- `refusal-private`: neither `reason` nor `failure` ever holds the provider's body or the key, even when the body echoes the key.

## How to get to it (user POV)

Ownvoice rates a reply with a writer account that OpenCode Go refuses (403 "Workspace access denied"). The card used to say "The rating did not come back clearly"; now `answer.failure.code === 'key_refused'` lets it say the writer account refused.

## Driving it with a node scratch consumer

Preconditions: baseline (features/README.md), including a completed `npm run build`.

Write `"$scratch_dir/verify-decide-refusals.mjs"`:

```js
import { createServer } from 'node:http';
import { once } from 'node:events';
import { decide, opencodeGo, jev, answerer, UnsupportedAccountError } from '@byokit/decide';
import { Accounts, recordStore } from '@byokit/accounts';

const key = 'sk-umer-test-SECRET-go-key';
const denied = JSON.stringify({ error: { message: `Workspace access denied for ${key}` } });
const answers = [[403, denied], [403, denied], [402, '{"error":{"message":"insufficient credit"}}'], [429, '{}'], [429, '{}'], [500, denied], [404, '{}'], [403, denied]];
let hits = 0;
const server = createServer((req, res) => {
  const [status, body] = answers.shift(); hits++;
  console.log(`fake: ${req.method} ${req.url} -> ${status}`);
  res.writeHead(status, { 'content-type': 'application/json' }).end(body);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const local = `http://127.0.0.1:${server.address().port}`;
// The backends' fixed endpoints, sent to the loopback fake through the real fetch.
const fetch = (url, init) => globalThis.fetch(String(url).replace(/^https:\/\/[^/]+/, local), init);
const q = { fit: { kind: 'score', levels: ['skip', 'maybe', 'good'] } };
const account = { provider: 'opencode-go', billing: 'subscription', access: async () => key };
const ask = async (label, backend) => {
  const a = (await decide({ text: 'Umer' }, q, { privacy: 'may-leave', backends: [backend] })).fit;
  console.log(`${label}: abstained ${a.abstained} | reason ${JSON.stringify(a.reason)} | failure ${JSON.stringify(a.failure)}`);
  return a;
};
const go = (input) => opencodeGo({ model: 'muse-spark-1.3-contributor', fetch, maxRetries: 1, retryBaseMs: 0, ...input });
const got = [
  await ask('go key 403', go({ key })),
  await ask('go account 403', go({ account })),
  await ask('jev key 402', jev({ key, fetch })),
  await ask('go key 429 x2', go({ key })),
  await ask('go key 500', go({ key })),
];
let unsupported = '';
try { await ask('go account 404', go({ account })); } catch (e) { unsupported = `${e.name} ${e instanceof UnsupportedAccountError} ${e.message}`; console.log(`go account 404: ${unsupported}`); }
// Ownvoice's shape: an answerer over accounts.respond on a key route the provider refuses.
let data = {}; const secrets = new Map();
const kit = new Accounts({ store: () => recordStore(async () => data, async (next) => { data = next; }),
  keyStore: () => ({ get: async (k) => secrets.get(k) ?? null, set: async (k, v) => { secrets.set(k, v); }, delete: async (k) => secrets.delete(k) }) });
const { id } = await kit.add('Umer', 'openrouter:key', { key });
const model = { id: 'fixture-model', name: 'Fixture', provider: 'openrouter', api: 'openai-completions', baseUrl: `${local}/api/v1`,
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 128 };
const writer = answerer({ name: 'writer', leaves: true, ask: async (prompt) => {
  const reply = await kit.respond('Umer', { account: id, model, context: { messages: [{ role: 'user', content: prompt, timestamp: 0 }] } });
  return reply.content.map((c) => c.text ?? '').join('');
} });
got.push(await ask('answerer over accounts.respond 403', writer));
server.close();
const failures = got.map((a) => a.failure ? `${a.failure.code}/${a.failure.status}` : 'none');
const checks = {
  codes: JSON.stringify(failures) === JSON.stringify(['key_refused/403', 'key_refused/403', 'out_of_credit/402', 'rate_limited/429', 'none', 'key_refused/403']),
  allAbstained: got.every((a) => a.abstained), retried: hits === 8,
  unsupported: /^UnsupportedAccountError true .*http 404/.test(unsupported),
  private: got.every((a) => !JSON.stringify(a).includes(key) && !JSON.stringify(a).includes('Workspace')),
};
if (!Object.values(checks).every(Boolean)) { console.log('FAIL', JSON.stringify(checks), failures.join(',')); process.exit(1); }
console.log('PASS', failures.join(','), JSON.stringify(checks));
```

```bash
feature=decide-refusal-codes
entry="$scratch_dir/verify-decide-refusals.mjs"
drive=(node "$scratch_dir/verify-decide-refusals.mjs")
```

Run the SKILL.md Evidence block, then `leak_check 'sk-umer-test-SECRET-go-key'`.

- **Happy path shows.** `go key 403: abstained true | reason "opencode-go failed: http 403" | failure {"code":"key_refused","status":403}`, the same for `go account 403`, `jev key 402 … out_of_credit`, two `fake:` lines then `go key 429 x2 … rate_limited`, `answerer over accounts.respond 403: … reason "writer failed: http 403" | failure {"code":"key_refused","status":403}`, and `PASS`.
- **Missing and error cases show.** `go key 500: … reason "opencode-go failed: http 500" | failure undefined` and `go account 404: UnsupportedAccountError true OpenCode Go plan request unsupported (http 404).`
- **Private.** The fake's bodies echo the key and "Workspace access denied"; neither appears in any answer.

Regression: against a build without the change `go account 403` throws `UnsupportedAccountError` out of `decide`, so the drive exits 1; the source tests on that base show every other leg's `failure` undefined and the `answerer` leg's reason as just `writer failed`.

## Gotchas

- Loopback only (`127.0.0.1`, ephemeral port); the key is a fixture string. Never call OpenCode Go or any real provider.
- The backends' endpoints are fixed; the drive passes a `fetch` that rewrites the origin to the fake and sends through the real `fetch`.
- The integration tests `packages/decide/test/decide.test.ts` (the Jev retry journey) and `react-native.test.ts` (the answerer's `KeyRouteError` leg) run the same cases on the source.
