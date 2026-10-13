# OpenClaw kit example ways in (WP10-S8)

Once the engine is ready, the openclaw-kit phone page (`examples/openclaw-kit/web`) lists every route the computer's kit returns from `oc.routes()`, grouped by `@byokit/ui/connect`'s `connectView`: **Plans** first and open, every other group (Pay per use, On this computer, …) folded. Each row reads `<kit label> — <way in>`, how it is paid for and whether it works here. A row is a button only when this page can start it: the first ready plan of its provider that signs in with a code (`openai:code:openai-device-code`, `ChatGPT Device Pairing — sign in with a code`) or with the plan's key (`opencode-go:plan_key:opencode-go`, `OpenCode Go catalog — paste the key from your plan`); the computer starts a sign-in by provider alone, so a second such row (`github-copilot:code:github-copilot-enterprise`) is listed but not startable and reads `Ready. This computer starts only the first sign-in for this provider.`. Every other row stays listed with `aria-disabled` and says why: its readiness words (`Install its app on this computer first.`), or `Ready, but this page has no form for it yet.` for a ready page sign-in or API key. The sign-in card, sign-out button and run-end sentences name the tapped row by its kit label (`ChatGPT Device Pairing`); after a reload they name the signed-in provider (`OpenAI`).

## Sub-features

- Group order and folding: `plans` first and open, every other group closed; `openai:key:openai-api-key` sits in `perUse`.
- The ChatGPT plan row starts the device code (`CREW-2026` from the fake Gateway), hides the list while it waits, and lands on **Talk to it**.
- `openai:browser:openai` reads `Ready, but this page has no form for it yet.`, `github-copilot:code:github-copilot-enterprise` reads the one-code-per-provider sentence, `anthropic:cli:anthropic-cli` reads `Install its app on this computer first.`; a force-clicked unavailable row starts nothing.
- The OpenCode Go row asks for the `Plan key` (a password field, list hidden, `Paste the key from your plan. Your computer keeps it, not this phone.`); `wrong-key` (the fake's refused key) shows only the kit's `API key activation failed`; a good key lands on **Talk to it**, and a reply ends with `<n> tokens used.`. The key never appears in the page or the host's output.
- A reload while signed in finds the provider from `oc.state().signedIn` (`Sign out of OpenAI`); signing out shows `Sign in with OpenAI to start.` and the list again.
- A finished run shows its token usage under the reply in `#usage` (`Tokens: N in, N out, N total.`, with `, on <model>` when the engine names one). The e2e waits for it after the Allow run and asserts that shape; the line is empty while the run is still streaming.
- `opencode:plan_key:opencode-go` is listed as a ready key row that reads `Ready, but this page has no form for it yet.`; the plan key is added at the computer with `add opencode-go` (`host.ts`), not on this page.

## How to get to it (user POV)

Start the example host, pair the phone page with the code and the two words, wait for `Ready.`. Under **Connect an AI account** → **Plans**, tap **ChatGPT Device Pairing — sign in with a code**, type the code on the ChatGPT page; the page moves to **Talk to it** by itself.

## Driving it with node scratch consumers

After SKILL.md Launch and Doctor, use the packed-package example test (Playwright Chromium or system Chromium), which runs only the kit's fake Gateway:

```bash
feature=openclaw-kit-connect
entry=examples/openclaw-kit/e2e.test.ts
# An exclusive retained folder outside the repository; the test writes each step's light and dark phone frame there.
: "${BYOKIT_EXAMPLE_SHOTS:?absolute external evidence folder required}"
export BYOKIT_EXAMPLE_SHOTS
drive=(sh scripts/test.sh "$entry")
```

Use SKILL.md Evidence's capture block through the heavy-job lock and memory gate. Look at `2-signed-out.png`/`2-signed-out.dark.png` (the grouped list), `3-code.png`/`3-code.dark.png` (the code, list hidden), `9-plan-key.png`/`9-plan-key.dark.png` (the key field) and `10-plan-key-answered.png`/`.dark.png` (the reply and its usage). For before frames, run the same test from the base ref's copy of `examples/openclaw-kit` placed beside it in the worktree (removed afterwards).

## Gotchas

`capture/review-evidence.ts` drives only `examples/pwa`; this page needs a paired host, so its frames come from the e2e's `BYOKIT_EXAMPLE_SHOTS` (phone width, light and dark; the page is a phone page, so no desktop frame). Readiness is the kit's on the computer with no install facts: every route needing a plugin or binary reads as not ready. The page names each row by its openclaw route `label` (`ChatGPT Device Pairing`, from `oc.routes()`, found by the row's id); the row's billing words keep the route's `name` (`OpenAI`).
