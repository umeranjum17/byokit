# Changelog

## Unreleased

- FIX: Device-code sign-in waits for the engine’s code expiry instead of failing after two minutes; caller cancellation and expiry return typed outcomes with plain words.
- Offer the native Claude Code / Agent SDK subscription route (`claude-cli`, plugin `anthropic`), keeping login in Claude Code in the isolated engine HOME. Sign-in uses engine detection and live activation; `oc.state` reports native login readiness.
- Support explicit Anthropic API key activation with a per-use billing label and secret-safe views; never offer an API-key fallback. Direct Claude.ai OAuth and setup-token offers remain excluded.
- Verify native and API per-run provider/model forwarding, tool events and strict refusal of `@profile` pins.

## 0.3.3 (2026-09-30)

- Dependency update: pins @byokit/secrets 0.5.0.

- SECURITY: Opt-in dual-wrap credential upgrades are authenticated and atomically replaced under the store lock; protection is only as strong as the owner-only host-key file, which must stay out of sealed-store backups.
- FIX: A locked or unresponsive keyring no longer throws from prepare or start. The kit reports a locked saved sign-in in plain words, preserves the sealed store and retries normally on a later start after unlock; dual-wrapped stores open through their host key without prompting.

- FIX: ChatGPT subscription device pairing was blocked by the plugin allowlist unless the app added the provider plugin itself. The kit now merges every offered route's provider plugin with the bridge and caller-provided plugins, without adding plugins for unoffered routes.
- Label the explicit Anthropic route as API key (billed per use), keeping API and plan routes off by default.

## 0.3.2 (2026-09-30)

- Dependency update: pins @byokit/secrets 0.4.0.

- SECURITY: View-only devices can no longer resolve approvals through relay push actions.
- FIX: Existing authSeal calls using osKeyringSeal automatically pick up persistent headless sealing, including locked and unresponsive keyring fallback, without host changes.
- Document the credential, migration and sealed-approval threat model in SECURITY.md, shipped with the package.
- Run the shared engine isolation contract in npm test with an offline child; keep the pinned-engine check in test:engine.

## 0.3.1 (2026-09-30)



- FIX: `authSeal` no longer rejects retained-login migration when engine state contains symlinks or runtime entries. File symlinks whose fully resolved targets are regular files inside the isolated engine root are sealed and restored as regular files at the link paths; outside-root, dangling and directory symlinks (including loops), sockets, FIFOs and devices are skipped without reading their contents.
- Depends on @byokit/ui-core 0.4.0.

## 0.3.0 (2026-09-30)



- SECURITY: Provider access and refresh tokens persisted in plaintext engine stores; hosts can now pass `authSeal` from `@byokit/secrets` to seal the isolated stores while stopped and protect migration archives. Upgrade and call `prepare()` with an OS-keyring or host-owned-key adapter; protect live state and backups separately.
- SECURITY: Verified retained-login sources are removed instead of archived in plaintext; existing confirmed copies and engine migration archives are removed or sealed on the next prepare.

## 0.2.5 (2026-09-30)

- Dependency update: pins @byokit/relay 0.4.2.
- Dependency update: pins @byokit/link 0.6.0.

## 0.2.4 (2026-09-30)

- Dependency update: pins @byokit/relay 0.4.1.
- Dependency update: pins @byokit/link 0.5.1.
- FIX: (from @byokit/link 0.5.1) Reject an authenticated empty transport frame instead of decoding it as an empty control message.


## 0.2.3 (2026-09-30)



- FIX: `prepare()` repairs stale engine manifests and missing or wrong-version dependencies before reusing an installed engine.


## 0.2.2 (2026-09-30)

- Depends on @byokit/relay 0.4.0.

## 0.2.1 (2026-09-30)

- Depends on @byokit/relay 0.3.1.
- Depends on @byokit/reach 0.4.0.
- Depends on @byokit/link 0.5.0.
- FIX: (from @byokit/link 0.5.0) `decodeOffer()` reads legacy compact direct pairing codes with checksum, padding, bounds and expiry validation; new encodings keep the complete current format.

- Dependency update: pins @byokit/link 0.5.0, @byokit/reach 0.4.0 and @byokit/relay 0.3.1.

## 0.2.0 (2026-09-30)

- Full run options over the link (v1 A6): `oc.run` and `openclawDevice(link).run(message, o)` forward `system`,
  `images`, `thinking` and `tools`, each type-checked. `RunSpec.tools` is the run's subset of the app's tools
  (`KitOptions.tools` names, listed by the new `kit.toolNames()`): the bridge refuses any other app tool before
  `ToolHost.gate` sees it, engine builtins are unaffected, and a name the kit does not register is refused before the
  engine is called (over the link, `link.notAllowed`). The pinned engine takes no per-run tool list, so the model
  still sees every tool; the gate is the enforcement. Runs sharing a session key share the narrowest subset.
- Structured tool events (v1 A7): a `tool` `RunEvent` carries the engine's `id` (its toolCallId) on both ends, the
  call's `input` on `start`, and the engine's `output` and `error` on `end`.
- Usage (v1 A8): `RunEnd.ok` carries `usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `total`,
  `costUsd`), the engine's own total for the run from the `agent` request's final frame, and `planWindow`
  (`{ provider, plan?, windows: { label, usedPercent, resetAt? }[] }`), the engine's cached read of the
  subscription's quota for the run's provider. Each is present only when the engine reports it; nothing is estimated.
  New types `RunUsage` and `PlanWindow` (`.`, `./device`).
- Presence and version (v1 A12, device side): `oc.state` (`openclawDevice(link).state()`, typed `DeviceState`) adds
  `version` (this kit), `engine` (`ENGINE_VERSION`) and `signedIn`, the providers the device's member is usably
  signed in to (not an expired or unfinished sign-in), absent while the engine can't say.
- FIX: a run ending no longer drops another live run's registration on the same session key (its tool calls then
  failed as an unknown run); a key stays registered until its last run ends. `Bridge.register` returns the release.
- FIX: the engine's `update`, `input_delta` and `review` tool phases no longer end a tool pair early; only `result`
  (or `end`) does.
- Testing: the fake Gateway's runs are engine-shaped (`toolCallId`, `args`, `result`, `isError`; an `accepted` frame
  and, with `expectFinal`, a final frame with `agentMeta.usage`), and the model stub ends a reply asked
  `stream_options.include_usage` with a `STUB_USAGE` chunk (exported from `./testing`). `GatewayTransport.request`
  options take `expectFinal` and `onAccepted`.

## 0.1.4 (2026-09-30)

- Depends on @byokit/relay 0.3.0.

## 0.1.3 (2026-09-30)

- Depends on @byokit/relay 0.2.2.
- Depends on @byokit/link 0.4.0.

- Depends on @byokit/ui-core 0.3.0.

## 0.1.2 (2026-09-30)

- Preserve seed-based notice opening with @byokit/seal 0.2.0.

## 0.1.1

- Depends on @byokit/reach 0.3.0.

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
