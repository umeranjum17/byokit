# Changelog

## Unreleased

## 0.15.0 (2026-10-17)

- Dependency update: pins @byokit/secrets 0.5.2.
- Dependency update: pins @byokit/seal 0.3.1.
- Dependency update: pins @byokit/discover 0.8.4.
- Dependency update: pins @byokit/accounts 0.25.0.

- FEAT: turn on one chat channel. `channels.telegram: { token, allowFrom, member, onMessage }` (off by default) hands every Telegram direct message from the people you list to your app's `onMessage`, never to an engine agent: a message naming a helper, or a chat command such as `/new`, is just text for your handler. `kit.reply(chat, text)` answers the chat. Groups, chat commands and channel config writes stay off, and the bot token reaches the engine only as process env, never config, disk or logs. `fakeTelegram()` in `./testing` stands in for the Bot API.

## 0.14.5 (2026-10-17)

- FIX: adding a Go plan key that names no workspace (a bound service key the console refuses to list) now clears the standing workspace header before its probe, instead of carrying the previous workspace on its calls. A failed add's cleanup now drops the workspace header with the key, instead of leaving it behind for the next key.
- FEAT: `kit.installPlugin(pluginId)` installs the external provider plugin a route needs (`readiness: 'needs_plugin'`, such as Z.AI's GLM Coding Plan routes) into the kit's own engine, at exactly the engine's version and with the pinned npm integrity (`engine/plugins.json`). The plugin joins `plugins.allow` across restarts and `routes()` then reports its routes ready, so `addKey` reaches the engine's key test. A version or integrity mismatch rejects with `PluginInstallError` (`code: 'version' | 'integrity'`) and installs nothing; discovery never installs. The GLM Coding Plan sign-ins are subscription; the plain Z.AI key rows stay API key (billed per use), explicit opt-in.
- FIX: the install policy no longer blocks every `@openclaw/` npm plugin at its dependency-tree check; plugin installs are allowed only at a pinned spec and integrity.
- FIX: `removeAccount` and a cancelled/failed `addAccount` no longer resolve while the removed agent is still on the roster. The engine answers `agents.delete` before its roster hot-reload applies (the same lag as after `agents.create`), so an immediate `agents.list` could still show the gone agent and a cancelled ChatGPT add flaked as "the cancelled agent is deleted". Both delete paths now wait until the roster drops the agent (`untilUnlisted`, the `untilListed` mirror: 25 ms poll, ~5 s bound, plain error naming the agent on timeout). The fake gateway's `rosterApplyMs` now lags the delete roster the same way for engine parity.
- FIX: a Go plan key pasted over the link signs in with its workspace. The wizard sign-in listed no workspaces, so a key acting for several was refused on the activation probe and every run (403 Workspace selection is required). The sign-in now lists the key's workspaces the way `addKey` does (one used unasked; several asked through the same hidden paste; refused or unreadable listing fails before anything changes) and writes the pick as the provider header before activation.

## 0.14.4 (2026-10-17)

- Dependency update: pins @byokit/relay 0.8.0.
- Dependency update: pins @byokit/pair 0.10.2.
- Dependency update: pins @byokit/accounts 0.24.3.

- FIX: `routes()` now describes the engine the kit actually pins. The generated table was still built from the 2026.8.1 pin while `ENGINE_VERSION` is 2026.8.35, so every row said `source: "... (2026.8.1)"` and `revision: "2026.8.1"`. `scripts/gen-routes.ts` pins 2026.8.35 (upstream commit from `engine/patches.json`), reads manifest directories only (the 2026.8.35 source tree keeps an `extensions/.npmignore` file), and a new public-API journey test fails whenever the table names anything but `ENGINE_VERSION`. All 96 rows re-verified against the 2026.8.35 manifests: the choice set is identical (nothing added or removed); every row now carries `(2026.8.35)`.

## 0.14.3 (2026-10-17)

- Dependency update: pins @byokit/ui 0.9.0.
- Dependency update: pins @byokit/discover 0.8.3.
- Dependency update: pins @byokit/accounts 0.24.2.

- FIX: `addKey` for an OpenCode Go plan key with no `orgId` no longer saves a key whose every call is refused with `403 Workspace selection is required`. The add lists the key's workspaces first (`openCodeWorkspaces` from `@byokit/accounts/opencode-go`): one is used as the `x-opencode-org-id` header; several resolve the new `AddKeyResult` `{ status: 'needs_workspace', workspaces: [{ id, name }] }` for the app's pick (add again with `orgId`); a key the console refuses adds with no header. A listing that could not be read resolves `{ status: 'retry', reason: 'network' }` and changes nothing. An explicit `orgId` is used as before.

## 0.14.2 (2026-10-16)

- Dependency update: pins @byokit/relay 0.7.1.
- Dependency update: pins @byokit/accounts 0.24.1.

- FIX: `addKey` takes `orgId` for the Go live-catalog route and writes it into the engine's provider config (`models.providers['opencode-go'].headers['x-opencode-org-id']`) before the activation, so a multi-workspace login token is accepted — the engine's own probe and every run carry the header, and the first chat runs. The slot is provider-wide (shared by every member's key on one engine): a replacement key with no `orgId` keeps the standing workspace, `removeKey` drops it, and naming an `orgId` on a route with no workspace is refused `not_included`/`model` instead of silently dropped. Keys and workspace ids never reach logs, errors or views.

## 0.14.1 (2026-10-16)

- Dependency update: pins @byokit/ui 0.8.0.
- Dependency update: pins @byokit/discover 0.8.2.
- Dependency update: pins @byokit/relay 0.7.0.
- Dependency update: pins @byokit/pair 0.10.1.
- Dependency update: pins @byokit/accounts 0.24.0.

- FIX: when the engine answers a sign-in's cancel `cancelled`, `done` now also waits (up to 10 s) for it to free its setup admission, so a sign-in started right after is admitted instead of ending `why: 'busy'`.
- FIX: The kit now resolves `stateDir` to one absolute path through no symlink before it uses it. A native Claude CLI sign-in (`claude-cli`, browser or phone) with a relative `stateDir`, or one under a symlinked folder such as macOS `/tmp` or `os.tmpdir()`, failed with "The app supplied invalid account options." Engine paths the kit reports (for example the bridge socket and `identityPath`) now use that resolved path.
- FIX: `removeKey` (and `signOut`, which calls it for that provider) also drops the lane's `<provider>.key` index entry, so `accounts()` no longer lists a removed key; a scoped removal keeps another provider's entry.
- FIX: `pick` builds its live room/models reads from the filtered pick rows, so an Auto pick for a member whose only other account is the unnamed key lane makes no `models.list`/`models.authStatus` calls for the lane it never consults.
- FIX: the key-lane docs now scope the "no `<member>--<hex6>` per later key" claim to the `addKey` path; a plan key added with `addAccount` when the member agent already holds that provider still mints one `<member>--<hex6>` agent per key. The Choosing spec names the kit-only lane filter.
- The README states platform support: Linux and macOS x64/arm64 supported, Windows unsupported. CI runs the offline suite on macOS.

## 0.14.0 (2026-10-15)

- Dependency update: pins @byokit/accounts 0.23.0.

- FEAT: index the member's single API-key lane (`byokit-key-<member>`) as `<provider>.key` on `addKey` (replace-on-add, no `<member>--<hex6>` per later key), so bind sees key-held conversations, an API-billed binding continues on that lane, and a key lane is never an Auto or default-fallback candidate. A member-bound conversation with no indexed account ends signed-out with plain words (`auto.noneBound`). The key never reaches the index, logs or link.
- FEAT: `removeKey(member, o?)` removes a member's saved key (the `byokit-key-<member>` lane): its credential store and ready marker are cleared through `byokit.keys clear`, so `signedIn` is false and the lane stays signed out after an engine restart; `{ provider }` scopes it to that provider's saved key and no saved key is a no-op. `signOut(member, provider)` now also removes that provider's saved key, which the member-agent logout never reached (a Crewhouse user signing out of OpenCode Go was signed back in after a restart).
- FIX: the shipped `byokit.keys` handler answers `clear` for a member with no key lane with `{ ok: false, absent: true }` instead of refusing, so removing an unsaved key is a no-op rather than an error.
- FIX: `signedIn` still recognises a sealed key on `byokit-key-<member>` after an engine restart (key readiness no longer depends on the member-agent admission read succeeding), and `addKey` returns a thenable cancel handle that stops a pending add and clears any partial profile (`retry`/`busy`; no wizard.cancel).
- FIX: After `removeAccount` on a member-agent account (`authLogout`), a late token refresh that rewrites
  `state/agents/<member>` is dropped on the next `prepare`: the removal records the provider in the index's `dropped`
  list (parallel to account-agent `gone`), and the orphan sweep removes that provider's member-store auth profiles
  (JSON and native store) while no member-agent index entry names it again. A live subscription the index has not yet
  named is left alone, so listing can still synthesize it.
- FIX: `removeAccount` on a member-agent account restores the member's pre-sign-in primary model (stored as `priorModel` on the index entry when `addAccount` pins it), or clears the pin with `agents.update { model: null }` when there was none, so default-model runs work again after removal. A damaged or missing stored value still completes removal and falls back to clearing the pin. Account-agent removal is unchanged.
- FIX: A damaged `accounts/<member>.json` index now quarantines only that member: its agents are held back (never restored, swept or resealed away) while the other members restore, start and persist normally, the kit reports words `account.indexDamaged`, and a re-add rewrites a good index. A removed account's data still never returns through the gap.
- Start native Claude Code plan sign-in in the engine-owned folder through the existing paste/cancel handle and phone link adapter, then verify engine readiness and live activation before reporting done. For native Claude, phone sign-in readiness waits for the active drive and never hides a failed attempt behind native credential detection; other providers keep their signed-in readiness. ChatGPT device-code sign-in remains callback-free. SECURITY: the native Claude login child receives only PATH, HOME, LANG, TMPDIR and XDG_* from the engine, never the gateway token or bridge socket. Native and key sign-ins have one commit point, the `setup.activate` call: a phone cancel or an engine shutdown before it declines with no activation, the native drive (including during detection or with a ready native row) and the key paste alike, and a key paste nobody answers still ends at the paste timeout; after it a Claude cancel no longer changes the result, which is done once the restart is confirmed or says the sign-in was saved but the engine did not restart in time (`signin.savedNotRestarted`); a key cancelled during activation still declines and is cleaned up. `cancel()` always settles. A paste into a native child that already closed its stdin fails plainly instead of crashing the host, and engine `stop()` still stops and seals when an in-flight Claude reset fails. An already-ready row proceeds to detect/activate; persistent engine disagreement clears the stale ready row through Accounts, which deletes that folder's Claude login files (`.credentials.json`, `.claude.json`) but keeps the folder, then starts one fresh login.
- FEAT: `run({ thinking })` maps an unsupported thinking level to the nearest catalog-supported one that still reasons (rounding up: `low`/`medium` → `high` when a model only lists `off`/`high`/`max`), never silently to `off` unless asked; levels come from the registered model catalog (`compat.supportedReasoningEfforts` or `thinkingLevelMap`), and a model with no levels passes the asked value through. An ok end reports `thinking: { asked, used }`; `words('run.thinkingClamped')` is the notice when they differ.

## 0.13.0 (2026-10-14)

- FEAT: OpenClaw kit S8 `kit.removeAccount(member, id)`: a member-agent account goes through `models.authLogout` with its sealed profileIds, then an empty provider `list` (still listed stops with nothing dropped and says the account is still signing in), then its entry is dropped; an account agent goes through `byokit.accounts clear`, an empty `list` (a profile still listed after clear stops with nothing deleted and says the account is still signing in), `agents.delete` with `deleteFiles: false`, removal of its `<root>/state/agents/<agent>` dir, then the entry. Removal is refused `busy` while a run holds the agent and the member stays ready. On every `prepare` and after the sealed auth store restores, the kit removes each `<member>--<hex6>` state dir that a removal recorded as gone and no index names; a legacy member's own dir is never recorded and stays. `byokit.accounts clear` takes an optional `provider` that clears only that provider; a seal failure on a member-agent sign-in clears only that provider, and when that clear is refused the add reports failed with its credential still on the member agent.
- SECURITY: `kit.removeAccount` re-seals the live credential store at once while the engine runs, so `auth-store.sealed` and `auth-store.objects/` stop holding the removed profile immediately instead of keeping it until the next stop; a late engine write of the removed agent is swept on the next `prepare` or sealed restore. Durable removal tombstones also exclude late refreshes from stop-time sealing and prune removed-agent entries and objects from older sealed stores before restore.
- FIX: Changing the wrap mode (for example turning on dual wrapping) now reseals every engine store under the new mode on the next stop, including unchanged ones, so a later restore with the OS keyring locked opens them. Since 0.12.0 unchanged stores kept their old keyring-only wrap and that restore failed with `AuthStoreUnreadableError` (`invalid-snapshot`).

## 0.12.0 (2026-10-13)

- FIX: an unsealed API key that a failed `addKey` could not clear (the gateway refused the clear after a restart ran late) is now dropped at the kit's first ready after start, so it no longer stays in the member's `byokit-key-<member>` store until the next add. A key whose ready marker exists is never cleared, and a sweep the gateway interrupts runs again on the next ready.
- FEAT: An OpenCode Go plan key now runs every Go model, including `muse-spark-1.3-contributor` over the Responses API, with no model setup in the app. On each start and after `addKey`/`addAccount`, the kit asks the Go provider's own catalog hook (new plugin method `byokit.catalog`) for the live models. It registers each one with its `api` in `models.providers['opencode-go'].models`, so `models()` lists it and runs resolve it. It keeps each pinned Go model the live list omits, writes only when the list changed, never drops a registered model, and leaves the provider alone when `KitOptions.config` sets that list. Each model gets the endpoint the pinned engine routes, `https://opencode.ai/zen/go/v1`, not the live catalog's `inference/go/v1`, which the pinned engine refuses with `missing x-opencode-session`.
- CHANGE: `run({ auth: 'apiKey', model })` accepts any model of the saved key's provider, not only the model saved at activation. Another provider still ends `plan`, now with the message "Choose a model of the provider saved with this key."
- FIX: `signedIn(member, provider)` is true after `addKey` for that provider: it also counts a ready key whose saved model is that provider's. `providers(member)` still lists only the member's own sign-ins, the ones a run without `auth: 'apiKey'` uses.
- FIX: an OpenCode Go plan key now sets up and runs on the pinned engine. `addAccount(member, { authChoice: 'opencode-go' })` (and `signIn` for any key-entry choice) asks for `Plan key` and pastes it into typed `openclaw.setup.activate { kind: 'api-key' }` instead of the setup wizard, which refused it ("That provider setup is not available on this Gateway."); a key-entry failure shows only the kit's words, never the engine's text. The plan key is sealed on the member agent (`seal { planKey: true }`: subscription billing). With a spawned engine, when the activation changes config `auth`, `done` waits out the gateway restart that causes (within 60 s); past that the sign-in ends `why: 'failed'` ("the engine took too long to restart") and is cleaned up, so nothing half-set-up is kept; `addKey` does the same and returns `retry`. A run started on done uses the new sign-in. The kit now writes `agents.defaults.modelPolicy = {}` unless the app sets a policy, and drops a saved `allow: ['openai/*']`: left unset, the pin turned the kit's `models` map into that allowlist and every non-OpenAI model fell back to openai. Discovery follows the engine: a key-entry choice without `appGuidedSecret`, or a login choice without `appGuidedAuth`/`appGuidedDiscovery`, is `no_upstream_flow` and never ready (22 routes at 2026.8.1, 15 of them new here, among them `fal-api-key`, `vllm`, `sglang` and `custom-api-key`; the 15 new no-upstream-flow choices are `fal-api-key`, `vllm`, `sglang`, `custom-api-key`, `alibaba-model-studio-api-key`, `clawrouter-api-key`, `cloudflare-ai-gateway-api-key`, `comfy-cloud-api-key`, `copilot-proxy`, `longcat-api-key`, `microsoft-foundry-entra`, `microsoft-foundry-apikey`, `pixverse-api-key`, `runway-api-key` and `vydra-api-key`); the engine job checks every ready and absent choice against the real Gateway. The pinned engine already sends OpenCode Go's required `x-opencode-session` (stable per conversation) on the activation probe and every run (kits before 0.10.0 pinned an engine without it); the engine job asserts it. The README and spec say how an app registers a live-only Go model such as Muse (`config.models.providers['opencode-go']`, `api: 'openai-responses'`).
- FIX: Key-agent creation waits for the published roster before activation. `addKey` now waits for catalog synchronization and prepares the full-catalog owner once before success; preparation failures clear the attempted key and return a secret-safe `retry`/`engine`. A chosen live-catalog model must be in the engine's registered list before the key is sealed, or the add returns `retry`/`model`. Ordinary runs do not gain a cold refresh.
- FIX: `addKey` accepts a catalog `model` for the Go live-catalog route and saves it for key-lane runs; `models(member, { authChoice })` lists that route's live catalog once a key is saved (empty before, with no agent queried), including Go Muse. Only an available row from that key lane can be selected; ordinary-member discovery is never used.
- `addKey` now returns a typed `{ status, reason? }` result instead of a string, so callers compare `result.status === 'ok'` (migrate `result === 'ok'`). `invalid` now only means the provider refused the key (`auth`), its billing refused it (`billing`), or the key was blank (`empty`); unsupported routes and unknown models are `not_included` with `model`; every other failure is `retry` with `network`, `inference`, `engine` or `busy`. A member that is not your own now throws `Choose your own member.`, as `ensureMember` does, instead of returning a result. `model` is accepted only for the Go live-catalog route: on any other route it returns `not_included`/`model` before activation, and `models(member, { authChoice })` lists nothing for them. Failures never contain keys, key fragments, headers or raw engine diagnostics.
- FEAT: OpenClaw kit S7 `kit.addAccount` identity merge: a sign-in whose identity (`who`) matches another account of the same member and provider moves into that account and `done.id` names it, so signing in again as the same account refreshes its row instead of adding one, whatever email it now reports and whatever `again` names. `again` with another identity adds a row and leaves the named account billing as before. A sign-in with no identity never merges, even with the same email. When several older accounts share an identity, the earliest added one takes the sign-in. The identity never appears in `accounts()`, views, errors or logs.
- FEAT: OpenClaw kit S11 session binding: every run first finds the account its session is bound to (an account agent's key, or the agent of the member's that holds `agent:<that agent>:<tail>`, found with `sessions.resolve { allowMissing: true }`, member agent first), so a later run on one app key stays on that account. A key bound to an account agent resolves `'auto'`, `'default'` and no account to it, and refuses another id (`code: 'bound'`, words `account.bound`); when that account bills per use, anything but its own id is refused (`code: 'paid'`, words `account.paid`); a key bound to the member agent chooses only among its own accounts. Refusals end `kind: 'other'` after the binding read and before any room, model or agent request (one account listing when the index is cold); an `auth: 'apiKey'` run continues only an API-billed conversation (other bindings refuse with `account.bound`), and a conversation holding no account names `another account`. New `kit.pick(member, sel, { sessionKey })` returns exactly what `run` would decide with that key, `considered` included. `run` accepts a member's account-agent key; `steer`/`abort` map a live run's app key to its engine key. With no account agents, runs ask nothing more.
- FEAT: OpenClaw kit S12 `kit.move({ member, sessionKey }, to)`: a conversation moves to another account. Its whole transcript (user turns, tool calls and results) forks onto the target account's agent with `sessions.create { fork: true, parentSessionKey }`, never `chat.history` plus `chat.inject`, under both agents' exclusive locks; then the source session is deleted only if it is still the session read (`expectedSessionId`, `expectedSessionUpdatedAt`). It answers `{ ok: true, session: 'agent:<target>:<tail>' }`, and the next run on the app key continues there. `unsupported` when the conversation is found nowhere, `busy` while a run is live on it (the kit's own runs or the engine's `hasActiveRun`), `start_failed` when the target is not ready or the engine refuses the fork (the source untouched), `close_failed` with `live` = the new key when the source cannot be deleted (both kept). A move within one agent forks nothing and answers its own key. A session already under the target key refuses the move `start_failed` (`move.taken`), the source untouched. A run that waited for its agent's lock across a move binds again under the lock and ends `{ ok: false, kind: 'other' }` (`run.moved`) before any event, so it never runs on the deleted key; a member-path run on a bound key now holds the member agent's shared lock. New words `move.unsupported`, `move.busy`, `move.notReady`, `move.closeFailed`, `move.taken`, `run.moved`. The fake gateway keeps per-session transcripts and serves `sessions.list` (`hasActiveRun`), `sessions.create { fork }`, `sessions.delete` and `chat.history`.
- FEAT: OpenClaw kit O14m attribution and link/device account frames: one member-attribution rule, the kit's `memberOf`, maps an indexed `<member>--<hex6>` account agent and its session keys to `<member>`, and approvals, the bridge and the link adapter all use it instead of one copy per file. Link `oc.events`/`oc.sessions` carry an account agent's rows and events under its member, link `oc.run` accepts `account`/`needs` and streams the account frame first, and the device client sends `account`/`needs` and refuses a misshapen session key on `oc.run` before any request. An unindexed account-shaped agent maps nowhere, so it stays unreachable through events, sessions, approvals, steer/abort and bridge attribution, and `addAccount` refuses key material outright (keys stay host-only).
- FIX: a paired device can sign in to an offered plan key (OpenCode Go) over the link. `oc.signIn.start('opencode-go', via)` no longer refuses with `This device can't do that.`: `routeFor` serves the provider's offered plan-key route whichever `via` the device asks, the host's `kit.signIn` asks `{ prompt: 'Plan key' }`, and `oc.signIn.paste` carries the key only inside the sealed link frame to the host, which activates and keeps it. No view, state or run frame sent back holds the key; a refused key shows only the kit's words.

## 0.11.1 (2026-10-12)

- Dependency update: pins @byokit/discover 0.8.1.
- FIX: (from @byokit/discover 0.8.1) `browse()` and `scan()` accept resolved services whose `fullName` carries the service type without a trailing dot (`host._type._tcp`, as Android's react-native-zeroconf delivers) or with a trailing `.local` domain suffix, case-insensitive, instead of only the `host.local._type._tcp.` shape. Android phones now discover computers over mDNS instead of always scanning empty.

- FIX: restoring an engine home no longer rewrites a live file whose bytes already match the sealed object. `restore()` compares each decrypted object against the live file at the restore mode (0600) — size first, then bytes — and skips the temp write, file fsync, atomic rename and directory fsync when they match, so a start over an untouched tree pays no per-object writes. A missing, changed, different-mode or unreadable file restores exactly as before, and a skipped file changes nothing on disk, so the crash-durability contract is unchanged; nothing new is written to disk.
- FEAT: OpenClaw kit S5 account spine: per-member `accounts/<member>.json` index (0600, atomic, no email/token/engine line) behind `kit.accounts`, `renameAccount` and `defaults`/`setDefaults`; a pre-O14 sign-in synthesizes an `addedAt: 0` entry, a default naming a removed account drops on read, and an unindexed `<member>--<hex6>` agent is never listed. `src/locks.ts` adds the per-agent shared/exclusive/live locks later steps use for runs, removal, moves and sealing.
- FEAT: OpenClaw kit S6 `kit.addAccount(member, { authChoice, via?, name?, again? }, on)`: a member's first sign-in of a provider stays on its own agent, and each further one (or `again`) gets a new sealed agent `<member>--<hex6>` (drawn again on a collision) with account id `<provider>.<hex6>`, its index entry written before the agent and IDENTITY.md kept byte-identical. The ChatGPT authorize URL carries `prompt=login` so a second account can be chosen; the row reads `signing` until the sign-in ends; `done` comes only after the agent is sealed to that one sign-in and its `who` hash is indexed; a sign-in that fails, ends busy or is cancelled removes the new agent and its entry. `authChoice: 'openai-codex'` (the engine's id for ChatGPT) signs in on the `openai` route.
- FEAT: OpenClaw kit S9 Auto input: `kit.models(member, id)` maps the account provider's `models.list { agentId, view: 'default' }` rows to `provider/model` (`missing-auth`/`auth-failed` → `why: 'signed_out'`, `cooldown` → `why: 'resting'` with `until = unavailableUntil`), and `kit.room(member, id, demand?)` reads the `models.authStatus { agentId }` row for the provider's tightest applying usage window (`left`, `span`, `resetsAt`; no `at`, no kit cache, unknown for API-key accounts and unanswered reads). Both hold the account agent's shared lock for the read. The fake gateway serves `models.list { agentId }` per agent and a cold per-provider usage cache (`setUsage`; no `usage` on the first answer carrying the provider).
- FEAT: OpenClaw kit S10 account runs: `kit.run({ member, sessionKey, account: 'auto' | 'default' | id, model?, needs? })` picks one account once, before any request (Choosing, 5.15), checks its own sealed sign-in with `byokit.accounts ready` and runs on its agent; an unbound key that picks an account agent runs as `agent:<account agent>:<tail>`. The first event is `{ type: 'account', account, model, sessionKey, how, why, considered }`, an ok end carries `account` and `model`, a chosen account that fails its ready check ends `signed-out` after its account event, with no agent request (Auto skips such an account for the next one), an empty pick ends `signed-out`, a missing model ends `plan`, and a resting end writes `until` (now + 5 min when the message names none) so the next Auto skips the account. `needs` alone resolves as `account: 'default'`; with `account` absent and `needs` absent or empty a run is unchanged. Account runs hold the agent's shared lock to their end, and index edits now take their own per-member lock, so a live run never blocks a rename or a listing. A model the engine reports unavailable only because its account is signed out or resting still counts as that account's plan. Session binding arrives in the next step.

## 0.11.0 (2026-10-12)

- Dependency update: pins @byokit/ui 0.7.0.
- Dependency update: pins @byokit/secrets 0.5.1.
- Dependency update: pins @byokit/discover 0.8.0.
- Dependency update: pins @byokit/relay 0.6.1.
- Dependency update: pins @byokit/pair 0.10.0.

- FEAT: `byokit.accounts` seals an agent's own sign-ins (list/seal/ready/adopt/clear), loaded as the `plugin/accounts.js` gateway method; a failed `adopt` rolls the model and both profile stores back so no partial move or dangling pin survives, a self-adopt is refused, and the fake gateway mirrors every branch.

## 0.10.0 (2026-10-11)

- Dependency update: pins @byokit/discover 0.7.0.

- FIX (behavior change for installs with two or more members): a member no longer runs on another member's sign-in. The kit now forces `agents.defaults.authInheritance.agentId = 'byokit-base'` on every boot and config patch, an id it never creates, signs in to or runs, so the inherited base every agent reads through is empty. Before, the pinned engine made the first agent the inherited owner once a second agent was created; while an install's shared auth store had not yet moved into `state/openclaw.sqlite`, every later member's turns read that member's sign-ins through. From this release a member runs only on its own sign-ins: one that never signed in reads signed out, and an explicit pick of a provider it is not signed in to ends `{ ok: false, kind: 'signed-out' }` before any model request. `signOut(member, provider)` now passes `models.authLogout` the `profileIds` of that member agent's own profiles; without them the engine removed the provider from every owner store, the shared or inherited store other members read included. With none of its own it sends nothing. New members follow D9 (`/^[a-z](?!.*--)[a-z0-9-]{0,23}$/`, never starting `byokit-`); a member that already exists under the older rule, such as `a--b`, keeps working. `main`, `openclaw`, `crestodian` and `byokit-base` are never a member, even though `main` exists on every install: `ensureMember('main')` used to hand back the engine's own agent. The kit's fake gateway lists one `<provider>:default` profile per signed-in provider and checks `profileIds` on sign-out.
- FIX: restoring an engine home no longer pays one directory fsync per sealed object. `restore()` writes each plaintext file exactly as before (temp write, file fsync, atomic rename) but records the directories whose entries changed — the containing directory of every restored file and the parent of every directory it creates — and fsyncs each distinct directory once, after all files are written and before it removes the `restoring` marker. Every restored file is content-durable, and each rename and new directory entry is durable before the marker goes, so a crash mid-restore still keeps the sealed store intact. `seal()` and the stop path keep `put()` and its per-file directory fsync, byte-for-byte unchanged; nothing new is written to disk.
- FIX: A large engine home can no longer abort the process at seal time. AuthStore.collect() stays narrowed to credential state (credential paths under `state` plus non-cache `home` paths; tool caches are skipped; other `state` stores are sealed as objects outside the cap), and saved sign-in data is capped: over the fixed limit, `prepare()`, `start()`, `stop()` and an engine exit reject with exported `AuthStoreSealSizeError` (`code: 'auth-store-seal-size'`, fields `size`, a lower bound at the refusal, and `cap`). On that refusal the last good saved store is kept as it was and no live file is deleted; nothing else is promised. The kit reports `{ phase: 'failed', why: 'auth-store-seal-size', sealSize }` with words giving the size and limit in MB, and a refused `stop()` still releases the lock. `@byokit/secrets` encrypt() also emits its envelope through bounded chunk-wise escaping instead of a second full-size `JSON.stringify`, so `encrypt()` builds no snapshot-sized JSON string; the envelope is assembled as bytes, still transiently two byte copies. The README's include rule replaces the former "auth-store seal size demand" known limitation.
- FIX: an engine store that is already sealed unchanged in this process is no longer resealed on `stop()`, `prepare()` or an offline migration. `AuthStore` keeps an in-memory `object file name -> sha256 of the sealed plaintext payload` map, filled by `restore()` from each object it decrypts and refreshed after every successful per-object `seal()`; `sealObjects()` skips a re-seal when the object's plaintext hash is unchanged and its sealed file is still on disk, so the encrypt, verify decrypt and fsyncs are not repeated for transcripts and media the engine left alone. A changed object, a new object and a fresh process (empty map) seal exactly as before. The map is memory-only: no hash, size or mtime is written to disk or logs, so the at-rest contract (no plaintext, no new on-disk metadata) is unchanged.
- FIX: the credential seal no longer carries engine transcripts or other non-credential state. Credential files under `state` and `home` still go into the bounded `auth-store.sealed` blob, but every other file under `state` (the shared and per-agent SQLite databases with their WAL/SHM/journal sidecars, exported transcripts, legacy session stores, media, delivery-queue media, logs, caches and tmp) is sealed as its own encrypted file under `auth-store.objects/`, outside the 128 MiB total, and restored byte for byte on start; a single such file over 128 MiB refuses with `AuthStoreSealSizeError` naming it. After stop and remove no plaintext copy of those `state` files remains; regenerable caches under `home` stay on disk unsealed. A host whose transcripts and databases alone pass the cap now starts and stops normally instead of refusing with `AuthStoreSealSizeError`. Existing v1 snapshots that hold engine stores restore and reseal in the new layout. Rolling back to a kit older than this release keeps the blob credentials but not the engine databases (they are now objects), so the user signs in again. An over-cap engine store now reports its file name in the kit's refusal state, not as sign-in data.
- FIX: the engine is pinned to the OpenClaw 2026.8.35 extended-stable line, down from 2026.8.1 (and gateway-client back from the 2026.9.6 dependabot bump); `ENGINE_VERSION`, the shipped `engine/package.json` + integrity lock, `@openclaw/gateway-protocol`/`@openclaw/gateway-client` and the generated tables all carry 2026.8.35. The provider auth surface is byte-identical to 2026.8.1 (verified per-extension), so the route table is unchanged. Compatibility the new pin needs: the Workshop usage seam is matched by its stable filename prefix (the content hash changes per release), the pending package-lifecycle marker is completed with upstream's own postinstall while the set is writable (plugin installs disabled), and `openclaw.setup.activate.start` is registered in the runtime method table.
- FEAT: `@byokit/openclaw` names the multi-account shapes its later account surfaces build on — `Account`, `AccountId`, `AccountRef`, `SignInState`, `Room`, `RoomSpan`, `ModelInfo`, `RunSelection`, `Defaults`, `Considered`, `PickWhy`, `AccountPick` and `MoveResult` — restated structurally from `@byokit/accounts` (never imported), including the kit-only `bound`/`paid` failure states. The section 5.15 account words (Auto choice, room, pick explanations, reading age and the `account.*` refusals) join `words.json`, so they flow through the exact-sentence and plain-words tests.
- FEAT: `@byokit/openclaw` exports a pure start-of-run picker — `consider`, `chooseAccount` and `resolveSelection` — restated structurally from `@byokit/accounts`' `multi.ts` and never importing it. `resolveSelection` resolves `{ account: 'auto' | 'default' | id, model, needs }` with an optional kit-only `bound` list of the accounts a conversation may use, returning an `AccountPick` with its `considered` rows. Accounts outside `bound` are never candidates (a default outside `bound` is treated as not ready, its row `out: 'bound'`), and an explicit signed-out id in `bound` is returned as chosen and never replaced. The shared `fixtures/conformance/auto-pick-typescript.json` gains the kit-only bound rows, which `@byokit/accounts`' `multi.test.ts` skips.
- FIX: a failed engine install or post-build verification now retains a size-capped, environment-free diagnosis at
  `<stateDir>/logs/engine-install-drift.json` before the failed temporary set is deleted: the first failed
  root-manifest or package check (its path, expected vs actual version, or the read error), the npm path and
  version, and the npm stderr tail. Previously the temp was deleted with the comparator's reason swallowed, so a
  natural `drift-after-build` failure could not be diagnosed after the fact.
- FIX: explicitly offered sign-ins such as OpenRouter are no longer blocked by the engine plugin allow list. `KitOptions.offered` names the accounts an app offers; the kit adds the plugin of every route those name to `plugins.allow`, so an opted-in sign-in is not a dead end.
- FIX: the kit's `classify` now reads the ChatGPT/Codex "Next reset in N min/minutes/hour/hours" wording as well as "try again in ~N min/h", so `RunEnd.until` carries the stated reset for a subscription refusal instead of being empty; wording with no number stays without an `until` for the app's fallback.
- Dependency update: depend on `@byokit/pair` 0.9.0 instead of its deprecated `@byokit/link` shim.

## 0.9.0 (2026-10-09)

- Dependency update: pins @byokit/relay 0.6.0.
- Dependency update: pins @byokit/link 0.8.0.
- SECURITY: (from @byokit/pair 0.9.0) pinning and approval semantics. A compact QR's pending grant pins the key the code handshake authenticated, kept after Noise message 2 and before the device's identity goes out in message 3; if saving it fails, pairing stops before the computer learns the device. A device using `onPending` says so inside the handshake, and only then does the computer keep a yes given after its socket dropped, granting only the device key that handshake authenticated; any other device that leaves still gets no grant. A computer with another key at the same address is still refused, and a version 1 `pendingGrant` refuses a `host` that differs from its QR.
- FIX: (from @byokit/pair 0.9.0) a phone killed while the person at the computer decides now resumes against the pinned computer, for compact and version 1 QRs alike. `pairWithOffer` takes `onPending(grant)`, which hands over the pending grant to keep before the computer can approve this device, and `pendingGrant` accepts a compact QR given the authenticated `host` key, and `parseOffer` reads a compact QR for inspection (expiry, addresses, name, role) without one. Before, `pendingGrant` refused compact QRs, and even a version 1 pending grant never came online after a real kill. A socket that drops once the computer has taken the code now ends pairing with `unreachable` instead of trying the next address, where the spent code or ticket could only be refused as `wrong-code` or `expired`. A socket that closes while `onPending` is still saving ends pairing at once with that close; a version 1 `onPending` that never settles times out. The compact QR is unchanged: 109 characters for one relay address and the name Umer.
- FIX: (from @byokit/pair 0.9.0) the pairing picture's words match what the host now prints: scan the code, or type the shown code where the phone page asks for it, with no raw address to type.
- FIX: (from @byokit/pair 0.9.0) the browser pairing test closes only the Chromium processes it spawned — over that browser's own private CDP pipe — instead of signalling a whole process group, so a killed or timed-out test can no longer take out or leave behind the wrong process tree. `BYOKIT_CHROME` is the single documented key that selects the test browser.

- Cut first-install wall time ~3x (freeze ~20x) by dropping the 37,999 per-entry `fsync`s from `freeze()`: entries are chmodded read-only in bounded batches, one filesystem-wide `sync -f` flush runs where available (Linux, ~2 s measured vs ~110 s of per-file fsync transactions), and the manifest is read from the built tree once. Durability rule: `docs/runtime-kits.md` 5.16.
- FEAT: Name the engine's learning switch: `learning()`, `setLearning(mode | 'default')` and `restoreLearning(captured)` over the config key `skills.workshop.autonomous.mode` (`off | propose | auto`, engine default `auto` when absent), as a typed, file-backed veneer on the one-key pair — valid on a stopped home, before boot and after `stop()`. Absence is a value (`{ present: false }`); an unknown mode throws listing the accepted values, a stored value outside the enum makes `learning()` throw naming it, both writers throw when `KitOptions.config` also passes `skills`, and `restoreLearning` reads back and throws on mismatch. The README also documents the supported repair of a retained home killed without `stop()` (orphan gateway, stale lock, reseal, exit-78 doctor repair) and cross-references the separate auth-store seal size bound.

## 0.8.0 (2026-10-09)

- Forward actual thinking-token progress and report Gateway acceptance as `started`; reuse bounded, file-witnessed member admission status so ready runs avoid redundant sign-in checks without skipping authority checks. Device state uses the same live readiness boundary; `providerStatus` preserves unknown versus empty sign-in status.
- FIX: On the Claude CLI route the printed `## Tooling` list now uses the Claude wire catalog names (`mcp__openclaw__<tool>`), so a listed tool can be called exactly as printed. Every other route keeps the stock prompt byte-identical, and already-prefixed names are never prefixed again.
- The deprecated `anthropic` provider alias on route `anthropic-cli` stays readable as `route.deprecatedProvider` (`'anthropic'`); its removal moves to 0.9.0.
- FIX: `OpenClawKit.abort` always returns a Promise, including after an engine drop; cancellation failures remain catchable without changing healthy abort results.
- FIX: `ensureMember` resolves only once `agents.list` shows the member (bounded ~5 s wait, then a plain error naming the member), so a turn sent right after it is no longer rejected as `unknown agent id` while the engine hot-reloads its roster.

## 0.7.0 (2026-10-08)

- FIX: Unreadable sealed sign-ins now fail closed with `AuthStoreUnreadableError` and recovery words, leaving `auth-store.sealed` byte-identical for original-key or backup repair and retry instead of starting signed out with a replacement store.

## 0.6.3 (2026-10-07)

- Dependency update: pins @byokit/relay 0.5.3.
- Dependency update: pins @byokit/link 0.7.1.

- FIX: Route `anthropic-cli` now reports provider `claude-cli`, the id `signedIn`, `providers()` and runs already use for a Claude Code login, so `kit.signedIn(member, route.provider)` answers true once Claude Code is signed in. **Deprecated:** the old provider `anthropic` on this route; it stays readable as `route.deprecatedProvider` (`'anthropic'`) through 0.7.x and is removed in 0.8.0. Match this route by `provider === 'claude-cli'` (or by `choice === 'anthropic-cli'`). The route id `anthropic:cli:anthropic-cli` is kept through 0.7.x and becomes `claude-cli:cli:anthropic-cli` in 0.8.0; choice `anthropic-cli` and the `{ provider: 'claude-cli', via: 'browser' }` link selector are unchanged. `anthropic` remains the API-billed provider only: a Claude Code login never makes `signedIn(member, 'anthropic')` true.
FIX: Engine start on macOS no longer sticks on a dead-but-unreaped guard process. `pidAlive` detects zombies portably — `ps` state where there is no `/proc` — instead of Linux-only `/proc`, so a stale guard reads as stopped and start can recover. A live pid still reads as owned, an invalid guard still reads as ambiguous, and anything unexpected from the probe keeps the guard. Linux answers are unchanged.
- FIX: Code sign-ins whose pinned engine prints the code only into a note now hand the caller the code, link, expiry (`expiresAt`) and instructions (`message`) in the same `SignInView` shape as structured codes, and wait out device approval instead of failing with `gateway request timeout for wizard.next` after two minutes.
- The O16 day-usage engine tests no longer fail when a run straddles UTC midnight: a case that could still be running at midnight starts just after it, so the day (and month) it reads is the day its engine stamps charges in.
- The `relay` option takes anything with `RelayClient`'s `notify`, so a host can hand the kit a relay it opens after `Host.open` (the client needs the open host). A `RelayClient` still fits; behaviour is unchanged.
- FIX: The sealed credential store is written as `v: 1` again. 0.6.2's `v: 2` tag made every earlier kit (through 0.6.1) refuse an intact store with `invalid sealed credential store`, so a host rolled back to an earlier kit could not start and lost its saved sign-in. `v: 2` stores still restore and re-seal as `v: 1`.
- A saved store the key cannot open (a different key, damaged or tampered bytes) or whose payload is not a credential snapshot no longer blocks engine start: it is kept as `auth-store.sealed.unreadable-<ms>` (never overwritten or deleted), the engine starts signed out, and the kit reports `{ phase: 'ready', why: 'sign-in-reset' }` with the words "Your saved sign-in couldn't be opened, so it was kept aside. Sign in again." until a sign-in through the kit completes.
- FIX: Every wizard `text` step now reaches the caller as `SignInView.prompt`, not only sensitive ones. A non-sensitive step shows the engine's question as written (`github-copilot-enterprise` asks for the Enterprise domain first), so the sign-in no longer waits 15 minutes on a screen with nothing to answer. Once a step is sensitive (or the choice is `setup-token`), the prompt stays the fixed `Sign-in token` label and no gateway prose is shown, as before.
- FIX: `setup-token` is no longer offered. The pinned Gateway has no app-guided sign-in for it and refuses every attempt with "That provider setup is not available on this Gateway.", so it is listed with `readiness: 'no_upstream_flow'`, the link no longer maps `{ provider: 'anthropic', via: 'browser' }` to it. `plugins.allow` now holds the plugin of every default-eligible bundled route rather than only the ready ones, so `anthropic-cli` and `apiKey` keep the `anthropic` plugin allowed without app config.
- The R1 restart-recovery probe accepts both restart-time gate denials for the unowned recovering session (HEAD's `unknown run` and the published kit's `can't check this action right now`); any other transcript text still fails the denial assertion.

## 0.6.2 (2026-10-05)

FIX: The browser broker now holds its CDP endpoint back until Chromium's initial tab exists, so `/json/list` can never serve an empty browser to an attaching engine on a cold or slow start; a browser that never lists a tab fails the launch honestly instead.
- Remove the fake Gateway's own happy-path self-tests for default member/auth and the device-code wizard script from `test/fake.test.ts`. They asserted the synthetic fixture's own response shapes and exact number of progress pulls, not product behaviour. Member creation, caching and validation, device-code sign-in through `kit.signIn`/`kit.signedIn`, `health` pass-through and sign-out remain covered by the shared public consumer contract (`src/testing/contract.ts`) and the packed Chromium journey in `examples/openclaw-kit/e2e.test.ts`. Every negative, cancellation, denial, gate, drop and refusal assertion is kept unchanged, and no test was added.
- The quickstart's example output is what the example actually prints today: the offered-route list was stale
  (it still showed `anthropic-cli` and a browser `setup-token` and missed `opencode-go`). The block is now the
  real output of the runnable fake-Gateway example, followed by a "read next" pointer to the run contract, the
  kit example and SECURITY.md.
FIX: The sealed credential store now seals credential state only — the complete `state` tree plus config/credential paths under `home` — instead of the whole engine home, so a real signed-in home with tool caches no longer produces a sealed payload past the runtime string limit and aborts boot. Regenerable caches, transcripts and logs (`home/.cache`, `home/.npm`, and the `sessions`/`log`/`cache`/`.tmp`/`history.jsonl` subtrees of `.codex`, the `projects`/`todos`/`shell-snapshots`/`statsig`/`file-history`/`history.jsonl` subtrees of `.claude`) stay on disk unsealed; unknown `home` paths stay sealed. The sealed payload is built exactly once and verified by decrypting the sealed bytes. Existing `v: 1` snapshots still restore completely and re-seal once as `v: 2` with a log line; no credential is ever dropped.
- Every type an entry hands a caller is now nameable from that entry, and none of them carries `any`.
  `.` exports `GatewayMethods`, `RouteView`, `RouteFacts`, `JsonValue`, `UsageClient` and `DayUsageClient`;
  `./device` exports `OpenClawDevice` and `DeviceEndFrame`; `./link` exports `OpenClawLinkOptions`,
  `OpenClawLinkHost`, `OpenClawServeOptions` and `OpenClawServeHandle`; `./testing` exports `FakeGateway`,
  `FakeHandler`, `FakeParams` and `StubRequest`, types `fakeGateway`'s script per method, and records each
  stubbed request as a typed `StubRequest` instead of `any`. An app can write its own generic wrapper over
  `call` and annotate what `routes()`, `openclawDevice()` and `openclawLink()` return without a cast. The
  Gateway slots the pinned engine does not declare stay `unknown` and are listed per release in
  `src/generated/report.json`; the README now says so beside the API table.

## 0.6.1 (2026-10-04)

FIX: Let apps declare `appOwnedSessions.keyPrefixes` before Gateway startup so caller-requeued task sessions do not also receive an engine-started recovery turn. Preserve session history, policy gates, API-key session mapping and stock recovery for other namespaces.
FEAT: Add the internal pipe-only browser broker with fenced private targets, lease-bound live sessions and exact-origin site-data clearing. Sign-in handoff remains unprotected until parked-session protection is qualified.
FIX: Launch each broker's Chromium with its own short mode-0700 temp directory under the caller's temp directory, removed on close, instead of using the profile path as TMPDIR; deep app profile paths overflowed Chromium's singleton socket path and aborted startup.
FIX: A controlling viewer ignores frames from a previous target and drops input until the current private target has delivered its first image, so popup switches cannot map input with stale coordinates.
FIX: The broker's browser endpoint and `/json/version` now use Chromium's canonical `/devtools/browser/<id>?token=` shape, so the pinned engine's CDP discovery finds `/json/list` instead of failing with HTTP 404; token, host and origin guards are unchanged and the old bare path is refused.
FIX: Chromium's sandbox stays on; a launch refused for no usable sandbox (for example where unprivileged user namespaces are disabled) now fails with typed `BrowserSandboxUnavailable` instead of a generic failure, and is never retried unsandboxed. Startup stderr is used only in memory for that check.
FIX: Wire opt-in member browsers to the shipped bridge and stock engine, with a dead default profile, member-pinned browser actions, kit browser invalidation events and scoped browser-engine checks. Sign-in handoff remains `handoff-unprotected`; no recovery-protection or automatic resume redispatch claim is made.
SECURITY: Register the published awaited OpenClaw/Codex tool-result middleware, scrub owned broker capabilities before live model feedback, recheck session admission per result, and terminate on refusal or unavailable protection. Transcript hooks are supplementary; actual full privacy/recovery qualification remains pending.
FIX: Honor the stock allow/alsoAllow schema, create model-free audit sessions for effective-tool checks, and acknowledge redacted CDP profiles only against an unchanged exact host-owned endpoint and matching applied-source revisions.
FIX: Explicitly clear hostile node selection across the stock hook's shallow parameter merge; browser proof fixtures distinguish normal model completion from successful tool execution.
SECURITY: A definite failed sign-in resume no longer permits arbitrary recovery turns: replacement requires a fresh live kit registration matching the exact engine run id and session, revoked on release or bridge shutdown. Source controls cover parked and every unproved resume state; actual engine qualification remains pending. Reconnect keeps tool subsets but revokes submission authority, and waits for old Unix socket teardown before rebinding; shutdown cancels outstanding calls.
SECURITY: Browser use requires a closed explicit safe tool policy across every engine agent, account agent and delegate; unsafe and unknown effective tools refuse every browser, model-facing profile management/evaluation is blocked before app approval, and raw agent/plugin/config policy mutations require the guarded config path.
- FEAT: Portable types for the browser sign-in handoff and live view (`NeedSignIn`, `BrowserState`, `LiveViewState`, `BrowserHost`, `BrowserDevice` and friends) from `.` and `./device`, per spec 5.17. Types only: no runtime ships yet, and handoff stays refused until parked sessions are protected.
- Allow the internal browser host to attach newly created owned-member browsers and replace exact owned endpoints with stale-identity guards, private-target cleanup barriers and read-only versioned bindings for guarded configuration publication. Request bounded thumbnails through the owned viewer. Production sign-in handoff remains blocked pending qualification.
- Add the internal browser handoff host, durable settlement and conservative resume bookkeeping, with offline synthetic fixtures. Production sign-in remains blocked pending recovery-protection qualification.
- Add member-scoped browser sign-in actions, private browser live view and portable device helpers. Browser frames and lease capabilities travel on transient encrypted streams, outside durable link answer caches; control requires the host's immediate grant-revocation seam. Watching or reconnecting never dispatches a model run.
- FIX: Preserve browser reply and event order when messages arrive together, so page evaluation can receive its initial context instead of waiting indefinitely.
SECURITY: Ship a content-addressed bundled-engine patch manifest and the pinned OpenClaw MIT notice. Fully verified read-only sibling engine sets replace in-place installation; base and existing set bytes are never changed, even when shared Gateways are live. `KitState.patchSet` and `why: 'engine-patch'` expose provenance; rollback selects verified stock offline, while stock drift may need registry access. The initial patch set is empty.
- `getConfigKey` / `setConfigKey` read and write exactly one dotted config key in the file `prepare()` owns, so an app can narrow-read and restore a value (for example `skills.workshop.autonomous.mode`) around a boot without a whole `config.get`, whose result redacts token-bearing values. Only that key changes, the write is atomic in `prepare()`'s exact shape and happens only when the bytes change, and `undefined` removes the key.
FEAT: Add portable `readAgentDayUsage` / `AgentDayUsage` readings that combine fresh retained transcripts with durable Gateway Skill Workshop review charges. UTC/IANA windows, pending/interrupted/missing usage and conservative completeness let callers keep unknown budgets unknown. The original partial usage API is unchanged; other detached kinds and the worker bundle remain uncovered.
FIX: Persist detached Workshop review usage, including reported usage on failed outcomes, without double-counting memory flushes, recovery resumes or run results. Per-boot/month attempt counters, fsynced launch and clean-stop records, phase deduplication and bounded month reads preserve failure holes and crash incompleteness.
SECURITY: The bundled checksum-pinned Gateway Workshop patch and operator-read usage RPC write/read accounting identities, times and reported counters only, never prompts, outputs, tool arguments or credentials. Device reads stay member-scoped and never access host files; unknown costs and unverified billing identity are not guessed.
FIX: `stop()` now signals only the pids the kit itself spawned and never a process group, so shutdown no longer reaches processes the kit never started. Every spawn is recorded when it starts and dropped when it exits; the gateway is left to shut its own sessions down on its own SIGTERM.
- Unreleased source dependency metadata: pin @byokit/seal 0.3.0 and @byokit/relay 0.5.2; this package's existing version is not republished. Previously published consumer metadata remains unchanged.
- SECURITY: Sensitive subscription sign-in tokens stay out of sign-in views and results, including engine errors, links and codes after token entry.
- FIX: Subscription setup-token sign-in now answers sensitive wizard text steps from the existing paste channel, once per step, with cancellation and timeout preserved. API key (billed per use) entry still requires explicit selection.

## 0.6.0 (2026-10-02)

- Portable `readAgentUsage` / `agentUsageOf` expose explicit-agent UTC retained-transcript totals with raw responses, cache freshness and missing-price counters preserved. Coverage stays partial: stock-engine detached Workshop reviews are absent, and unavailable data never becomes zero; complete internal-turn accounting is not claimed.
- FIX: Host runs can reuse a caller-stable per-dispatch `idempotencyKey` after a lost connection instead of starting a second engine run. Omission keeps fresh UUIDs. Document the pinned engine's gateway-wide, bounded, in-memory cache and honest in-flight replay limits; this is not exactly-once across engine restarts.

FIX: Generate complete pinned route discovery: 91 auth choices and five cloud/CLI providers, including external plugin dependencies, plan-key entry, service grouping and corrected provider/billing labels. `routes()` computes readiness without reading credentials or installing plugins; legacy boolean `offer` is ready default subscriptions only, with `offerPolicy` retaining eligibility. Missing plugins, binaries, client registrations and choiceless wizard flows remain visible, not falsely usable. Explicit API/local/endpoint routes never become default billing; endpoint billing requires host input. Full discovery also reaches the existing phone/web link without hiding unavailable rows. Existing choice IDs, legacy explicit browser/code selectors, native Claude activation guards and ChatGPT pairing are retained; corrected manifest provider IDs and semantic `via` values replace inaccurate discovery labels. Listing an API or unavailable route never authorizes a sign-in or makes it a default.

- The README points to the shared account-route vocabulary (D18); pinned route discovery is not proof of additional implemented authentication flows.
- FIX: ChatGPT sign-in now interrupts abandoned wizard/paste waits on gateway disconnect and reconfirms a new, usable OAuth profile for the selected member through the reconnected engine. Recovery is bounded and fails closed for unknown, missing, pre-existing or unrelated credentials, cancellation and expiry. A synchronous cleanup error during reconnect no longer suppresses the terminal sign-in view.

## 0.5.0 (2026-10-01)

- Dependency update: pins @byokit/relay 0.5.1.

- FIX: Wait for approval callbacks in the bridge parking test instead of assuming the gate finishes within 50 ms.
- FIX: Successful runs preserve complete generated text in the final callback and result instead of replacing it with a capped terminal snapshot; silent and empty replies remain empty.

- Add app-supplied output schemas to host and device runs, with inferred result data, local final-answer validation and typed output failures. Subscription routes and explicit API key (billed per use) opt-in are unchanged.

## 0.4.0 (2026-10-01)

- Dependency update: pins @byokit/ui-core 0.6.0.
- Dependency update: pins @byokit/reach 0.6.0.

- Key readiness waits through the engine's retryable restart refusal after activation; missing keys still fail without another account.
- API key (billed per use): `addKey` verifies and stores an explicitly entered key in a separate member-owned agent, with copying disabled and no automatic subscription fallback. `run({ auth: 'apiKey' })` selects it explicitly with separate history; key-entry labels, errors and route revision dates are included.
- Offer subscription sign-ins, including pasted tokens and native Claude Code, by default and allow their provider plugins. API key (billed per use) routes remain app opt-in; proxies, compatibility aliases and local routes stay off.

## 0.3.6 (2026-10-01)

- FIX: Live orphan gateways recover after the engine rewrites its process title. Recovery verifies the recorded launch pid and process start time with the executable and isolated store paths; ambiguous ownership preserves the saved sign-in state.

- Dependency update: pins @byokit/ui-core 0.5.0.
- Dependency update: pins @byokit/reach 0.5.0.
- Dependency update: pins @byokit/relay 0.5.0.
- Dependency update: pins @byokit/link 0.7.0.
- SECURITY: (from @byokit/link 0.7.0) `Host.shortCode()` adds a machine-key commitment to typed pairing; `pairWithCode()` verifies it before disclosing device identity or asking for approval. Legacy codes remain compatible; use the full new code when relay lookup is untrusted.

## 0.3.5 (2026-10-01)



- FIX: Failed engine starts no longer remove another live gateway’s guards or saved sign-in state. Verified dead-host gateways stop gracefully before restart; ambiguous ownership returns a typed engine-already-running error and preserves the store.

## 0.3.4 (2026-09-30)



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
