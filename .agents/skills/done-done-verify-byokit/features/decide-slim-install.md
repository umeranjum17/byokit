# Decide slim install

A tool depends on `@byokit/decide` for rules, any host-owned model, or Jev without the account, OpenAI SDK or pairing trees: one package on disk, every other backend an optional peer the app installs only when it uses it.

## Sub-features

- `slim-entry`: `@byokit/decide/slim` decides with `rules`, `answerer` and `jev` (a faked `fetch` answers for Jev); nothing leaves the device for rules, and no peer is resolved.
- `main-entry-unchanged`: the main entry keeps every export (`openai`, `pairedJev`, `jevHost`, `parseConfig`, `createDecider`, `generate`, `byokit-eval` behavior) and still decides, with `UnsupportedAccountError` matching by `instanceof` and by `code: 'unsupported_account'`.
- `missing-peer-names-itself`: account billing without `@byokit/accounts` throws `UnsupportedAccountError` whose message names `@byokit/accounts`, from `openai({ auth: 'account', ... })` and from a `{ config, host }` call alike.
- `slim-tarball`: the packed tarball installs alone (offline, empty cache) and its `slim` and main entries both import and decide with no peers on disk.

## How to get to it (user POV)

- The tool imports `{ decide, rules }` from `@byokit/decide/slim` and answers an obvious case locally; or imports the main entry and adds `@byokit/accounts` only for ChatGPT plan billing.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumers.** `"$scratch_dir/verify-decide-slim.mjs"` importing `{ decide, rules, answerer, jev, MemoryCache }` from `@byokit/decide/slim`: a `rules` backend answering an obvious case, an `answerer` returning fixed probability JSON, and `jev({ key: 'stand-in', fetch })` with a counting loopback `fetch` returning one Jev-shaped answer; decide each over the same question and assert `by` is `rules`/`phone-model`/`jev`, the Jev usage rides along, and the second cached call reports `source: 'cache'` with no second fetch. `"$scratch_dir/verify-decide-main.mjs"` importing the main entry: the same rules call, plus `openai({ model: 'm', auth: 'account', account: undefined })` throwing `UnsupportedAccountError` naming `@byokit/accounts`, and a `{ config: { backend: 'openai', auth: 'account', model: 'm' }, host: {} }` call rejecting with the same error and `code`.
- **Run and capture.** `feature=decide-slim-install; entry=@byokit/decide/slim; drive=(node "$scratch_dir/verify-decide-slim.mjs" && node "$scratch_dir/verify-decide-main.mjs")`, then run SKILL.md Evidence's capture block. Exit code `0`.
- **Slim tarball.** Pack the workspace (`npm pack --workspace @byokit/decide --pack-destination "$scratch_dir"`), then in a fresh `"$scratch_dir/slim-app"` with an empty cache install only that tarball offline (`npm install --offline --no-audit --no-fund <tarball>`), and run a third consumer importing `@byokit/decide/slim` and `@byokit/decide` that decides with `rules` and asserts `node_modules` holds no `@byokit/accounts`, `openai` or `@byokit/pair`. Capture that install and run as the same evidence.
- **Expected.** `rules` answers the obvious case with `source: 'api'`; the answerer and Jev answers carry their usage; the missing-peer error message matches `/@byokit\/accounts/`; the offline tarball install lists only the decide package.

## Gotchas

- Import public entries only (`@byokit/decide`, `@byokit/decide/slim`, `@byokit/decide/eval`); never `packages/decide/src` or `packages/decide/dist`.
- The tarball install must be offline with an empty npm cache, or a warm cache hides the tree it would download.
- Non-visual change: no screenshots. The error case must show the actual typed error and message.
- No secrets in evidence: the Jev stand-in key is a literal like `'stand-in'`, never a real key; run the section's `leak_check` on the evidence folder before the run ends.
