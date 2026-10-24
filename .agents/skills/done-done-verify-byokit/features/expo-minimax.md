# Expo MiniMax plan sign-in on a phone

A phone app signs in to a MiniMax plan by user code: `minimax:code` is ready on React Native, the example app names `minimax` in its `offer` list and passes expo-crypto as `crypto` (React Native has no `crypto.subtle`), and MiniMax joins the phone plan list as a subscription row. The MiniMax API key route is unchanged.

## Sub-features

- The plan list shows a MiniMax row ("Uses your MiniMax plan"), signed out, light and dark; the base app lists none.
- Sign in: the code shows on the phone with an Open MiniMax button (never tapped: it opens the real page), the person approves it at the stand-in, and the card says `MiniMax is connected.`
- The account is kept in secure storage across restarts; Sign out ends it, also across a restart.
- The phone's PKCE runs on the app's Web Crypto: the stand-in answers a wrong `code_verifier` with an error, so a connected card proves the S256 challenge from expo-crypto. One question answered through the signed-in plan, and an app that passes no `crypto` being refused before any request, are proven by `packages/accounts/test/minimax.test.ts` ("a phone app signs in to its MiniMax plan with the Web Crypto it passes"); the example app has no MiniMax Ask box.

## Driving it

Build and doctor per the parent skill, then `cd examples/expo && npm ci && npm run typecheck`. Build two release APKs with the stand-in bases (`EXPO_PUBLIC_DEVICE_BASE=http://10.0.2.2:21457`, `EXPO_PUBLIC_OPENAI_BASE` and `EXPO_PUBLIC_CLAUDE_BASE=http://10.0.2.2:21455`, `NODE_ENV=production`, `./gradlew assembleRelease` after `expo prebuild`): the candidate, and the base `App.tsx` (`git show origin/main:examples/expo/App.tsx`, restored after) for before. Boot a private emulator outside any shared lock with the lean flags, then, holding the device/heavy locks and memory gate:

```sh
sh .agents/skills/done-done-verify-byokit/capture/expo-minimax.sh <serial> before <absolute-private-evidence-dir> <base-apk>
sh .agents/skills/done-done-verify-byokit/capture/expo-minimax.sh <serial> after <absolute-private-evidence-dir> <candidate-apk>
```

It runs `capture/expo-minimax-host.mjs` (the built `mockDevice({ dialect: 'minimax' })` on `0.0.0.0:21457`, a loopback-only approve port on 21458), installs and clears the app, and writes `before__<theme>__plans.png`, `after__<theme>__minimax-row.png`, `after__<theme>__minimax-code.png` and `after__<theme>__minimax-connected.png`, printing `ok:` lines and the stand-in's `METHOD path grant` requests. Stop the emulator right after.

## What shows

- Happy path: `the app shows FIXTURE-MINIMAX-CODE`, `ok: MiniMax is connected.` three times (sign-in, then each restart), `ok: MiniMax isn't signed in yet.` after sign-out and its restart; requests one `POST /oauth2/device/code`, then `POST /oauth2/token urn:ietf:params:oauth:grant-type:user_code` once a second until the approval.
- Error case: the base APK's `ok: the base app lists no MiniMax plan`; the refused no-`crypto` sign-in is the test's.
- Review every PNG: the code readable, no text cut or covered, nothing but fixture data.

## Gotchas

- A freshly booted emulator joins its Wi-Fi a little after `sys.boot_completed`; the capture waits for `cmd wifi status` to say connected, else the app says `Couldn't reach MiniMax`. The android-36 `google_apis` image is known to work.
- The fixture code is long, so the shared code sheet wraps it mid-word; a real MiniMax code is short.
- `EXPO_PUBLIC_*` values are inlined at bundle time: an APK built without the stand-in device base points the MiniMax row at the real `account.minimax.io`. Never sign in there from this proof.
- A live MiniMax subscription sign-in needs the owner's account; it is not part of this proof.
