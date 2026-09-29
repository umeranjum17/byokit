# Changelog

## Unreleased

## 0.1.0 (2026-09-29)

- First release on npm (docs/runtime-kits.md §10). `examples/openclaw-kit` (O12) is the whole flow from a phone
  browser: pair, sign in with ChatGPT by device code, a streamed run, a tool that asks first, Allow and Deny. Its
  e2e runs in CI from the packed packages against the fake Gateway; `LIVE.md` is the real-engine check.
- `.` and `./device` export the kit's sentences (`words`, `stateWords`, `toAccountView`, `WordKey`, `AccountView`),
  and `./device` the types a device screen needs (`Approval`, `Decision`, `KitState`, `Route`, `RunEnd`, `RunEvent`,
  `SignInView`).
- FIX: `oc.signin.view`'s `ready` (and so `openclawDevice(link).signIn.view(p).ready`) is the member's sign-in to that
  provider, not the engine being up. Before, a phone's `phaseOf` said `done` while the device code was still showing,
  and a member who was never signed in looked signed in.
- FIX: `signIn.view(p)` drops a finished sign-in once its account is gone (signed out over the link, on the computer,
  or by the engine), so it no longer shows that old sign-in as done.
- Depends on @byokit/link 0.3.2.
- Depends on @byokit/relay 0.2.1.

- FIX: the account an app picks for a run is now the one the engine calls and bills. `RunSpec.model`
  (`'provider/model'`, also `oc.run`'s `model` and `openclawDevice(link).run(message, { model })`) goes to the engine as
  that run's own provider and model, with no fallback to another provider or model. A provider the member isn't
  signed in to ends the run `signed-out` before the engine is called. A malformed reference, or one carrying an
  `@profile` sign-in pin, is refused. Leaving it out sends the same request as before. The choice is per provider:
  with two sign-ins for one provider the engine may still switch between them, so a single sign-in can't be picked.

- Typed device pass-through (G4, docs/runtime-kits.md 7.2): `openclawDevice(link).call<M>(method, params)` returns
  `GatewayResult<M>` from the generated table (params now required, as on the kit), `events()` yields
  `OpenClawLinkEvent` frames, and `./device` re-exports the table types. The device gains `sessions()` (`oc.sessions`,
  *view*) and `signOut(p)` (`oc.signout`).
- FIX: `GatewayParams` for every anyOf/oneOf method now carries each branch's full property set from the pin's `protocol.schema.json` (re-emitted into `src/generated/params.ts` by `npm run gen:openclaw`), so `kit.call('cron.run', { id, mode: 'force' })` compiles; branch requirements the old types dropped (`cron.scratch.set` content, `cron.update` patch) and oneOf exclusions (`sessions.dispatch`, `exec.approvals.node.set`, `audit.run.inspect`, spelled as `prop?: never`) are enforced the way the gateway validates them.
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

- `./testing`: the fake Gateway (`fakeGateway`), the contract suite (`openclawContract`, also run against the real
  pinned engine) and the scripted model (`startModelStub`/`useModelStub`), ported from Crewhouse's test stubs with the
  script grammar unchanged (docs/runtime-kits.md §5.11).
