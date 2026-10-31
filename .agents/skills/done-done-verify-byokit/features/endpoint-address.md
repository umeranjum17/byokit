# Endpoint: one loopback address for one API key

`@byokit/endpoint` `startEndpoint` starts the checksum-pinned CLIProxyAPI on one loopback address and answers OpenAI and Anthropic web-format requests with the person's own key for that provider. Every run writes its own config: the key sits in a `0600` file inside a `0700` folder, the bind is loopback, an upstream address stays on the provider's own host, retries are off unless `retry: 1` is asked for, and each unsafe setup is a typed `EndpointError` instead of a start.

## Sub-features

- `address-answered`: the start returns `url` `http://127.0.0.1:<port>` and a fresh `clientKey` (`byokit-…`, 39 characters); one `POST /v1/chat/completions` carrying that client key comes back `200` with the fake provider's answer, and the provider key — not the client key — is what the upstream read.
- `address-private`: `<stateDir>` and `<stateDir>/endpoint` are `0700` and `config.yaml` and `server.log` are `0600`; while the endpoint runs, the only file on the machine holding the provider key is `endpoint/config.yaml`, and `stop()` deletes it, so nothing holds the key afterwards.
- `address-retry-off`: with the default `retry: 0` a failing provider call reaches the client as a `503` after exactly one upstream call; the package's engine test owns the `retry: 1` opt-in, which accepts that a failed attempt may have been billed.
- `address-refusals`: `more-than-one-credential` (a second credential), `host-not-loopback` (`0.0.0.0`), `base-url-not-provider-host` (`https://api.z.ai/...` on an `openai` credential), `env-proxy` (`HTTPS_PROXY`) and `state-file-symlink` (a link planted at `endpoint/config.yaml`) each refuse before anything is written or spawned, with the sentence that names the missing requirement and no key in it; the link's target stays empty.

## How to get to it (user POV)

A person starts an endpoint for their own `openai` key and a model id, copies the printed address and client key into a tool that speaks the OpenAI format, and asks a question: the answer comes back through that local address, and when the app stops, the file that held the key is gone. A second credential, a bind other than loopback, another provider's host, a proxy variable or a link in the endpoint folder is refused in words that say what is missing, and nothing starts.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), including a completed `npm run build` with `packages/endpoint/dist/index.js` on the branch under test; the pinned CLIProxyAPI extracted on this machine; Linux with unprivileged user namespaces (`unshare -rn true` exits 0). The pinned binary is the v8.0.48 `linux_amd64_no-plugin` release, the same one the `endpoint-engine` CI job downloads; fetch it once, outside the repo, and check it before extracting:

```bash
bin_dir=$(mktemp -d)   # outside the repo; the endpoint state dir must not be in a git work tree either
gh release download v8.0.48 -R router-for-me/CLIProxyAPI --pattern '*linux_amd64_no-plugin.tar.gz' --dir "$bin_dir"
sha256sum "$bin_dir"/*.tar.gz   # must print fb3bada1cdd05a8ef84b9f3b777c1019092c87def6405d057fbe1b2be9def22f
tar -xzf "$bin_dir"/*.tar.gz -C "$bin_dir" cli-proxy-api
export BYOKIT_CLIPROXYAPI_BIN="$bin_dir/cli-proxy-api"
```

A machine without that binary, or without user namespaces, leaves this surface **unavailable**: the drive prints `unavailable: …` and exits 1 — it is never a skipped pass.

Write `"$scratch_dir/verify-endpoint.mjs"`:

