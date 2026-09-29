# Changelog

## Unreleased

- SECURITY: the operator install policy blocks any skill request whose kind contains `depend` (e.g. `skill-dependency-install`) even under an own root; previously only `installSpec` installer fields were checked.
- FIX: the trusted-skill version check uses `request.origin.version` when present and falls back to the `SKILL.md` frontmatter version, so reviewed bundled skills without a frontmatter version match their trusted entry.
- SECURITY: the bridge aborts the `AbortSignal` handed to `host.call` when that call's plugin socket closes or errors before the reply is written, so an aborted run no longer leaves the sandboxed command running; the listener is removed after a normal reply.
- SECURITY: the bridge plugin's `before_tool_call` relays every tool call to `ToolHost.gate`, engine builtins (`web_fetch`, `web_search`, memory and skill tools) included; before, anything outside `tools` ran ungated. The gate gets a fourth argument `{ builtin }`, an allowed builtin gets no permit or ticket, an unregistered session key is denied unless `allowOnce` matches, and a kit with no host blocks every tool. `KitOptions.gateBuiltins: false` restores gating only the app's tools. `prepare` now rewrites a stale `plugin/index.js`, so existing state dirs pick the gate up. A tool name the engine would rename before the hook (not `/^[a-z][a-z0-9_]*$/`, or `bash`/`cron`) is refused at construction, so an app tool never reaches the gate marked builtin.
- FIX: the packed `dist/words.d.ts` keeps `with { type: 'json' }` on its `./words.json` import, so a strict NodeNext consumer with `skipLibCheck: false` no longer fails with TS1543.
- FIX: `gatewayTransport` reads the Crewhouse legacy `device.json` shape (`deviceId`, `publicKeyPem`, `privateKeyPem`) as well as the kit's (`privateKey`, `publicKey`); an existing file is only read, never rewritten, and a file holding neither shape fails naming the file.
- FIX: `OpenClawKit.call()` before `start()` returns a rejected promise (`gateway not ready`) instead of throwing synchronously.
- The bridge no longer keys behavior on the plugin id: `KitOptions.bridge` (`socketName`, `paramPrefix`,
  validated, defaulting to `bridge.sock` / `__byokit`) replaces the `crewhouse` special-cases, and
  `startModelStub` takes a configurable `idPattern` and routing marker instead of a fixed prompt grammar
  (docs/runtime-kits.md §§5.5/5.9; adopting apps pass their own values explicitly).

- In development (O7): the fake Gateway (`fakeGateway`), the contract suite (`openclawContract`, run by O11) and the
  scripted model (`startModelStub`/`useModelStub`), ported from Crewhouse's test stubs with the script grammar
  unchanged (docs/runtime-kits.md §5.11).
- In development (O1): package scaffold and frozen signatures. Every implementation body refuses with
  `not built: <package id>` until its work package lands (docs/runtime-kits.md §11.2).
