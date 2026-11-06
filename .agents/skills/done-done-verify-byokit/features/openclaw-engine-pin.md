# OpenClaw engine pin journeys

Surface: the engine `packages/openclaw/src/constants.ts` pins, started by the kit. Proves what a pin move can break without a type error: Claude Code model lists and runs, tool-input progress, the memory tools, learning and lease contention.

## Drive and capture

Run `done-done run openclaw-engine-pin`. Set `BYOKIT_TEST_ENGINE_DIR` to reuse one engine across runs. The capture starts the real pinned engine through the kit with a stand-in `claude` and a scripted model.

Evidence: `engine-journeys.log`, `steps.json`, `summary.txt` and `checks.log`, all from the same done-done run. No screen exists for this SDK-only surface.

## Boundaries

Deterministic: no real Claude Code, account or provider. The stand-in speaks the stream-json contract the engine reads, so a change in the real CLI's stream needs [the stable engine capture](./openclaw-stable-engine.md).
