# OpenClaw thinking-level clamp at run dispatch

When a run asks for a thinking level the model catalog does not list (Go Muse: `off`/`high`/`max` only), the kit maps it to the nearest still-reasoning level rounding up, reports `thinking: { asked, used }` on the ok end, and never silently drops to `off`. Levels come from the registered catalog (`compat.supportedReasoningEfforts` or `thinkingLevelMap`); a model with no levels passes the asked value through. `words('run.thinkingClamped')` is the notice when they differ. No engine install, provider or spend.

```bash
feature=openclaw-thinking-clamp
entry=.agents/skills/verify-byokit/capture/openclaw-thinking-clamp.mjs
drive=(node "$entry" "$evidence_dir")
```

Use the parent skill's Evidence block. The consumer imports only built public entries (`@byokit/openclaw`, `@byokit/openclaw/testing`), drives `fakeGateway`, patches the Muse catalog row, and requires `low` → `high` on the agent request and ok end, `high` unchanged, no-catalog pass-through, and `off` staying `off`. Prints `DRIVE OK` and writes `result.json` under the evidence directory. SDK behavior, not a UI change: no screenshot.