```js
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EndpointError, startEndpoint } from '@byokit/endpoint';

const bin = process.env['BYOKIT_CLIPROXYAPI_BIN'] ?? '';
if (bin === '') { console.log('unavailable: set BYOKIT_CLIPROXYAPI_BIN to the extracted pinned cli-proxy-api'); process.exit(1); }
const key = 'sk-fixture-endpoint-not-a-real-key';
const models = ['fixture-model'];
const mode = (p) => statSync(p).mode & 0o777;

// The loopback stand-in the engine test uses: an OpenAI-compatible upstream that fails its first call.
let hits = 0;
let failed = false;
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (!req.url.endsWith('/chat/completions')) return void res.writeHead(404).end('{}');
    hits++;
    const status = failed ? 200 : ((failed = true), 503);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200
      ? JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      : JSON.stringify({ error: { message: 'fixture failure', type: 'fixture' } }));
  });
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

const freePort = async () => {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  return port;
};
const ask = async (endpoint) => (await fetch(`${endpoint.url}/v1/chat/completions`, {
  method: 'POST', headers: { authorization: `Bearer ${endpoint.clientKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'ping' }] }),
})).status;

const state = mkdtempSync(join(tmpdir(), 'byokit-endpoint-'));
const folder = join(state, 'endpoint');
const checks = {};

// Leg 1: retries are off by default, so one failing upstream call is one upstream call.
const first = await startEndpoint({ stateDir: state, binaryPath: bin, port: await freePort(), baseUrl, models, credential: { provider: 'openai', key } });
const firstStatus = await ask(first);
const config = join(folder, 'config.yaml');
const whileRunning = readdirSync(folder, { recursive: true }).map((f) => join(folder, String(f))).filter((f) => { try { return readFileSync(f, 'utf8').includes(key); } catch { return false; } });
checks['default-no-retry'] = firstStatus !== 200 && hits === 1;
checks['private-folders'] = mode(state) === 0o700 && mode(folder) === 0o700;
checks['private-files'] = mode(config) === 0o600 && mode(join(folder, 'server.log')) === 0o600;
checks['key-only-in-config'] = JSON.stringify(whileRunning) === JSON.stringify([config]);
console.log(`leg 1: client ${firstStatus} after ${hits} upstream call at ${first.url}, folders ${mode(state).toString(8)}/${mode(folder).toString(8)}, files ${mode(config).toString(8)}/${mode(join(folder, 'server.log')).toString(8)}, key in ${JSON.stringify(whileRunning.map((f) => f.slice(state.length)))}`);
await first.stop();
const afterStop = readdirSync(folder, { recursive: true }).map((f) => join(folder, String(f))).filter((f) => { try { return readFileSync(f, 'utf8').includes(key); } catch { return false; } });
checks['key-gone-at-stop'] = afterStop.length === 0;

// Leg 2: the same key on a second endpoint, its own client key, a client request answered 200 through the returned address.
const second = await startEndpoint({ stateDir: state, binaryPath: bin, port: await freePort(), baseUrl, models, credential: { provider: 'openai', key } });
const secondStatus = await ask(second);
checks['answered-200'] = secondStatus === 200 && hits === 2;
console.log(`leg 2: client ${secondStatus} through ${second.url} after ${hits} upstream calls, client key ${second.clientKey.slice(0, 7)}… (${second.clientKey.length} chars)`);
await second.stop();
upstream.close();

// Every unsafe setup refuses with its typed code, before anything is written or spawned.
const refuses = async (label, options, code, want) => {
  try { await startEndpoint({ stateDir: state, binaryPath: bin, models, credential: { provider: 'openai', key }, ...options }); checks[label] = false; console.log(`${label}: started (unexpected)`); }
  catch (e) { checks[label] = e instanceof EndpointError && e.code === code && !e.message.includes(key); console.log(`${label}: ${e.name} ${e.code} — ${e.message}`); }
  if (!checks[label]) console.log(`  expected ${code}: ${want}`);
};
await refuses('second-credential', { credential: [{ provider: 'openai', key }, { provider: 'zai', key }] }, 'more-than-one-credential', 'exactly one credential');
await refuses('non-loopback-host', { host: '0.0.0.0' }, 'host-not-loopback', '127.0.0.1 or localhost');
await refuses('another-provider-host', { baseUrl: 'https://api.z.ai/api/coding/paas/v4' }, 'base-url-not-provider-host', 'the provider\'s own host or loopback HTTP');
await refuses('proxy-variable', { env: { HTTPS_PROXY: 'http://127.0.0.1:9' } }, 'env-proxy', 'nothing carries the key off this device');
mkdirSync(join(state, 'linked', 'endpoint'), { recursive: true, mode: 0o700 });
const target = join(state, 'outside-config');
writeFileSync(target, '');
symlinkSync(target, join(state, 'linked', 'endpoint', 'config.yaml'));
await refuses('config-symlink', { stateDir: join(state, 'linked') }, 'state-file-symlink', 'a regular file, not a symbolic link');
checks['symlink-target-untouched'] = readFileSync(target, 'utf8') === '';

