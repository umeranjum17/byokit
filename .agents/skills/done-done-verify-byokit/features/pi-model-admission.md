# Pi model admission

Sources: `packages/accounts/src/cli.ts`, `packages/accounts/src/accounts-cli.ts`, `packages/decide/src/pi.ts`, `packages/herdr/src/agents.ts`; capture: `../capture/pi-model-admission.mjs`.

## Drive

Build first. Supply the absolute native `PI_BIN`, then `done-done run pi-model-admission`. The capture uses fake credentials, app-owned disposable folders and a loopback stand-in; run inside an isolated network namespace when available. No real key, sign-in, provider, Herdr process or live workspace runner is used. Capture and receipt must name `done-done-verify-byokit`.

The built public Accounts, native descriptor, Decide and Herdr preflight APIs refuse absent, empty and provider-only models, including an empty id with a reasoning suffix. They send zero requests, even with a fake ambient `OPENROUTER_API_KEY`. Raw native Pi is the counterfactual: no model sends `moonshotai/kimi-k2.6` to loopback. An explicit model through built Decide answers `Umer`, using only the account environment. The native descriptor carries `--model` in `args`.

## Offline checks

`sh scripts/test.sh 'packages/accounts/test/*.test.ts' 'packages/decide/test/*.test.ts' 'packages/herdr/test/*.test.ts'` covers refusal before side effects, sign-in/re-adoption arguments, the CLI model flag, selected-account env cloning, and the fake Herdr pane's removal of inherited provider keys. These are offline code/fixture checks, not live Herdr qualification. Generic placement/overlay tests use Codex; Pi-specific fixture tests supply a model and a complete account environment.

## Capture and limits

`pi-admission.txt`, `summary.txt` and `steps.json` are written into the same done-done run. `screen: none`: CLI/SDK only. Read both text captures before sealing. No secret value may appear in either capture.

Named follow-ups, not claimed covered: native Herdr start/sign-in/move and device lifecycle with the guarded environment; the herdr-kit example's Pi model/account picker (currently refuses safely); raw Herdr `call`/`cli` escape hatches. OpenClaw uses its own engine model selector, not a Pi child launch; this guard does not change its configured account/model defaults. No release or daemon/process-alarm changes.
