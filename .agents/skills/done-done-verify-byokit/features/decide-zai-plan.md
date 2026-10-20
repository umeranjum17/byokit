# Decide Z.AI coding plan

A decision backend for Z.AI (GLM) coding-plan members: `zai({ key, model })` or `zai({ account, model })` answers over the chat-completions wire with a strict `json_schema`, plan-billed only, and a refused key abstains with its typed `failure` code.

## Sub-features

- `zai-route`: the key path reaches `https://api.z.ai/api/coding/paas/v4/chat/completions` (`route` default `zai`); `route: 'zai-coding-cn'` reaches `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions`.
- `zai-account`: a plan account reaches only the endpoint its provider tag names; another plan account, an untagged one, or a key with an account is refused before any request.
- `zai-refusal`: a `401`/`403` abstains with `failure: { code: 'key_refused', status }`, `402` with `out_of_credit`, a `429` that outlasts the retries with `rate_limited`; the reason never carries the key or the body.
- `zai-reply`: a finished reply's JSON parses into answers; a cut-off (`finish_reason` other than `stop`), a refusal or malformed text abstains with its usage and raw response.

## How to get to it (user POV)

A Z.AI plan member's decision (for example a card rating) runs on the member's own GLM coding plan. A refused key reads as "your Z.AI key was refused", not as a generic failed rating.

## Driving it with a node scratch consumer

Preconditions: baseline (features/README.md), including a completed `npm run build`.

Write `"$scratch_dir/verify-decide-zai.mjs"`:

```js
import { createServer } from 'node:http';
import { once } from 'node:events';
import { decide, zai } from '@byokit/decide';

const key = 'sk-umer-test-SECRET-zai-key';
const answers = [];
const reply = (text) => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 40, completion_tokens: 12 } });
const fit = JSON.stringify({ fit: { probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 }, pick: '2', rationale: 'Strong match.' } });
const script = [[200, reply(fit)], [401, '{"error":{"message":"Invalid API key ' + key + '"}}'], [402, '{}'], [429, '{}'], [429, '{}'], [200, reply('not json')]];
let hits = 0;
const server = createServer((req, res) => {
  const [status, body] = script.shift(); hits++;
  console.log(`fake: ${req.method} ${req.url} -> ${status} auth=${req.headers.authorization === `Bearer ${key}`}`);
  res.writeHead(status, { 'content-type': 'application/json' }).end(body);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const local = `http://127.0.0.1:${server.address().port}`;
// The backend's fixed endpoint, sent to the loopback fake through the real fetch.
const fetch = (url, init) => globalThis.fetch(String(url).replace(/^https:\/\/[^/]+/, local), init);
const q = { fit: { kind: 'score', levels: ['skip', 'maybe', 'good'] } };
const ask = async (label, backend) => {
  const a = (await decide({ text: 'Umer' }, q, { privacy: 'may-leave', backends: [backend] })).fit;
  console.log(`${label}: answer ${a.answer} | abstained ${a.abstained} | reason ${JSON.stringify(a.reason)} | failure ${JSON.stringify(a.failure)} | usage ${JSON.stringify(a.usage)}`);
  return a;
};
const z = (input) => zai({ model: 'glm-5.2', fetch, maxRetries: 1, retryBaseMs: 0, ...input });
const got = [
  await ask('zai key ok', z({ key })),
  await ask('zai key 401', z({ key })),
  await ask('zai key 402', z({ key })),
  await ask('zai key 429 x2', z({ key })),
  await ask('zai key malformed', z({ key })),
];
server.close();
const failures = got.map((a) => a.failure ? `${a.failure.code}/${a.failure.status}` : 'none');
const checks = {
  answered: got[0].answer === 2 && got[0].by === 'zai',
  codes: JSON.stringify(failures) === JSON.stringify(['none', 'key_refused/401', 'out_of_credit/402', 'rate_limited/429', 'none']),
  retried: hits === 6,
  private: got.every((a) => !JSON.stringify(a).includes(key) && !JSON.stringify(a).includes('Invalid API key')),
};
if (!Object.values(checks).every(Boolean)) { console.log('FAIL', JSON.stringify(checks), failures.join(',')); process.exit(1); }
console.log('PASS', failures.join(','), JSON.stringify(checks));
```

```bash
feature=decide-zai-plan
entry="$scratch_dir/verify-decide-zai.mjs"
drive=(node "$scratch_dir/verify-decide-zai.mjs")
```

Run the SKILL.md Evidence block, then `leak_check 'sk-umer-test-SECRET-zai-key'`.

- **Happy path shows.** `zai key ok: answer 2 | abstained false | reason undefined | failure undefined | usage {"input_tokens":40,"output_tokens":12}`, then `zai key 401: … reason "zai failed: http 401" | failure {"code":"key_refused","status":401}`, `zai key 402: … out_of_credit/402`, two `fake:` lines then `zai key 429 x2: … reason "zai failed: http 429" | failure {"code":"rate_limited","status":429}`, and `PASS none,key_refused/401,out_of_credit/402,rate_limited/429,none`.
- **Malformed case shows.** `zai key malformed: answer null | abstained true | reason "malformed answer" | failure undefined | usage {"input_tokens":40,"output_tokens":12}`: a `200` whose text is not JSON abstains with its usage and no `failure`.
- **Private.** The fake's 401 body echoes the key; neither the key nor "Invalid API key" appears in any answer, and the `leak_check` step exits 0.

## Gotchas

- Loopback only (`127.0.0.1`, ephemeral port); the key is a fixture string. Never call Z.AI or any real provider.
- The backend's endpoint is fixed; the drive passes a `fetch` that rewrites the origin to the fake and sends through the real `fetch`.
- The unit-level cases (route, account tag, refusal words, cut-off replies) run on the source in `packages/decide/test/zai.test.ts`.
- No live GLM call: there is no lab Z.AI key, so the live proof is "not proven live: no lab GLM key".
