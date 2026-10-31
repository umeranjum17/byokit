# @byokit/endpoint

One loopback address that answers OpenAI and Anthropic web-format requests with the person's own API key, on macOS and Linux with Node 22.18 or later.
It runs a checksum-pinned [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) release that the app ships, writes its config at run time, and
serves exactly one key. It is for **key routes only**: no subscription sign-in, no pool, no rotation, no panel, database or git or object store.
The Claude Code user agent and Chrome-style TLS settings the program can apply to subscription routes are never reachable from these options.

```ts
import { startEndpoint, readEndpointRoom, EndpointError } from '@byokit/endpoint';

try {
  const endpoint = await startEndpoint({
    stateDir: '/app/state',                    // absolute, private (0700), outside any git work tree
    binaryPath: '/app/bin/cli-proxy-api',      // the pinned release; absent, the first one on PATH
    credential: { provider: 'openai', key: 'sk-your-own-key' },
    models: ['gpt-5'],                         // the model ids the upstream serves
  });
  // Any tool that speaks the OpenAI or Anthropic web format: base URL endpoint.url, API key endpoint.clientKey.
  console.log(endpoint.url, endpoint.port);
  await endpoint.stop();
} catch (e) {
  if (e instanceof EndpointError) console.error(e.code, e.message);
}
declare const planKey: string;
const room = await readEndpointRoom({ credential: { provider: 'zai', key: planKey } });
console.log('windows' in room ? room.windows : room.code);
```

- **One address, one credential per run.** `url` is `http://127.0.0.1:<port>` (`port` defaults to 8317). `clientKey` is new every run; a tool
  must send it, so another program on the computer cannot spend the person's key. The provider key never leaves the config file the kit writes
  (0600, in `<stateDir>/endpoint/`, deleted by `stop()`).
- **Key routes.** `provider` is `openai`, `openrouter`, `opencode` or `zai`; each is an OpenAI-compatible upstream. `baseUrl` replaces its address
  with an `https` one, or an `http` one on loopback for a local fake.
- **The child.** It starts through `sh` with umask 077 and `ulimit -c 0`, `GOTRACEBACK=none`, an environment built from nothing (`HOME` in the endpoint
  folder, `GOTRACEBACK`, plus the `env` option), stdout and stderr in `server.log` (0600), `--local-model` and never `--home-jwt`. Nothing in the
  config opens a store, a panel, a management API, a log of request bodies, mDNS or pprof. The one environment read is `PATH`, to find `cli-proxy-api`
  when `binaryPath` is absent.
- **Refusals.** `EndpointError` codes: `bad-state-dir` (not absolute), `state-dir-in-git`, `state-dir-open` (group or world access),
  `more-than-one-credential`, `bad-credential`, `subscription-provider` (Claude, ChatGPT or Codex, Copilot and the like), `unknown-provider`,
  `no-models`, `host-not-loopback`, `base-url-refused`, `store-variable` (`PGSTORE_*`, `GITSTORE_*`, `OBJECTSTORE_*`, `HOME_JWT` in `env`),
  `binary-missing`, `start-failed`. Each message names the concrete requirement and never holds the key.
- **Room.** `readEndpointRoom` reads the plan windows of `opencode` and `zai` plan keys with [`@byokit/usage`](../usage) and returns its `Reading`.
  A provider without a usage API (`openai`, `openrouter`) gives `{ ok: false, code: 'no-usage-api', provider }`. It calls the provider directly with
  the person's key, not the local address.
- **Not covered.** The no-network namespace proof runs on Linux only; macOS and Windows are unverified (Windows has no `sh`, so it is not supported).
  The program still makes two startup version checks (npm and an update host) that no config key turns off; the engine test shows it serves without them.
  `endpointConfig(options, clientKey, dir)` returns the exact config object for review.

## Tests

`npm test` runs `packages/endpoint/test/*.test.ts`: every refusal, the generated config field by field, and a fake binary that proves the launch
(umask, core limit, environment, file modes). `npm run test:endpoint-engine` runs the real pinned release in the `endpoint-engine` CI job under
`unshare -rn` against a loopback fake upstream; it needs `BYOKIT_CLIPROXYAPI_ARCHIVE`, the v8.0.48 `linux_amd64_no-plugin` tarball, and checks its checksum.
