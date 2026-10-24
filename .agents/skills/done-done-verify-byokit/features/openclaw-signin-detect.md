# OpenClaw sign-in detection and the key lane's live catalog

A consumer app signs in with a key through `@byokit/openclaw` and then polls the kit (the providers, the account list, the signed-in check) while the person waits. Every reader used to ask the engine for its own setup detection, so the poll cost one slow probe per reader; the first reply came about 45 s after the sign-in. The kit now shares one detection per agent: one probe in flight, its answer reused briefly, and a sign-in, a sign-out, an account change or a changed engine drops it. The same lane lists the provider's live catalog, so a model the picker offers (MiniMax Flash) stays listed and pickable.

## Sub-features

- `shared-detection`: the app's poll after a key sign-in (providers, accounts, signed-in, three rounds) makes one `openclaw.setup.detect` call, not one per reader; a changed account (a removed key) makes the next reader ask the engine again.
- `live-catalog-lane`: after a MiniMax key sign-in the key lane (`kit.models(member, '<provider>.key')`) lists the models the provider's live catalog offers, and `kit.pick(member, { account, model })` takes the model the person chose (`minimax/MiniMax-M3.1-Flash`).

## How to get to it (user POV)

- The app constructs `new OpenClawKit({ stateDir, engineDir })`, `start()`s it, calls `addKey(member, { authChoice, apiKey })`, then polls `providers(member)`, `accounts(member)` and `signedIn(member, provider)`, then picks a model with `kit.pick(member, { account, model })` and runs it.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Offline journey.** `sh scripts/test.sh packages/openclaw/test/kit.test.ts` runs `a key sign-in and the app's poll after it cost one setup detection, not one per reader` and `a key lane lists the models the live catalog offers, and the pick takes the one the person chose` on the fake gateway: expect them to pass.
- **Public-entry drive.** `feature=openclaw-signin-detect; entry=.agents/skills/done-done-verify-byokit/capture/openclaw-signin-detect.mjs; drive=(node "$entry" "$evidence_dir")` after `npm run build`, then SKILL.md's Evidence capture block. The script imports only the built `@byokit/openclaw` and `@byokit/openclaw/testing` entries, counts the detections the poll makes, and picks the Flash model on the key lane.

## Gotchas

- The detection is reused for a short window only: the answer is a CLI probe the kit cannot witness (the login lives in the person's own home), so a sign-in outside the kit is seen within that window. Every sign-in, sign-out, key change and account change the kit sees drops it at once, and a changed engine file (the witness) drops it too. A sign-in drive reads the engine every time and drops the shared answer when it starts and when it ends.
- A detection that fails is never cached: the next reader tries again. The account list reads it as `unknown` for an account it already lists (an unlisted one stays absent), never a crash or a sign-out; admission reads it as unknown, never signed out (see [openclaw-slow-probe-unknown](./openclaw-slow-probe-unknown.md)).
- The lane's list is the engine's own rows joined with the catalog rows the kit registered for that provider; the engine's row wins where both name a model, so the join never removes a row or its availability.
- The kit does not set thinking on its own: the asked level is sent as asked, unless the registered catalog row names the levels, in which case an unsupported level is mapped to the nearest still-reasoning one and never to `off` (see [openclaw-thinking-clamp](./openclaw-thinking-clamp.md)). A vendor that refuses a request without thinking is the vendor's rule, not the kit's.
