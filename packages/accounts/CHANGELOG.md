# Changelog

## Unreleased

## 0.32.0 (2026-10-24)

- Dependency update: pins @byokit/usage 0.10.0.

- FEAT: `byokit-accounts --version` prints the running version, and `--help` starts with it; a build with unreleased changes says `+dev (dev build)`.

## 0.31.0 (2026-10-24)

- Sign in to a MiniMax plan on a phone: `minimax:code` and `minimax:code:cn` are ready on React Native (`route(id, { platform: 'rn' })`), so a phone app that names `minimax` in its `offer` list and passes its own Web Crypto as `crypto` (React Native has no `crypto.subtle`) shows the code, keeps the account and asks it through the plan. A PKCE sign-in started with no SHA-256 on the device is now refused before it starts, naming the missing `crypto`, instead of failing as an unfinished sign-in. The MiniMax API key route is unchanged.

## 0.30.0 (2026-10-20)

- FEAT: `Accounts.models(member, id)` lists a ready account's models from its vendor's live `GET /models` (OpenAI-style routes with a bearer, Anthropic Messages at `/v1/models`), read with that account's own key, or for a Grok, Copilot, Kimi, Meta or MiniMax sign-in its token, so a model the vendor adds shows without a kit release; each route in `routes.json` now names that list as `models: { api, baseUrl }`, generated from the installed Pi pin. A route with no single list (Bedrock, Azure, Vertex, Cloudflare, Google AI Studio, Mistral, Radius, Typesafe, custom) or a list that cannot be read keeps the catalogue's rows. Without host `capabilities`, `pick` no longer refuses a model id only because no account lists it: the pick goes ahead and names it in `unlisted` for the app to warn (`resolveSelection` takes the same as a new `open` argument, off by default); a listed model the account cannot use, or one a host's `capabilities` omit, still refuses.
- FIX: `resolveModel` reports `listed: true` for an id an Anthropic Messages vendor's live list carries (MiniMax's `MiniMax-M3.1-Flash`), and for an OpenAI-style row that names no limits; before, only a row with limits counted.
- FEAT: `accounts.add(member, 'openrouter:key', { keyFile })` on a computer reads the key from a file (read once, never echoed); an off-catalogue OpenRouter model id (for example `minimax/minimax-m3.1-flash:free`) now resolves on OpenRouter's OpenAI-compatible API with its live-list limits.
- FIX: A Pi launch no longer lets Pi pick its own default model for the provider (OpenRouter's was Kimi K2.6, run on a key nobody chose it for). `cliAccounts.launchArgs(id, model)` takes the model the caller chose and returns `['--provider', …, '--model', model]`, and throws "Choose a model for <provider> first" for a Pi row when none is given; `@byokit/decide/pi` likewise requires `model`.
- BREAKING: `Ask.model` is now required for ChatGPT and Ollama Pro respond calls (pass an id from `models()`); before, callers could omit it and the kit supplied a default. `Provider.models` (the catalogue's strong/fast tiers), `ModelInfo.tier`, and `ProviderInfo.models` are removed; every vendor's live list applies. `OLLAMA_PRO_DEFAULT_MODEL` is removed from the export; call `ollamaProChat` with `model: string` explicit.
- FIX: BYOKit never exports a provider key into the systemd user environment, and `npm run check:user-env` now fails, naming each such variable (never its value) and the `systemctl --user unset-environment` command, when one is there; keys are read only by path through the kit.

## 0.29.0 (2026-10-20)

- FEATURE: A signed-in Claude row from `cliAccounts` (the person's installed `installed-claude` and managed ones) carries `method`: `'subscription'`, `'api_key'` or `'other'`, read from `claude auth status`'s own `authMethod`, so an app can show which sign-in the person is on. New type export: `SignInMethod`. Absent when the CLI does not say.
- FIX: A ChatGPT `respond` (or `access`) given an `AbortSignal` no longer throws `TypeError` on Hermes, whose `AbortSignal` has no `throwIfAborted`: an aborted signal still rejects with its reason.
- FEAT: a model id Pi's catalogue lacks now resolves on a known route (a provider whose models share one API and base URL, on OpenAI-compatible or Anthropic Messages APIs): `computer.engine`'s `getModel(provider, id)` builds the entry, and the new `resolveModel(models, provider, id, { apiKey })` takes context, output limit and price from the provider's live `GET /models` when it lists them, else 128k / 16k / unpriced; capabilities are the vendor's (image input is whatever the route's own models take, so `MiniMax-M3.1-Flash-Preview` takes images; a live list's modalities override); an id the list lacks still resolves (`listed: false`, for the app to warn about). Unknown providers get nothing. First proof: `MiniMax-M3.1-Flash` and `MiniMax-M3.1-Flash-Preview` on `minimax` and `minimax-cn`.
- Dependency update: `@earendil-works/pi-ai` is now a caret range (`^1.3.0`, so Dependabot opens its bumps), and the bundled copy for phones and browsers is regenerated from 1.3.0 with the Hermes `throwIfAborted` guard kept.

## 0.28.2 (2026-10-19)

- FIX: MiniMax (Global and CN) now offers `MiniMax-M3.1-Flash-Preview` as its fast model, replacing `MiniMax-M2.7-highspeed`.

## 0.28.1 (2026-10-18)

- Dependency update: pins @byokit/usage 0.9.1.

- FIX: Installed Codex readiness retries a transient account check once and distinguishes timeouts, startup, pipe, exit, protocol and unreadable-reply failures from a confirmed signed-out account, with safe typed probe metadata and no provider messages or stderr.

## 0.28.0 (2026-10-18)

- FEAT: The accounts list can show the Claude, Codex and Cursor already installed and signed in on this computer. Pass `installed: true` to `cliAccounts` and `list`/`pick` add one `installed-<provider>` row per CLI in `bins`, read with the CLI's own status command under the app's `env.HOME`; it launches with no folder variable, so the CLI runs on its own sign-in. A CLI that is signed out, could not start, did not answer or answered unreadably reads `signed_out` with a plain `cause` (and `why: 'unknown'` when it gave no clear answer). Managed rows are unchanged, and the kit never opens the installed CLI's login files.

## 0.27.1 (2026-10-18)

- FIX: classifyFailure returns needs_workspace for an OpenCode Go key that acts for several workspaces, so the app can ask the person to pick one instead of showing a run error.

## 0.27.0 (2026-10-17)

- Each managed OpenCode account now keeps its own sign-in store, database, state and cache: `launch`, `launchEnv` and the sign-in env set `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` under the account folder (and unset `OPENCODE_DB`), so an account never reads or writes the person's own `~/.local/share/opencode`; `remove` deletes them. On OpenCode 2.x the app passes `--standalone` to each start so two accounts run at once; 2.x otherwise shares one server port (49374) and the second start fails.
- OpenCode sessions started through the kit before this version live in the shared OpenCode store and do not resume in the account's own folder.

## 0.26.0 (2026-10-17)

- FEAT: `KeyRouteError.affordable` is the count a low-credit OpenRouter 402 names ("can only afford N"), set only on `out_of_credit`, so Crewhouse re-asks with what the key can pay for (for example 3257 of 4096 tokens) and the packing list still arrives. The kit never retries; the app decides.

## 0.25.1 (2026-10-17)

- Dependency update: pins @google/genai 2.29.0 and @modelcontextprotocol/sdk 1.32.1.

## 0.25.0 (2026-10-17)

- Dependency update: pins @byokit/secrets 0.5.2.

- Sign in to ChatGPT with one button on a phone or in a browser: `login(member, 'chatgpt', { via: 'redirect' })` returns ChatGPT's own page and the address to watch for in the app's in-app browser, and `complete(member, 'chatgpt', address)` finishes it, refusing another sign-in's, a reused or a too-late address with `SignInReturnError`. Device code stays the default.
- FIX: a failed key-route ask now says why. `KeyRouteError` keeps its `code` and calm `message`, and adds `status` (the HTTP status the provider answered) and `detail` (the provider's own message, or the network error such as `connect ECONNREFUSED`, on one line of at most 300 characters with the account's key replaced by `[redacted]`), for logs and an optional "details" line. Still never retried; no new codes.

## 0.24.3 (2026-10-17)

- FIX: a key-route ask the provider refuses no longer reads as the generic "This account could not answer. Try again." `KeyRouteError` has three new codes, read from the HTTP status the request got back: `out_of_credit` (402, with or without a body: "This account is out of credit. Add credit with the provider, then try again."), `key_refused` (401, or a 403 that is not the OpenCode workspace refusal) and `rate_limited` (429), each with its words in `words.json` (`ask.outOfCredit`, `ask.keyRefused`, `ask.rateLimited`). Still never retried; any other failure stays `request`. Adapters that take no app `fetch` (Google AI Studio, Vertex, Bedrock) keep `request` for these.

## 0.24.2 (2026-10-17)

- FIX: an OpenCode Go key saved with `saveKey` (or `saveOpenCodePlanKey`, or the managed CLI's `saveKey` without `workspace`) instead of `add` no longer has every call refused with `403 Workspace selection is required`. The first Go call (or CLI `launch`) lists the key's workspaces: one is sent and stored with the key, so later calls skip the list; several reject with the typed `KeyRouteError` `needs_workspace` before any call goes out. A listing that cannot be read (console offline, timeout, server error) is no longer taken for "no workspace": nothing is saved, the call shows the gateway's own answer, and the next call lists again. `openCodeGoPlanAccount` and `cliAccounts` take an optional `fetch`.
- FIX: an OpenCode Go workspace listing that cannot be read (offline, the 10 s timeout, a status other than 200/401/403, a body that is not a list) no longer reads as "this key needs no workspace". `openCodeWorkspaces` and `add` on `opencode:plan_key:opencode-go` reject with the new typed `KeyRouteError` code `workspaces_unread` ("Couldn’t reach OpenCode to check this key’s workspaces. Check the internet connection, then try again.") and `add` saves nothing, so a multi-workspace key is never connected without its workspace. Only the console's own answer (a list, or 401/403) means no workspace.

## 0.24.1 (2026-10-16)

- FIX: an OpenCode Go login key that acts for several workspaces no longer has every call refused with the gateway's `403 Workspace selection is required`. Connect (`add` on `opencode:plan_key:opencode-go`) lists the workspaces the key can act for (`openCodeWorkspaces`, the OpenCode console's own listing): one is stored with the account unasked, several come back typed as `{ id: '', workspaces }` with nothing saved so the app shows the pick (words key `connect.workspace`) and adds again with `workspace`, and a key the console refuses keeps connecting with no header. The stored id rides every Go call — key-route asks, `opencodeGo(member)` handles, the standalone `openCodeGoPlanAccount` and managed-CLI launches (delivery config header, as the desktop OpenCode CLI stores it) — as `x-opencode-org-id`, and the gateway's refusal maps to the typed `KeyRouteError` code `needs_workspace` ("This account works with more than one workspace. Pick the one to use and connect it again.") instead of the generic retry words. Workspace ids are row ids, never secrets, and are never logged.
- FIX: every OpenCode Go key-route call also names its conversation (`x-opencode-session`, one id per call). Without it the gateway answers `400 MissingSessionID` instead of routing the stream, workspace or not — found proving the workspace lane live.

## 0.24.0 (2026-10-16)

- Dependency update: pins @byokit/usage 0.9.0.

- FEAT: `respond(member, { account, model, context })` answers for a signed-in MiniMax plan account through the pinned Pi Models path chosen by the account's saved region (`minimax` global, `minimax-cn` China) with that account's own OAuth bearer as the only credential: an expired token (MiniMax has no refresh grant, so nothing is sent) ends `signed_out` and the account reads `needs_again`; a 429 rests only that account (typed `rate_limit`, never retried). The pinned OpenClaw `minimax-portal` sources confirm regional inference bases `api.minimax.io/anthropic` and `api.minimaxi.com/anthropic`; device sign-in remains on the corresponding `account` hosts.
- FIX: Computer refresh refusals now durably end only the rejected Grok, GitHub Copilot, Kimi or Meta sign-in through `respond`, `keepFresh` and `recheck`. `keepFresh` calls `onExpired`; `recheck` returns `false` and notifies through `onChange`, without calling `onExpired`. See [Key routes](https://github.com/umeranjum17/byokit/blob/main/packages/accounts/README.md#key-routes) for refusal classification and the computer fetch requirement.
- FEAT: Managed OpenCode CLI delivers the Go plan key through folder files: `launch` writes `<folder>/opencode.json` (`opencode-go` provider, `apiKey: "{file:<folder>/go.key}"`) plus `<folder>/go.key` (0600, folder 0700) and sets `OPENCODE_CONFIG`, never argv/env; `logout`/`remove` delete the copies; the first managed row claims the old route entry only without an account key, preserving independent portable credentials once it owns a key; Go entries use `accounts.opencode:plan_key:opencode-go:<id>` (previous per-account dot entries remain readable); `usageSource(id)` is now asynchronous for every provider (await existing Codex/Cursor calls too) and returns `{provider:'opencode', key}` for OpenCode.
- FEAT: Managed Pi rows carry room: `usageSource(id)` returns `{provider:'pi', folder, piProvider}` for the `openai-codex` (ChatGPT's Codex windows) and `kimi-coding` (Kimi's window) accounts and `undefined` for every other Pi provider, so `pick` and the pool `list` show the same reading and an unsupported Pi provider stays `unknown`, never zero. The token is read in process from the managed folder's `auth.json` by `@byokit/usage` and never reaches a row, the store or a log.

## 0.23.0 (2026-10-15)

- A failed Claude plan answer now names its cause in plain words without echoing the provider's message:
  - usage limit, with the minutes until it resets (`until` comes from Anthropic's reset header and the account rests until then)
  - expired sign-in
  - Claude busy
  - unreachable
  - otherwise, the HTTP status
- The `ResponseError` also carries the HTTP `status` and a safe `reason`: Anthropic's error type, or the local error's name.
- For diagnostic logs only, a failed Claude plan answer's `ResponseError.detail` carries Anthropic's message with the request credentials and any long token-like text removed. It is never shown.
- FEAT: `@byokit/accounts` ships a `byokit-accounts` bin for a pool owner: `list --json` (one row per account with state, rest, room, windows and read time), `add <tool>`, `status <id>`, `pick <tool> --json` (the chosen account plus the `set`/`unset` a launch applies), `rest <id> [--until]` and `unrest <id>`, all JSON, never a secret, from a `<stateDir>/pool.json` of binary paths, HOME and PATH. `poolPrepare({ home })` supplies the `prepare` callback, sharing only the plan's non-secret names from the person's own default folder and never a sign-in file.
- FEAT: `byokit-accounts` becomes the pool owner's full-control view. `list` prints a plain aligned table (id, tool, name, state, room, reset, note) and `list --json` adds `stale` (the `@byokit/usage` cached-reading age rule, and true for a row with no `readAt`) and `preferred` (present as `true` on exactly the one row a tool's stored account names); `list --json --cached` answers from `<stateDir>/readings-v1.json` with no read at all, and every `list`/`pick` saves that file whole (atomic, 0600, never a secret). `use <id>` / `use --clear <tool>` store `<tool> -> <id>` in `<stateDir>/prefer-v1.json` with the same write, and `pick` passes the stored id through its existing `prefer` option, so the stored account wins only while it is `ready` and not resting. `env <id>` prints shell `export`/`unset` lines with folder paths only, for `eval "$(byokit-accounts env <id>)"`.
- FEAT: Managed CLI `rest(id, { until, why })` / `unrest(id)` persist breaks in `rests-v1.json` (0600, atomic); `status` returns `resting` until the time passes, and `launch` refuses resting accounts with `code: 'resting'`.
- FEAT: Managed CLI `pick(provider, { prefer? })` chooses the `ready`, not-resting account with the most room from `@byokit/usage` (Claude `{folder, headers}`, Codex `usageSource`), lets `prefer` win, ranks an unknown reading after a known one and keeps list order on ties, and returns every row with its reading (`room`, `windows`, `readAt`) for the pool view.
- FEATURE: Sign GitHub Copilot in on a phone or in a browser with a per-account Enterprise domain. `login(member, 'copilot', { enterpriseDomain })` (or `add`) signs in on that host instead of github.com and keeps the host on the kept credential (`enterpriseUrl`, the pinned computer engine's shape), so a reloaded account's refresh engine re-mints on the same host; github.com accounts keep exactly the exchanged token and the intermediate. A malformed domain is still refused before any store is read.
- FEAT: Managed Cursor CLI `add('cursor')` keeps one private `stateDir/cursor/<hex>` folder per account and spawns `cursor-agent login` with `XDG_CONFIG_HOME` and `CURSOR_CONFIG_DIR` set to it, so two Cursor logins no longer replace each other in the shared `~/.config/cursor/auth.json`; `launch` also points `GIT_CONFIG_GLOBAL` at the pool HOME's own global git file (`~/.gitconfig`, else `<env.HOME>/.config/git/config`, unset when it has neither) and `GH_CONFIG_DIR` at `<env.HOME>/.config/gh`, because a moved `XDG_CONFIG_HOME` otherwise breaks `git commit` with exit 128 and hides the `gh` login, and it unsets `CURSOR_API_KEY`/`CURSOR_AUTH_TOKEN`; `status` reads `cursor-agent status --format json` `isAuthenticated` instead of the ever-zero exit code, `resumeArgs('cursor', …)` is `--resume`, and the default-login guard also refuses a `stateDir` whose own tool folder would be that login. The `byokit-accounts` command registers `cursor` so `add`/`pick`/`list` cover it.
- FEAT: Managed CLI `add('kimi')` with native `kimi login` into an app-owned `KIMI_CODE_HOME` folder per account, `resumeArgs` as `--session`, and a default-login guard that refuses `~/.kimi-code` — never the owner's own Kimi folder or credentials.
- FEAT: `respond(member, { account, model, context })` answers for a selected Grok, GitHub Copilot, Kimi or Meta subscription sign-in through the pinned Pi Models path with that account's own refreshed auth: a 429 rests only that account (typed `rate_limit`, never retried); where the kit owns the refresh (the portable engine on phones and browsers), a refresh the provider proves revoked or refuses with a bare 400-403 signs only it out (`signed_out`, never retried) while a 5xx, a timeout or a dropped connection keeps the sign-in (typed `network`); on a computer Pi refreshes internally, so a failed refresh there (a revocation included) is typed `network` and the sign-in is kept; a route the platform cannot run is a typed `ResponseError` `not_included` instead of an untyped `Error`.
- FEAT: Ollama Pro hosted plan-key route (`ollama-pro:plan_key`, default model `deepseek-v4.1-flash` at `https://ollama.com/v1`) reuses the shared `@byokit/secrets` plan-key seam — person-entered key, never argv/env/recipes.
- FEAT: Managed OpenCode CLI keeps one `@byokit/secrets` plan-key entry per account (`accounts.<route>.<accountId>`), so two accounts launch and resume independently (`resumeArgs` → `--session`); the portable `openCodeGoPlanAccount` route-only entry is unchanged.
- ADD: `accounts.opencodeGo(member)` member-bound OpenCode Go plan handle (route `opencode:plan_key:opencode-go`, type `OpenCodeGoAccount` from `@byokit/accounts/opencode-go`) for consumers such as `@byokit/decide`: reads the member's own saved plan key on every request, exposes no credentials, bills `subscription` with no API-key fallback.
- ADD: `opencode` catalogue provider (pi `opencode-go`, subscription plan-key auth) so the OpenCode Go plan is in the default offer with a paste-key card: `portable.signsIn` covers pasted plan keys, provider-level status/logout resolve to the saved key account, and `checked()` without a key store reads signed out.
- FEAT: Managed CLI `add('opencode')` with hidden `saveKey` / `logout` / launch (`OPENCODE_CONFIG_DIR`), remote-CLI provider parity (read-only; sign-in unsupported over the link), and a plan-key route seam (`openCodeGoPlanAccount`) that resolves one `@byokit/secrets` entry per route — never OpenCode's `auth.json`, argv, env, or logs.
- CHORE: Pin `@earendil-works/pi-ai` to 1.2.0 (with matching openai / `@anthropic-ai/sdk` pins); regenerate routes and portable Pi artifacts.
- ChatGPT OAuth follows the upstream split: browser/paste map to provider `openai`, device stays on `openai-codex` (public route ids unchanged).
- Cloud Azure upstream id renamed from `azure-openai-responses` to `azure` (route id `azure:key` unchanged).
- Ollama Pro `ollama-pro:plan_key` stays kit-owned (pin dropped the provider); streams via openai-completions at `https://ollama.com/v1`.
- TypeSafe `typesafe:key` added from the pin (catalogue row already present).
- Claude browser OAuth prefers callback port 53692 then falls back to a free port (upstream #10571); portable Pi artifacts catch failed node:fs/os/path preloads.
- SECURITY: The ChatGPT plan account and the `accounts.chatgpt(member)` handle carry a readonly `provider: 'chatgpt'` tag, and the OpenCode Go plan account a readonly `provider: 'opencode-go'` tag. Only `@byokit/decide` releases that require `@byokit/accounts` 0.23.0 or later check the tag and refuse a misplaced handle with plain words; older `@byokit/decide` releases do not check it and still send the token to the wrong provider, so update `@byokit/decide` together with `@byokit/accounts`.
- FIX: Publish the `byokit-accounts` executable so npm can resolve it, and let `byokit-accounts --help` print usage without a pool or sign-in.
- FEATURE: Sign an agent CLI in on a remote computer from a phone over `@byokit/pair`. `remoteCliHost({ cli, bins })` (from `@byokit/accounts/cli`) answers `accounts.cli.state` (read-only per-CLI `{ installed, signedIn, label, plan }`, subscription billing, never a refresh or write) and `accounts.cli.signin.start|wait|paste|cancel`: the host starts the CLI's own login there — Codex's device code, Claude's link-and-paste-code — relays only the verification URL, user code and expiry, then reports success or one plain failure. `remoteCliDevice(link)` (from `@byokit/accounts`, portable-safe) is the phone side. The credential is written only by the CLI on the computer and never travels or logs; Pi has no headless login and reports unsupported while its state still reads.
- FIX: Route labels for the Qwen and Xiaomi token plans no longer repeat the word plan ("Uses your Qwen Token Plan", not "Uses your Qwen Token Plan plan").
- Let native runtime hosts reference an explicit app-owned Claude or Codex folder with `cliAccounts.managedFolders`, without deleting those folders on cancelled or failed sign-in; removing a managed account deletes its login files (`.credentials.json`, `.claude.json`; `auth.json` for Codex) and keeps the folder, and a reused folder re-links its history. A login that exits 0 before its URL is parsed reports `already` (signed in) instead of a failure. Remote CLI starts support cancellation during URL parsing and orderly `close()`, with a read-only lifetime `signal` aborted as soon as shutdown begins. Ready native settlement wins over phone cancel at the host (the row stays ready); shutdown still wins over late status and waits for settlement. Shell and remote sign-ins share one per-folder lock: a live or unproven holder keeps the folder busy, and a dead holder's lock is reclaimed. Exit-0 logins settle even without a phone waiter. Detached settlement/cleanup errors, and a paste into a child whose stdin already closed, return plain failures without crashing the host; fresh failed claims remove their new rows.
- FEAT: Managed Vibe CLI keeps one `@byokit/secrets` API-key entry per account (`accounts.vibe:key.<accountId>`), so two accounts launch under distinct `VIBE_HOME` folders and resume independently (`resumeArgs` → `--resume`); the owner's `~/.vibe` and `MISTRAL_API_KEY` override are never used.

## 0.22.0 (2026-10-12)

- Dependency update: pins @byokit/secrets 0.5.1.
- Dependency update: pins @byokit/usage 0.8.0.

- Keep independent selected accounts and default models per app-defined agent kind in the existing account index. Scoped picks refuse missing, signed-out, unavailable accounts and stale models without fallback; removing an account clears all referencing selections and models. Hosts may supply qualified routes and model choices.
- FEATURE: GitHub Copilot's phone sign-in is defined as data. `DeviceFlow.exchange` names its second token step, `copilot_internal/v2/token`: the device grant answers an intermediate GitHub token, a GET with that token as `Authorization: Bearer` answers the credential (`{token,expires_at}`), and the intermediate is kept as `refresh`, re-minted by that same GET on every refresh; a 401 or 403 on the exchange is a refused grant (signed out, never retried). Device URLs may carry `{host}`, the person's GitHub Enterprise domain (blank for github.com). `mockDevice({ dialect: 'copilot', domain })` serves the three GitHub paths and replays `fixtures/conformance/device-code-rfc8628-typescript.json`, which also pins Grok and Kimi start/poll/refresh/decline. No runtime exchange is implemented yet; the ChatGPT, Grok, Kimi and MiniMax device paths are unchanged.
- FEATURE: Sign in to Copilot on a phone with `login(member, 'copilot')`: the GitHub device code and the github.com device page, the catalogue exchange turning the approved intermediate GitHub token into the credential, and the same exchange re-minting it on `keepFresh`; a declined code keeps nothing, a revoked intermediate signs out once, and an enterprise domain is refused before any store is read. `github-copilot:code` is `rn: yes` and browser `host`.
- FIX: The loopback callback ports in the provider catalogue are now derived from the runtime client config, the single source of truth: `catalogue.json` no longer repeats them and `PROVIDERS` takes each client port from `GOOGLE_CLIENTS`, so the sign-in listener and the redirect address cannot diverge. Every current port is unchanged, an app-set port still moves the listener and the redirect address together, and the journey test fails if the two ever disagree.
- FIX: Managed CLI `launch` returns typed `signed_out`/`not_included` refusals with sign-in words and no environment; only ready accounts receive their isolated launch settings.
- FIX: `signInChoices` now honours the app's own `offer` list (the same `readonly string[]` as `offered` and `AccountsOptions.offer`): a provider the app names is offered even when the catalogue marks it explicit (`offer: false`), so an app that offers `minimax` gets the MiniMax card, and a provider the app does not name is left out. Called with no argument it still offers the catalogue's default rows, and the device-flow, API-key and subscription-billing filters are unchanged.
- FEATURE: Prove the example PWA Grok device-code journey through built browser exports with a local mockDevice endpoint: approval, a dropped poll, reload persistence and sign-out. The example server accepts an optional device endpoint; omitting it keeps the upstream default.

## 0.21.0 (2026-10-11)

- FEAT: `Accounts.respond` accepts `select: { account: 'auto' | 'default' | id }` and answers ChatGPT through that account's own sign-in, resolved once before any request (Auto and default use the same `pick`; a caller reads it first and passes the id). Omitting `select` is unchanged.
- FEAT: `RunSelection.provider` limits `pick` to one provider; omitted, it follows the saved default's provider (`respond` passes `chatgpt`).
- FIX: ChatGPT `respond` answered from the saved default (or the first account) whatever account the caller had picked, so a two-account pick could stream from the wrong sign-in and a failure rested the wrong account; a selected account's refusal now rests only that account, and an explicit signed-out id is refused with `ResponseError` kind `signed_out` before any request.
- Add the Antigravity (Google Cloud Code Assist, subscription) browser and paste sign-in to `@byokit/accounts` on a computer, with the `google-antigravity:browser` and `:paste` routes on the client's own loopback port 51121; it reuses the Gemini Code Assist flow, project discovery and `googleBase` stand-in, and signs in with Antigravity's client id and scopes.
- FEAT: `Accounts.respond({ provider: 'claude', ... })` accepts `select: { account: 'auto' | 'default' | id }`, the same shape as ChatGPT, and answers from that signed-in Claude plan's own sign-in; omitting `select` keeps the primary Claude plan, unchanged.
- FIX: Claude plan `respond` answered from the primary slot whatever account the caller had picked, so a two-account pick could stream from the wrong sign-in and a failure rested or signed out the wrong account; a selected account's 429 now rests only it and its expiry signs out only it, the primary stays ready, and there is no retry on another account.
- FIX: A managed CLI account now carries `addedAt` (epoch milliseconds), persisted with its roster row and exposed on `CliAccount` and `add`'s returned account; a pre-existing row without one derives it at read time from its folder's `birthtimeMs` (or the earliest of `ctimeMs`/`mtimeMs`), so two logins that share one email are distinguishable.
- The README's managed CLI section now states the planned signed-out launch contract (MS-S2): `launch(id)` gates on `status`, refuses with `signed_out` ("Sign in to {name} first.") or `not_included`, and never falls back to the default login. Docs only; no typed surface changed.
- FEAT: A Gemini Code Assist sign-in now asks Cloud Code Assist for the account's project after the token exchange (loadCodeAssist, then onboardUser and its operation poll when the account has none yet) and keeps the project id as non-secret account metadata beside the email, never inside the credential; an account with no project of its own and no allowed tier to onboard ends the sign-in with a typed refusal and keeps nothing.
- Add the offline Google Cloud Code Assist stand-in (`mockGoogle`) and its conformance fixture for the two Google routes; a testing helper with no runtime behavior change.
- Add the Gemini Code Assist (Google Cloud Code Assist) browser and paste sign-in to `@byokit/accounts` on a computer, with the `google-gemini-cli:browser` and `:paste` routes; `googleBase` points it at a stand-in host.
- FEAT: A signed-in Gemini Code Assist (`google-gemini-cli`) account can now answer: `accounts.respond(member, { account, model, context })` streams through Google's `v1internal:streamGenerateContent` with the project the sign-in stored, parsed into the pinned Pi stream shape. A 403 tier refusal is the typed `not_included` error; a 401 refreshes the sign-in once through the existing Google refresh path and retries, and a second 401 reports the account signed out. The access token is only ever the request's bearer header, never in an event, error or log, and Auto never picks an account whose billing is not subscription.
- FIX: A second Google browser sign-in on a callback port this process already holds (another member's sign-in, or another app process) no longer publishes a URL whose redirect the holder's listener answers out of date and then waits for the `redirectMs` timer; it waits for the same port the holder uses and offers its pasted-address view at once, while the wait still serves the browser return if the port frees.
- FEAT: Signing out of a Gemini Code Assist (`google-gemini-cli`) sign-in now revokes the OAuth grant at Google's documented revoke endpoint (`POST oauth2.googleapis.com/revoke`) before deleting the local copy, exactly as ChatGPT sign-out already revokes at OpenAI; a refused revoke still deletes the local sign-in and rejects so the app can report it. In tests and demos the revoke host follows `googleBase`, never `authBase`.
- SECURITY: The Google refresh token is sent only to Google's own revoke host (or its `googleBase` stand-in), never to `authBase`, and it never appears in a thrown message or a log; a failed revoke still deletes the local sign-in.
- FIX: Key routes (`respondKey`, e.g. `openrouter:key`) failed with `KeyRouteError('request')` on React Native / Hermes. Pi calls `signal.throwIfAborted()` before any fetch, and Hermes does not ship `AbortSignal.prototype.throwIfAborted`, so the call threw `TypeError` and the route never reached the network. The bundled portable Pi now rewrites every `throwIfAborted` call to a local guard with the same semantics (throws the signal's reason, else an `AbortError`), so a key route streams normally and an aborted signal still rejects as aborted; no host global (`AbortSignal.prototype`) is touched.
- Add the MiniMax user-code stand-in to `mockDevice` (`mockDevice({ dialect: 'minimax', region })`) and its offline conformance fixture, so the device sign-in can be built and proven with no network; a testing helper with no runtime behavior change.
- Sign in to a MiniMax plan with a user code: `accounts.add(member, 'minimax:code')` (or `accounts.login(member, 'minimax')`) shows the code and MiniMax's page, `minimax:code:cn` selects the China host, and the account lists as a ready subscription.
- MiniMax keeps one sign-in per region: a MiniMax token carries no identity, so the region is the identity and signing in again to the same region replaces that account. MiniMax does not refresh, so a sign-in whose token has run out needs signing in again.
- MiniMax is not a default offer: an app offers the sign-in by naming `minimax` in its own `offer` list.
- FIX: `classifyFailure`/`classify` now read the ChatGPT/Codex "Next reset in N min/minutes/hour/hours" wording as well as "try again in ~N min/h", so a subscription refusal rests the account until the stated reset instead of the 60-minute fallback; a rate limit that names no reset still falls back.

## 0.20.0 (2026-10-09)

- FEAT: `Accounts.pick(member, selection, room?)` chooses the account and model a run should use over this member's real `list()` and `defaults()`, taking one reading per account and returning the same `AccountPick` as the portable `resolveSelection`; `Accounts.models(member, id)` lists one account's catalogue models with `available` and the word for why not (`resting` and `until`, `signed_out`, or `plan`). Both are read-only: neither writes the defaults nor the account index.

## 0.19.0 (2026-10-08)

- FIX: Add member-scoped custom OpenAI/Anthropic-compatible endpoints and explicit local presets using the pinned provider/model adapters. Billing is a required choice (or preset fact), never inferred from a hostname; Auto and Default refuse non-subscription accounts.
- SECURITY: Endpoint keys stay in the member's selected device key backend; loopback readiness precedes credentials, and endpoint models never enter another member or default runtime.
- SECURITY: Key-route accounts keep secrets only in the member's device-owned keyStore, with no plaintext or ambient credential fallback. Selected-key helpers override credential headers and explicitly refuse opaque SDK clients before secrets; unmodified typed native Pi pass-through remains available for explicit client-owned authentication.
- FIX: Key routes share account persistence and retain their pinned subscription or API key (billed per use) billing; non-subscription accounts are never an Auto or Default fallback.
- FIX: Portable key routes lazily load a reproducible split artifact of unmodified pinned Pi adapters; Google uses global fetch while preserving the upstream custom-fetch refusal.
- FIX: Browser and React Native key routes now opt in through `@byokit/accounts/keys` (`withKeys(portable)`), so the main portable entry no longer carries the adapters or vendor SDKs; without it, answering a key route reports `needs_keys` before any secret is read.
- SECURITY: repository CI temporarily excepts only npm braces GHSA-vfj7-8cjw-p6xm (affected <=3.0.3), accepting build-tool DoS risk from developer-config glob patterns, no user input, and no patched release; this is risk acceptance, not newly proved input safety or a shipped vulnerability fix. Remove by 2026-11-02 00:00 UTC; the gate fails at that deadline or as soon as authoritative GitHub metadata reports a patched version. Metadata failures fail closed. Valid npm dependency cycles count every reachable advisory; unrelated high/critical advisories and malformed reports still fail.
- FEATURE: Any provider the accounts catalogue gives RFC 8628 device data (`device` on its catalogue row: the client id and endpoints its own pinned client sends) signs in on a phone or in a browser with one implementation, alongside ChatGPT's own device flow. A new provider joins by catalogue data alone; `signInChoices` and `signable` are the picker's rows and the platform's answer, and `examples/pwa` renders a card per provider from them. `mockDevice()` stands in for any of them (`Accounts`' `deviceBase`).
- SECURITY: The device code, the poll and the refresh stay between the app and the provider's own endpoints; the stored credential is the OAuth pair Pi keeps, no token is logged, printed or written anywhere but the member's own store, and a provider without a documented revoke endpoint is simply not revoked.
- FIX: The Claude plan inference route no longer sends a frozen `claude-code/2.1.74` User-Agent that Anthropic answers with `signed_out`. The client value is the host's: pass `claudeUserAgent` (or a `headers` entry) and your value wins; with none passed, no client version is sent. A caller's header now overrides the route's defaults instead of the other way round.
- FIX: A Claude plan refresh that gets no answer or a server error keeps the sign-in and tries the same grant next time, instead of deleting it; only the provider proving the grant revoked (`invalid_grant`) removes it, and a grant that may be spent stays marked in the store so no process sends it again.
- FIX: Concurrent app processes wait for the fixed OAuth callback port before starting browser sign-in, instead of failing busy and asking the person to start again. Waiting respects cancellation and the sign-in deadline; callback state checks are unchanged.
- FIX: A device sign-in whose provider keeps its grant on refresh (no new refresh token, as Grok or Kimi may answer) now stays signed in instead of asking to connect again after its first refresh. Claude Pro/Max still requires a rotated grant.
- FIX: `fileStore` now serializes every write, a whole refresh included, across processes sharing its path through a `<path>.lock` file beside it, so two app processes refreshing one sign-in at once keep the fresh credential instead of spending a used grant and marking it for sign-in again; a crashed holder's lock is removed. A Claude plan refresh no longer reports expiry from another process's refresh in flight.
- The stand-in OpenAI signs in as Umer (`umer@example.com`), so the example apps, their README pictures and the accounts tests all show the same demo person.
- FIX: A person signs in once per computer: new `machineStore(member, seal)` (Node entry) keeps each person's sealed sign-ins at one conventional path every app shares (`~/.local/share/byokit/people/<member>/auth.json`, `~/Library/Application Support/byokit/...` on macOS, `AppData\Roaming\byokit\...` on Windows), so a second app holding the same seal, such as `osKeyringSeal({ service: 'byokit' })`, is signed in already. Breaking: `Accounts` no longer falls back to an in-memory store that loses every sign-in at restart; pass `store`, and `memoryStore()` only when sign-ins should end with the app. The decide-plan and realtime-voice examples now keep sign-ins at the machine store.
- FIX: Manage named native Pi 0.87.1 subscription accounts with TUI sign-in instructions, OAuth-only status, selected provider/session launch arguments and ready-only Auto selection. Pi identity persists in a separate roster; email, plan and usage remain unknown.
- SECURITY: Isolate Pi credentials, settings and sessions in selected app-owned folders; scrub inherited provider keys and never pass TUI login instructions as model prompts, expose credentials, or refresh grants in status probes.
- FIX: Explicitly adopt a selected found row's metadata into a new empty managed login. Preserve discovered/default folders and idempotently map `adoptedFrom` to the new identity, with existing cancellation semantics.
- FIX: The PWA example asks one question at a time per card: Ask waits while an answer streams, a new Stop ends it, and an older answer's late text, final answer or failure can no longer overwrite a newer one.
- The PWA example's account rows no longer repeat the plan as a pill on every row; each row keeps its address, usage bar and room.
- The example page lists every connected plan and key before the Add rows, each
  with a plain billing chip and a live room-left meter with its refill time.
- Ask runs on one account chosen at run start: Auto takes the most room and
  names the account and why; the picker also switches accounts by hand, and a
  run never switches account mid-stream.
- FIX: The browser example now saves the sample usage page and its script with the offline shell, removes old shell caches on activation, and returns an explicit offline fallback for uncached pages and files. Sign-in and model calls still require the network.
- FEATURE: The PWA example's sign-in cards now show each provider with a logo tile and an honest billing chip (plan, or pay-per-use), a device-code well with one-tap copy and a live countdown, `Open <name>` as the single primary action with Cancel secondary, a connected card with the plan badge and a quiet Sign out, and styled expired and error banners, in light and dark at phone and desktop widths.
- FIX: A passing refusal at refresh (a 401, 403 or 429 that does not name the grant revoked) no longer deletes a sign-in: `recheck`, `access` and `keepFresh` keep it and try the stored grant again next time, for ChatGPT, device sign-ins and the Claude plan. Only the provider proving the grant revoked (`invalid_grant`, or OpenAI's `refresh_token_expired`/`refresh_token_reused`/`refresh_token_invalidated`) signs out.
- FIX: Add explicit computer Claude browser, OpenRouter paste, Radius browser/device and Copilot Enterprise sign-ins through the pinned adapters. Claude paste stays the default; Radius billing is unknown and explicit-only. Qualify Kimi and Meta device flows with offline fixtures; portable-device runtime is unchanged.
- SECURITY: Keep OpenRouter OAuth-issued API keys only in the owner-selected keyStore via shared key persistence, with non-secret route metadata and rollback on cancellation or failed index writes. Require explicit API billing selection before credentials; no plaintext fallback or ambient login import.
- FIX: Add explicitly selected Node cloud accounts for Bedrock profiles/bearer tokens/SDK chain, Vertex ADC/picked service-account paths/API keys, Azure endpoints and Cloudflare API keys/Workers bindings; retain native typed Pi streams and honest unavailable route discovery.

- SECURITY: Store keys exclusively through the member's keyStore, keep selected cloud paths/profiles as non-secret metadata, and isolate SDK requests from the app's default HOME/environment. Save/list/default operations never resolve cloud credentials or invoke bindings; browser/RN refuse before credential access. Bedrock skip-auth endpoints receive no AWS signature: stock Pi signs only the device-internal loopback hop with placeholder credentials, and the kit validates/strips that signature before egress. HTTP/1.1 only; no proxy/custom CA or endpoint Authorization header. Reserved/signing/hop-by-hop headers are dropped, not forwarded unchanged. No live endpoint qualification is claimed.
- FIX: A refresh that gets no answer (a network failure) or a provider server error (5xx) no longer forces a new sign-in on phones and in browsers: the sign-in is kept and its stored grant is tried again on the next refresh. A refusal proving the grant revoked (`invalid_grant`), any other answer that may have spent the grant (including an accepted answer that cannot be read), or a failed save still asks to sign in again.

- FIX: respond errors preserve HTTP status and Retry-After through account failure handling, allowing callers
  to retry 429 without adding request headers or other response headers to the error.

## 0.18.0 (2026-10-02)

- Dependency update: pins @byokit/usage 0.7.0.

- The README points to the shared account-route vocabulary (D18); pinned discovery metadata does not imply additional implemented authentication flows.
- Name the Claude plan: `plan(member, 'claude')` reads it once per sign-in from Claude's profile with the stored access, never refreshing it (an empty plan, never a failure, when it doesn't say); `planLabel` says "ChatGPT Plus" or "Claude Max". The PWA and Expo examples sign in to Claude by its page and pasted code, show a connected card naming the plan, and stream an answer.
- FIX: The README no longer claims browsers can reach Claude's token endpoint directly; a web page sends it through the app's own server.
FIX: Discover every pinned provider and sign-in method with billing and platform readiness; qwen and MiniMax leave the default offer until their flows exist. Legacy provider IDs and explicit offer lists stay compatible.

## 0.17.0 (2026-10-01)

- Dependency update: pins @byokit/usage 0.6.1.

- SECURITY: Restrict ChatGPT host access to ChatGPT subscription accounts before opening a credential runtime; a different provider id cannot select or expose its grant.
- FIX: Managed CLI subscription rows with no supplied provider executable report not_included, so list and Auto remain available for other providers without touching the unavailable row's credentials or sign-in markers.
- Add independent subscription accounts per member, fresh sign-in, identity replacement, account names and defaults.
- Add a read-only nativePiAccount launch/session descriptor for independent app-owned Pi folders, qualified against native Pi 0.87.1. This does not share subscription grants, sign in, infer readiness or add Pi to managed Auto; found rows remain read-only and reconnect uses the person's normal provider-native UI outside the kit.

- SECURITY: Add launchEnv to scrub inherited provider credentials, including subscription tokens and API key (billed per use) variables; isolate now prepares only the app folder and never mutates process.env. Apps must pass launchEnv().env when spawning a child.

## 0.16.0 (2026-10-01)

- FIX: Build device-owned secrets before accounts so API key routes compile in a fresh checkout.
- Add opt-in member OpenAI, TypeSafe and OpenRouter API key (billed per use) routes,
  stored through device-owned secrets stores with redacted outcomes and decide handoff.

## 0.15.1 (2026-10-01)

- Dependency update: pins @byokit/usage 0.6.0.
- FIX: (from @byokit/usage 0.6.0) Claude subscription quota snapshots can now be read through an identity-free ephemeral host callback without credentials or a fabricated account UUID; readings never enter a cache or shared store, and retry state stays local to the source.

## 0.15.0 (2026-10-01)

- Dependency update: pins @byokit/usage 0.5.0.

- FIX: ChatGPT subscription respond() now retains reported token usage with result: true or tools, including partial results for incomplete answers.
- Bind an existing ChatGPT subscription login to a member-bound chatgpt() handle without exposing credentials.
- Script mockOpenAI answers with string, regex or function prompt matchers and optional token usage.

## 0.14.0 (2026-10-01)

- Dependency update: pins @byokit/usage 0.4.0.

- SECURITY: Add a Node-only managed CLI account boundary for subscription sign-in: only app-owned folders and explicitly passed absolute binaries, no default login access, no credential-file reads, no token output, and launch environment credential shedding.
- Add managed CLI account creation, marker-gated sign-in, status, rename, cancellation, history links and removal, with legacy roster and terms compatibility.
- Share the portable chooser's AccountLike type and accept normalized subscription usage with millisecond reset times.
- Bound native status deadlines even when a passed CLI ignores termination; stdout is capped and only the owned child is terminated.
- Offer every subscription catalogue row by default on supported platforms, adding Kimi, Meta, Qwen and MiniMax labels; preserve Claude Pro/Max sign-in and remove terms and visibility gates. API key (billed per use) rows remain opt-in. Simplify the ChatGPT plan-use error words.

## 0.13.0 (2026-10-01)



- Add portable, choose-once multi-account selection with most-room ordering, unknown room above exhausted, and secret-free candidate explanations. Auto and default fallback use subscription accounts only; an API key (billed per use) must be explicitly selected.
- Export roomOf and roomWords, shared Auto conformance fixtures, and descriptive multi-account terms data.

## 0.12.0 (2026-09-30)



- FIX: fileStore verifies optional sealing-adapter upgrades and atomically replaces authenticated ciphertext on read, allowing opt-in dual-wrap migration without losing the original store on interruption.
- Claude Pro/Max subscription PKCE sign-in, direct Messages and single-flight refresh with on-device credentials.

- Anthropic Messages with an app-passed API key (billed per use), explicit model and opt-in; typed native requests, streamed text/tools/thinking/message events, usage/raw results and the shared IncompleteError contract for max_tokens/refusal (including with tools) on every platform.
- Expose fresh subscription access to host-side capabilities using the app’s own sign-in.

## 0.11.0 (2026-09-30)



- Add optional `parallelToolCalls` to `respond` and `Accounts.respond`, passed through to ChatGPT as `parallel_tool_calls`; omitted keeps the provider default.

## 0.10.0 (2026-09-30)



- Export portable `classifyFailure` and `Failure`, with an injectable clock and `REST_MS` fallbacks; retain `classify` as an alias.

## 0.9.0 (2026-09-30)



- SECURITY: Prevent replay of single-use refresh grants in the portable engine by saving a generation attempt before sending and committing the replacement before returning access. An uncertain or terminal attempt requires sign-in again; custom stores must provide a refresh transaction, and restart safety depends on durable storage and a single refresh owner or host lock.

## 0.8.0 (2026-09-30)

- SECURITY: Desktop fileStore now requires a sealing adapter, rejects insecure Electron storage backends, and refuses symlink or permissive credential files. Plaintext stores must revoke old credentials and sign in again; previously sealed stores remain readable with the same adapter.
- SECURITY: Credential writes use exclusive random temporary files with no-follow opens and file sync before atomic replacement when Node permissions allow it; default sign-in and discarded-credential revoke logs no longer include raw provider errors or member identifiers.

## 0.7.1 (2026-09-30)

- FIX: a cut-off answer is now reported as cut off: `respond` throws `IncompleteError` with its reason and partial output, and notifies `onEvent`, instead of returning it as finished.

## 0.7.0 (2026-09-30)

- Add the portable `chatgptPlan` adapter for a host-validated official token-sharing session, checking
  ChatGPT plan usage consent on every access. Uses subscription billing and never falls back to an API key
  (billed per use); the host owns sign-in, identity verification, storage and refresh per person.

## 0.6.0 (2026-09-30)

- `respond` and `Accounts.respond` accept `originator` (or set it once on `Accounts`): the app's own originator header value. Default: 'byokit', as before.
- FIX: a garbled streamed answer no longer arrives as an empty string with HTTP 200: a data line the parser cannot read now throws a ResponseError the app can show.
- FIX: a stream that ends with no words, no completed answer and no tool calls now throws instead of resolving to an empty string.
- FIX: the answer is the words as they streamed in; the completed envelope is only used when nothing streamed. Apps whose completed envelope carries no text no longer see their streamed words replaced by an empty answer.
- FIX: streamed answers split on bare-CR line endings too, so a backend that separates events with carriage returns no longer yields an empty answer.

- `respond` passes the whole question through: a message array (many turns, pictures with `input_image`, a `function_call` with its `function_call_output`), `tools` and `tool_choice` (the app's own function tools and built-ins, including `image_generation`), how hard the model thinks (`reasoning.effort`), and how long the answer is with the shape it must follow (`text.verbosity`, `text.format`). With `tools` the result is the text with every output item (`isFunctionCall` spots a call); without, the plain text as before. `onEvent` sees each tool call and output item as it streams.

## 0.4.1 (2026-09-29)

- FIX: the packed `dist/words.d.ts` keeps `with { type: 'json' }` on its `./words.json` import, so a strict NodeNext consumer with `skipLibCheck: false` no longer fails with TS1543.

## 0.4.0

- Each catalogue row carries its billing (`subscription`, `api`); show `billingWords(p)` next to every provider you list.
- FIX: OpenRouter (API billing) is no longer offered by default on computers; `offered()` without keys returns subscription rows only. Name it explicitly (`offer: ['openrouter']`) to keep offering it.
- FIX: a locked-keychain read (iOS returns "User interaction is not allowed" while the phone is locked) no longer signs the person out: `keepFresh` treats it as unknown and tries later, only a refused refresh fires `onExpired`.
- `secureStore(secure, name, options?)` passes `options` (e.g. `{ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }`) to every keychain get, set and delete; the default is unchanged.

## 0.3.1

- `respond(member, { instructions, input, onText })` asks ChatGPT with the member's own sign-in, the answer streaming in over an injected `fetch` (whole answer at once when the fetch can't stream); limits and lapsed sign-ins are acted on as `failed()` does.
- FIX: a plain HTTP 429 or an undated `rate_limit_exceeded` is a temporary rate limit, not "plan doesn't include this"; a streamed error keeps its code.
- FIX: a refresh that fails on the network before asking is reported as network trouble; a refused refresh signs the account out.

## 0.3.0

- FIX: `@byokit/accounts/testing` `decoy()` now requires a caller-owned root; migrate from `decoy()` to `decoy(root)` and clean up that root when done.
