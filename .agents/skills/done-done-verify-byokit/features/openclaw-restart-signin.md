# OpenClaw: a sign-in survives the seconds after a Gateway restart

Surface: `providers`, `signInState`, run admission, `signOut` and `confirmRetainedLogin`, on the real pinned engine. The Gateway answers before it has published each agent's model runtime. In that gap `models.authStatus` says `PREPARED_MODEL_AUTH_UNAVAILABLE` and a refresh throws `prepared model runtime publication was superseded`. Neither is a sign-out.

## Drive and capture

Run `done-done run openclaw-restart-signin`. Set `BYOKIT_TEST_ENGINE_DIR` to reuse one engine across runs. The capture runs the sealed sign-in restart journey as six copies at once on four cores, because the gap only opens on a busy host, then the fake Gateway journey that holds the gap open on demand.

Evidence: `restart-1.log` to `restart-6.log`, `gap.log`, `steps.json` and `summary.txt`, all from the same done-done run. No screen exists for this SDK-only surface.

## Boundaries

Deterministic: a synthetic sign-in, no real account or provider. Under load the journey enters the gap on some runs, not all of them, so a pass on one copy proves little: `gap.log` is the proof that holds the gap open every time.