const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
console.log(JSON.stringify(checks));
if (failedChecks.length) { console.log(`FAIL ${failedChecks.join(',')}`); process.exit(1); }
console.log('PASS');
```

```bash
feature=endpoint-address
entry="$scratch_dir/verify-endpoint.mjs"
drive=(unshare -rn sh -c 'ip link set lo up; exec node "$0"' "$scratch_dir/verify-endpoint.mjs")
```

Run the SKILL.md Evidence block. A fresh network namespace has no loopback device up, so the drive brings `lo` up first; that namespace is what keeps the pinned binary's two startup version checks (npm and an update host) from reaching anything.

- **Happy path shows.** `leg 2: client 200 through http://127.0.0.1:<port> after 2 upstream calls, client key byokit-… (39 chars)`, then `PASS`.
- **Private files show.** `leg 1: client 503 after 1 upstream call at http://127.0.0.1:<port>, folders 700/700, files 600/600, key in ["/endpoint/config.yaml"]` — the retry-off leg and the file modes in one line.
- **Refusals show.** One line each: `second-credential: EndpointError more-than-one-credential — One endpoint serves exactly one credential; start a second endpoint for another key.`, `non-loopback-host: … host-not-loopback — host 0.0.0.0 is not loopback; use 127.0.0.1 or localhost.`, `another-provider-host: … base-url-not-provider-host — baseUrl must use api.openai.com or loopback HTTP.`, `proxy-variable: … env-proxy — env names HTTPS_PROXY are refused: …`, `config-symlink: … state-file-symlink — config.yaml must be a regular file, not a symbolic link or other file type.`
- **Missing prerequisite shows.** With `BYOKIT_CLIPROXYAPI_BIN` unset the drive prints `unavailable: set BYOKIT_CLIPROXYAPI_BIN to the extracted pinned cli-proxy-api` and exits 1: an unavailable surface, not a pass.

Regression: without the mode setting the `private-folders`/`private-files` checks fail; a build that repeats the failed call makes `default-no-retry` fail (two upstream calls, a 200 to the client); a build that accepts a second credential, `0.0.0.0`, a foreign `baseUrl`, `HTTPS_PROXY` or a planted config link fails that refusal's own check.

## Gotchas

- The state folder must be outside any git work tree, so the drive puts it under the OS temporary directory (`mkdtemp` in `tmpdir()`), never in `$scratch_dir` inside the worktree: `startEndpoint` refuses that with `state-dir-in-git` (and `state-dir-open` for group or world access).
- Both ports are ephemeral: the fake provider listens on port 0, and each endpoint gets a free loopback port picked by opening and closing one. The `8317` default collides with anything else on the machine.
- The key is a fixture string, never a real credential; no request leaves loopback. The upstream records the provider key it was sent, so the drive proves the client key is what let the request in.
- `stop()` deletes `config.yaml` but leaves `server.log` (0600) and the `auths`/`home` folders; the drive checks the key is in no file of that folder after the stop.
- The `retry: 1` leg and the no-network namespace are the package's own engine job (`packages/endpoint/test/engine/cliproxyapi.test.ts`, `npm run test:endpoint-engine`); this journey never repeats it.
- **Not provable on this host.** A real provider (`api.openai.com` answers with a live key; no credential and no egress here — the fake upstream stands in for it), and macOS/Windows isolation (the package's README leaves them unverified and Windows has no `sh`; the namespace wrap above is Linux only). Attempted entry for both: this drive, which has no non-Linux equivalent, so they stay unavailable rather than being shown through the fake.
