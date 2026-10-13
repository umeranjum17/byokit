# Engine-owned remote plan sign-in

## Sub-features

- `anthropic-cli` starts unmodified Claude Code's own plan login in the same engine HOME and `CLAUDE_CONFIG_DIR` used by runs. The existing handle and link carry the native address, paste-code prompt, cancel and terminal view; only engine readiness plus live activation can be done.
- `openai-device-code`, `via: 'code'`, uses the engine wizard and does not bind a phone-local callback listener.
- Wrong code, native expiry, cancellation and a missing CLI do not activate a route. A native parse can be cancelled; host shutdown stops native children before sealing/removing the engine HOME.
- Runtime-owned CLI folders survive cancelled/failed roster bookkeeping. Their grants never move into another folder.

## Offline drive

After Launch and Doctor, import built public `@byokit/openclaw`, `@byokit/openclaw/testing`, `@byokit/openclaw/link` and `@byokit/openclaw/device` into an external scratch consumer (resolve entries from this checkout with `createRequire`). Place a task-owned executable `claude` on `enginePath`; its status reads an empty sentinel in `CLAUDE_CONFIG_DIR`, its native login prints an HTTPS address, takes one line of stdin and writes the sentinel only for the expected synthetic code. Script `fakeGateway`'s detect from that **engine folder**, activate only when that sentinel exists, and models auth status from independent native credential presence. Hold activation open after that status becomes ready, and assert the phone stays not-ready until activation succeeds. Drive phone start/view/paste/cancel through `openclawDevice` and `openclawLink` for wrong-code, expiry, cancel and success, asserting no activation for failures and ready from engine readback only on success. Verify that cancellation preserves an existing canary in the runtime folder and that replies contain no synthetic code/grant. The corresponding source regression journey is `packages/openclaw/test/signin.test.ts` (phone native Claude login); timeout and orderly shutdown winning over a late native status readback use `packages/accounts/test/remote-cli.test.ts` (runtime-owned folder). The same source journey covers a HOST-PID claim kept unchanged through stalled post-exit settlement (including a read-only holder), failed claim writes before spawn, and ready reused-row settlement winning over phone cancel while host shutdown still wins. The phone journey covers that same ready/cancel rule through held engine activation plus an independent engine shutdown negative. A private native-host process with no phone waiter survives a real cleanup permission failure and returns a sanitized failure; a failed fresh holder claim leaves no new roster row.

## Authorized live phone drive

This leg requires explicit approval to sign in and send real plan turns; it is not part of the offline baseline. Never copy or link the person's credentials. Start a real pinned engine from the built public kit, in an exclusive external state/engine directory, with the installed Claude binary's directory on `enginePath`. Pair a task-owned Android emulator over the real Pair transport to `openclawLink`; its phone page imports the built public `openclawDevice`. No physical test phone is used.

1. The phone calls `signIn.start('claude-cli', 'browser')`. Wait until the native address and paste prompt appear. Open that address in the explicitly approved owner browser (or use an authorized lead-mediated browser consent). Hold the sign-in handle open. The returned code is never printed or placed in command arguments; insert it into the phone's password input, submit the phone form through `signIn.paste`, and clear the input immediately. Wait for `signIn.view().ready` and `done`.
2. From that same phone send one minimal `oc.run` with an explicit model from this provider's available `kit.models(member, account.id)` rows. Retain the real end frame, provider, selected model and reply; require `end.ok === true`, a nonempty reply and matching `end.model`. Do not count an activation probe as this phone turn, or silently run the previously signed-in provider.
3. The phone calls `signIn.start('openai', 'code')`. Complete the displayed device code on the provider's page in the authorized browser. No localhost callback redirect is required. For a runtime counterfactual, start the kit with an allocated task-owned `callbackPort` already occupied by another task-owned loopback server; device-code sign-in must still reach its card without trying to bind it. Wait for ready/done and send one real phone turn on this plan too.
4. Capture each provider's waiting and done screen with the maintained helper below, before code input and after the password field has been cleared. Open every shot and inspect it. This is a phone-only lab fixture (one light theme), not a changed app screen: record absent before/dark/desktop surfaces and any missing proof explicitly in the manifest.

```sh
node .agents/skills/verify-byokit/capture/openclaw-remote-signin.mjs \
  --serial "$OWNED_EMULATOR_SERIAL" --view "$EVIDENCE_DIR/phone-view.json" \
  --cdp "$OWNED_PHONE_CDP_PORT" --url "$OWNED_PHONE_URL" \
  --provider claude-cli --stage waiting --output "$EVIDENCE_DIR/claude-waiting.png"
# Repeat for claude-cli/done, openai/waiting and openai/done.
```

The helper refuses physical devices, checks both the host view and the emulator browser's actual DOM (through an explicitly forwarded own-emulator CDP endpoint), refuses populated password fields and captures the actual device pixels. All adb commands name that emulator. Run the emulator with the brief's memory gate and lean flags. Stop it and the real engine right after the journey; remove task-owned scratch and callback-code/address files, retaining only private evidence. A missing authorization, unavailable emulator, unsuccessful native sign-in, failed real turn or absent screenshot remains **not proven**.
