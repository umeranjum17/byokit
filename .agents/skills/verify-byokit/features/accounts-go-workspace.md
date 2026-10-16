# OpenCode Go workspace header (connect capture, every call, typed refusal)

A Go login key that acts for several workspaces is refused by the gateway (`403 Workspace selection is required`) until its workspace is named. Built `@byokit/accounts` captures the workspace at connect and carries it as `x-opencode-org-id` on every Go call; built `@byokit/openclaw` `addKey` stores it in the engine's provider config so the activation probe and first chat carry it. Offline legs use a loopback Go gateway that refuses exactly as the real one does; the live leg reads the desktop OpenCode login in place (`opencode debug config`) and records only statuses, names and masked values.

## Sub-features

- `go-workspace-connect`: `add(member, 'opencode:plan_key:opencode-go', { key })` with a console listing of one workspace stores it unasked; several returns `{ id: '', workspaces: [{ id, name }] }` with nothing saved (`status` still signed out) and a second `add` with `workspace: '<picked id>'` stores the choice; a key the console refuses (a workspace-bound service key) connects with no workspace. `openCodeWorkspaces(key)` lists typed rows for hosts that show the pick first (words key `connect.workspace`).
- `go-workspace-call`: a `respondKey` ask on the route carries the stored workspace to the gateway (`403` without it, `200` with it, proven on a real loopback socket), and a headerless refusal rejects with typed `KeyRouteError` code `needs_workspace` naming the pick in plain words, never the generic retry words. Every call also names its conversation (`x-opencode-session`, one id per call): the gateway answers a stream without it with `400 MissingSessionID`, workspace or not (found proving the lane live; the loopback asserts the header is present).
- `go-workspace-handle`: `opencodeGo(member).workspace()` reads the stored id (`''` without one), and `decide`'s `opencodeGo({ account })` sends the header only when the account carries one.
- `go-workspace-addkey` (built `@byokit/openclaw`): `addKey(member, { authChoice: 'opencode-go', apiKey, orgId })` writes `models.providers['opencode-go'].headers` before the activation; a workspace-less replacement keeps the standing one, `removeKey` drops it, `orgId` on a route with no workspace is refused `not_included`/`model`. Offline through `fakeGateway` (config assertions), on the engine through [openclaw-go-plan-key](openclaw-go-plan-key.md) `--live` with `BYOKIT_GO_ORG`.
- `go-workspace-live` (credential-touching): the desktop Working2 login, read in place, connects through the built kit, picks Working2 from the typed list, and one real Go call answers `200`; `addKey` with the same token and its workspace is accepted and the first chat runs. Only statuses, workspace names and masked values are recorded — never the key or the org id.

## How to get to it (user POV)

- A person pastes a Go login key in the app; the app shows a workspace pick when the key acts for several, and after that every Go answer just works.
- In an OpenClaw app, paste the key (and its workspace) through key entry; sign-in and the first chat succeed.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md); no process of a previous drive is running.

- **Write the consumer.** Create `"$scratch_dir/verify-accounts-go-workspace.mjs"` importing from the built `@byokit/accounts` (`Accounts`, `KeyRouteError`), `@byokit/accounts/opencode-go` (`openCodeWorkspaces`) and `@byokit/accounts/keys` (`withKeys`) + `@byokit/accounts` portable. Serve the console listing and the Go gateway from one loopback `node:http` server that 403s `/zen/go/` requests without `x-opencode-org-id: org_WORKING2` with the gateway's own refusal body and 200s with it; route `https://opencode.ai/console/api/orgs` to the fake listing through the kit's `fetch` option and pass the loopback through. Assert the connect legs (one/several/none), the typed pick rows, the stored workspace on `opencodeGo(member).workspace()`, a real-socket `respondKey` 200 carrying the header, and the headerless 403 surfacing as `needs_workspace` with its plain words. Then a `decide` leg (`@byokit/decide` `opencodeGo`) asserting the header present with the account accessor and absent with a bare key. Print statuses, codes and words only.
- **Run and capture.** `feature=accounts-go-workspace; entry=@byokit/accounts (built dist); drive=(node "$scratch_dir/verify-accounts-go-workspace.mjs")`, then SKILL.md Evidence's capture block. Exit code `0`.
- **Happy path shows.** `connect: one-stored`, `connect: pick-returned (2 rows)`, `connect: chosen-stored`, `connect: none-headerless`, `call: 200 with org`, `refusal: needs_workspace`, `decide: header-with-account`, `decide: bare-key-headerless`.
- **Missing and error cases show.** `refusal: needs_workspace` with the exact words "This account works with more than one workspace. Pick the one to use and connect it again."; the gateway call that lacked the header logged as `org: absent → 403`.
- **Live leg.** Read the desktop login in place — `opencode debug config` parsed inside the drive (never echoed): `provider.opencode-go.options.apiKey` and `headers['x-opencode-org-id']` into env `BYOKIT_GO_KEY` / a variable, then list `https://opencode.ai/console/api/orgs` with the token and select the workspace **named** Working2 (names may print; ids never). Run this recipe's consumer with `--live` through the built kit: connect, pick Working2 from the typed list, one real `respondKey` (model `deepseek-v4.1-flash`) recording the HTTP status, then the engine leg from [openclaw-go-plan-key](openclaw-go-plan-key.md) with `BYOKIT_GO_KEY` and `BYOKIT_GO_ORG` (`--live`, heavy-job lock, `BYOKIT_TEST_ENGINE_DIR`). Finish with SKILL.md `leak_check` on both the key and the org id.
- **Proof.** The captured artifact contains those lines, the live statuses (`connect: 200`, `call: 200`, `addKey: {"status":"ok"}`, `chat: ok`), and no key or org-id bytes (`leak_check` exit 0 twice).

## Gotchas

- The console listing is a person-login listing: a service key gets 401/403 there and must connect with no workspace, never an error.
- The org id is a row id, not a secret, but it is still never printed or logged; evidence carries names and statuses only.
- The engine config slot is provider-wide: one workspace per engine, shared by every member's key (a documented ceiling, see the openclaw changes note).
- The live leg needs the desktop OpenCode login present; without it the leg is skipped honestly (`no desktop Go sign-in`), never faked.
