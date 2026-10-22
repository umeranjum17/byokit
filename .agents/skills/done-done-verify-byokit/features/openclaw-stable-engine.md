# OpenClaw extended-stable engine and native Workshop

The built public `@byokit/openclaw` entry boots the exact extended-stable engine, lists and reads complete native Workshop instructions from one agent's persistent collection, refuses another agent's read and a third-party provider install, then makes one fresh MiniMax M3.1 Flash chat turn.

## Drive

Explicit live-route authorization and a sanctioned key file path are prerequisites. Never discover keys in installed apps, read keys from environment, print/copy the key, or retry the model turn. API-key billing remains billed per use; trial credit is not proof of zero charge. The strict budget is one native chat: store the key with public `models.authSetApiKey` (storage, not verification), then call `agent` exactly once and read its terminal result/history. Do not call `addKey`, setup activation or a probe: those would consume an extra inference. This proves public native pass-through, not live qualification of the high-level key activation helper.

From a clean committed tree after build/doctor, open a unique done-done run and invoke:

```sh
node .agents/skills/done-done-verify-byokit/capture/openclaw-stable-engine.mjs <run-evidence-directory> <task-owned-disk-engine-directory> <sanctioned-key-file>
```

Run under a throwaway HOME/XDG, with supported Node/npm on PATH, through the host's memory gate and heavy-job lock. Engine installs live on disk, never tmpfs; the short temporary app home is deleted in `finally`. The recipe uses only public built package entries, records the actual engine version, native catalog id, typed unavailable outcome, unverified native storage result, unique assistant reply and run id, and scans its log/JSON captures for the exact key before returning. Only this fresh proof home disables utility inference and same-model provider retries, retaining the production defaults elsewhere. No screenshots are needed for this SDK-only change.

Seal the run only after all validation and the single real turn finish. Judge `stable-engine.log` and `steps.json` and receipt the exact clean HEAD; do not reuse a prior run's media/logs. Failure or unavailable judge remains unproven.

## Offline integration

`sh scripts/test.sh packages/openclaw/test/engine/learning.test.ts` drives the real pinned Gateway without a provider: stopped-home learning mode, native Workshop read/list, typed native RPCs, cross-agent refusal, persisted instructions after restart, and typed `unsupported_plugin`. Full pin regressions run through `npm run test:engine`; they do not replace the live one-turn proof above.
