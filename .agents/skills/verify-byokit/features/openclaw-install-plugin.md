# OpenClaw install a route's external provider plugin

Verification recipe for [external provider plugins](../../../../docs/runtime-kits.md) (5.7, B7):
`kit.installPlugin(pluginId)` installs the plugin a `needs_plugin` route names into the kit's own engine, at exactly
the engine version and the pinned npm integrity (`packages/openclaw/engine/plugins.json`), so Z.AI's GLM Coding Plan
routes become ready and `addKey` reaches the engine's key test.

## Sub-features

- Before: every Z.AI row is `needs_plugin`, `offer: false`; `addKey` on `zai-coding-global` is `not_included`.
- A shipped pin at another version rejects `PluginInstallError` `version`; a pin whose integrity differs from what the
  registry serves rejects `integrity` (the kit's install policy blocks before the package is fetched). Both leave
  `plugins.list`, `plugins.allow` and the kit's installed record unchanged.
- With the shipped pins, `installPlugin('zai')` resolves once the restarted gateway lists `zai` enabled at
  `2026.8.35`; `zai-coding-global` is `ready`, `offer: true`; `addKey` with an invalid key is `invalid`/`auth` from the
  engine's key test; a restart keeps it.
- The person's `~/.openclaw` is never read or written.

## How to get to it (user POV)

A person picks Z.AI's GLM Coding Plan; the app installs its plugin once, then the plan key sign-in works.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, run the public-entry consumer from the worktree root, holding the heavy-job lock:

```bash
feature=openclaw-install-plugin
entry=.agents/skills/verify-byokit/capture/openclaw-install-plugin.mjs
drive=(env PATH="/usr/bin:$PATH" BYOKIT_NPM=/usr/bin/npm node "$entry")
```

Use SKILL.md's Evidence capture block. It is live and needs no credential: the real pinned engine (an engine set is
prepared under the state dir unless `BYOKIT_TEST_ENGINE_DIR` names one), the npm registry, and Z.AI's key test refusing
`invalid-umer-test`; no spend. Set `BYOKIT_PROOF_ROOT` to a disk-backed directory when the OS temp dir is small. The
offline journey (the engine's three install-policy requests through the real policy) is
`packages/openclaw/test/kit.test.ts`.

## Gotchas

The tamper legs override what the kit reads from its shipped pin file in the consumer process (`fs.readFileSync` plus
`syncBuiltinESMExports`). Editing the pins inside the engine's `openclaw.json` does not work: that change restarts the
gateway, and the kit's next prepare writes the shipped pins back. The `~/.openclaw` watch is `inotifywait -r`; a
burst of directory `OPEN`/`ACCESS` events under `skills/` with no file access is another process's periodic skills scan
on this machine (seen with no drive running), not the kit. Under a mise shim, an isolated HOME breaks `npm`: put
`/usr/bin` first as above.
