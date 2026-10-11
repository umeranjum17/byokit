# Herdr example host restart

A paired example page stays open while its task-owned host restarts on the same port and `.state`, then returns to `Connected to <name> - same Wi-Fi.` without pairing again.

## Sub-features

- First code entry to connected takes less than 10 seconds, including local approval.
- Restart omits `--enrol`, reuses saved `ingress.json` (null for LAN, which has no Serve mapping), asks no pairing approval and preserves the complete grant records except `lastSeen`.
- Grant count and every other field (including unknown fields) remain identical; every `lastSeen` is finite and non-decreasing, and the reconnecting grant's timestamp advances. Raw grant-file bytes intentionally change with activity metadata.
- The pairing screen never reappears; the existing agent, question, plain-HTTP reload, adoption and sealed relay journeys also pass.

## How to get to it (user POV)

Open the example page, type the host's code, compare the words and approve locally. Leave the page open, stop only that example host, then start it on the same port with the same state and no enrolment token.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, use the existing packed-package consumer test, with Playwright Chromium or system Chromium. This test launches only the kit's fake Herdr; it never calls a live Herdr CLI or session.

```bash
feature=herdr-example-restart
entry=examples/herdr-kit/e2e.test.ts
# Set this to an exclusive retained folder outside the repository before running.
: "${BYOKIT_EXAMPLE_RESTART_PROOF:?absolute external evidence folder required}"
export BYOKIT_EXAMPLE_RESTART_PROOF
export BYOKIT_EXAMPLE_FAKE=1
drive=(sh scripts/test.sh "$entry")
```

Use SKILL.md Evidence's capture block (or the environment's external evidence directory) through the machine memory gate and heavy-job lock. Retain `drive.txt`, `restart-state.json` and `restart-connected.png`. Read the JSON and inspect the screenshot: the page must show the connected line, not a pairing screen. The test asserts full grant identity, separately checks activity timestamps, keeps ingress bytes identical, and checks host approval output and pairing-screen mutation history, not just the final frame. Capture waits for the expected agent subscription to repopulate.

## Gotchas

Desktop Chromium at phone width is not physical-phone proof and does not check LIVE.md's lab-phone step 8. No account, paid provider, credentials or real Herdr are needed. Do not use `BYOKIT_EXAMPLE_SHOTS` for this proof: that selects the README capture stand-in instead of the normal e2e stand-in. The restarted host may print an unused code; the existing page must neither enter it nor request approval.
