# Decide pi backend

A decision and `generate` backend that runs the person's installed pi binary with a chosen model (for example `deepseek/deepseek-flash`), with the complete environment for the app-selected account (never copied from `process.env`): `pi({ bin, model, timeoutMs, env })` from `@byokit/decide/pi` passes the model as `--model`, runs `pi --mode json --no-session --no-tools ...` with the prompt on stdin, and reads the last assistant message.

## Sub-features

- `pi-model-required`: `pi({ bin, timeoutMs })` with no `model` throws `PiError` code `model_required` before any process starts; pi's own default model is never used.
- `pi-model`: the chosen model reaches pi as `--model <provider/id>`, and the request reaches that provider's endpoint.
- `pi-answer`: the assistant text is validated against the schema; `data`, `usage` (`input_tokens`/`output_tokens`) and `raw` come back.
- `pi-refusal`: a pi that exits nonzero, or an assistant message whose `stopReason` is `error`, rejects with `PiError` `process` and fixed text (no stderr).

## How to get to it (user POV)

A host whose captain or customer has a DeepSeek key only inside pi asks decisions through `pi({ bin, model: 'deepseek/deepseek-flash' })`; the answer comes back on that model and the key never leaves pi.

## Driving it with a node scratch consumer

Preconditions: baseline (features/README.md), including a completed `npm run build`, and the `pi` CLI on PATH (or pass its absolute path as `PI_BIN`). The drive points pi at a throwaway HOME and `PI_CODING_AGENT_DIR`, so the owner's `~/.pi` is never read or written; the provider is a loopback fake declared in that folder's `models.json`.

Write `"$scratch_dir/verify-decide-pi.mjs"`:

```js
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';

const bin = process.env.PI_BIN ?? execFileSync('sh', ['-c', 'command -v pi'], { encoding: 'utf8' }).trim();
const home = mkdtempSync(join(tmpdir(), 'verify-pi-home-'));
mkdirSync(join(home, 'agent'));
const seen = [];
const server = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    seen.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish, usage) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
    res.write(chunk({ role: 'assistant', content: '{"name":"Umer"}' }, null));
    res.write(chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }));
    res.write('data: [DONE]\n\n'); res.end();
  });
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
writeFileSync(join(home, 'agent', 'models.json'), JSON.stringify({ providers: { deepseek: {
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-fake-key',
  models: [{ id: 'deepseek-flash' }] } } }));
const env = { HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), PATH: '/usr/bin:/bin' };
const { pi } = await import('@byokit/decide/pi');
const schema = { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string' } } };
const out = await pi({ bin, model: 'deepseek/deepseek-flash', timeoutMs: 60_000, env }).generate({ prompt: 'Who is it?', schema, system: 'You are a test.' });
const request = seen[0] ?? {};
const checks = {
  answered: JSON.stringify(out.data) === '{"name":"Umer"}',
  usage: out.usage?.input_tokens === 12 && out.usage?.output_tokens === 4,
  model: request.model === 'deepseek-flash',
  schemaInSystem: String(request.messages?.[0]?.content).includes('"required"'),
  prompt: JSON.stringify(request.messages?.at(-1)?.content).includes('Who is it?'),
};
server.close();
rmSync(home, { recursive: true, force: true });
console.log(JSON.stringify({ data: out.data, usage: out.usage, checks }));
if (!Object.values(checks).every(Boolean)) { console.log('FAIL'); process.exit(1); }
console.log('PASS');
```

```bash
feature=decide-pi-backend
entry="$scratch_dir/verify-decide-pi.mjs"
drive=(node "$scratch_dir/verify-decide-pi.mjs")
```

Run the SKILL.md Evidence block. The drive removes its throwaway HOME itself.

- **Happy path shows.** `{"data":{"name":"Umer"},"usage":{"input_tokens":12,"output_tokens":4},"checks":{"answered":true,"usage":true,"model":true,"schemaInSystem":true,"prompt":true}}` then `PASS`.
- **Refusal (optional extra leg).** Point `models.json` at a port that refuses connections; the drive then prints a `PiError` with `code: 'process'` and the fixed message, never stderr text.

## Gotchas

- Loopback only (`127.0.0.1`, ephemeral port); `apiKey` in `models.json` is a fixture. Never run pi against a real provider from a drive.
- The owner's `~/.pi` is never read: `HOME` and `PI_CODING_AGENT_DIR` point at the throwaway folder. Do not drop those two overrides.
- Without `models.json`, pi exits `1` with "No API key found" on stderr and only the session header on stdout; that is the `process` refusal.
- The offline source check in `packages/decide/test/pi.test.ts` proves no child is launched on refusal and that an ambient OpenRouter key is absent from an explicit-model child's environment. The full cross-kit guard capture is [Pi model admission](pi-model-admission.md).
