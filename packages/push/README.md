# @byokit/push

Open a sealed push notice before the phone displays it, even when the app's JavaScript is asleep.
The app owns push registration, permissions, delivery and product wording. This package supplies an iOS
Notification Service Extension, an Android data-message handler, and device-key provisioning.
It consumes `@byokit/seal` 0.3.1; keys are raw 32-byte X25519 **secret keys**, not seeds or public keys.

## App setup

1. Install the package into an Expo development build (Expo Go cannot load it). Add this config plugin:

   ```json
   ["@byokit/push", { "appGroup": "group.com.example.app.notices" }]
   ```

   Set `ios.bundleIdentifier`. Prebuild adds `ByokitNoticeService`, embeds it in the app, links the exact
   Swift-Sodium 0.11.0 `Clibsodium` product, and sets the App Group on both signed targets. Register that
   App Group and enable it for both provisioning profiles in Apple Developer. The app's push entitlement
   and token registration remain app-owned. The plugin records the extension for EAS credentials too.
   Run `npx expo prebuild`, install pods and rebuild; changing native configuration needs a new binary.
2. Provision the same device key whose public half the sender uses:

   ```ts
   import { setNoticeKey, clearNoticeKey } from '@byokit/push';
   async function provisionDeviceKey(deviceBoxSecret: Uint8Array) {
     await setNoticeKey(deviceBoxSecret); // Raw X25519 secret, 32 bytes
   }
   // Call before logout, revocation, or handing the device to another account.
   async function forgetDeviceKey() {
     await clearNoticeKey();
   }
   ```

   The React Native entry loads the Expo module. Default Node/web entries are native-free; provisioning
   there rejects as unavailable. `openNoticeContent(payload, key)` is the pure JS parser for app-side use.
   Rotation replaces the one stored key; messages sent to an old key fall back. There is no key history.
3. Send `sealNotice({ title, body, data? }, deviceBoxPublic)` from seal 0.3.1. `title` is a non-empty string,
   `body` a string, and optional `data` a JSON object. Muxr's routing fields (`sessionId`, `eventId`, etc.)
   fit in `data`; the kit adds no product-specific fields. Notices assert no sender identity. The server
   must authenticate recipients and delivery; opening a notice never authorizes a tap action.

## iOS transport

Send an APNs **alert** with `aps["mutable-content"]: 1`, generic `aps.alert.title/body`, and top-level
`notice: { v: 1, sealed: "…" }` (a JSON string is also accepted). With Expo Push, use `mutableContent: true`
and `data: { notice: envelope }`; the NSE also reads Expo's `userInfo.body.notice` wrapper.
The NSE replaces only title/body and writes opened routing fields to `userInfo.data` and
`userInfo.body.data` for Expo's remote-notification serializer.
A missing key, malformed envelope, authentication failure or timeout preserves the original alert.
Sent through `@byokit/relay`, the envelope is the notification's `data` (`relay.notify({ data: sealNotice(…) })`),
which Expo carries at `userInfo.body.data`; the NSE and `openNoticeContent` open that shape too.

The app writes a generic-password entry in the shared App Group keychain, accessible
`AfterFirstUnlockThisDeviceOnly`. It works while locked after the first unlock, without a biometric prompt.
Before the first unlock after reboot, opening may fail and the generic alert is expected. No key goes in
App Group files or user defaults. App Group sharing follows Apple's keychain entitlement rules:
[Apple keychain sharing](https://developer.apple.com/documentation/Security/sharing-access-to-keychain-items-among-a-collection-of-apps).

## Answer from the notification (iOS)

A person types an answer on the notification and it reaches the host while the app stays closed: no JavaScript runs.
The kit's app-delegate subscriber sits in front of the app's notification delegate (expo-notifications' or the
app's own) and takes only a text-action press, or a press on a button listed in `answer.choices`, on a relay notification whose opened notice has `data.answer`.
Everything else is forwarded unchanged, and a press the kit takes never reaches JavaScript, so it is never sent twice.

1. Provision each paired host from your trusted pairing state, and again when one is added or revoked:

   ```ts
   import { setAnswerTargets } from '@byokit/push';
   declare const relayOrigin: string, hostBoxPublic: Uint8Array;
   await setAnswerTargets([{ host: 'home', relay: relayOrigin, key: hostBoxPublic }]); // [] clears
   ```

   `relay` is the relay's `https:` origin and `key` the host's raw X25519 public key. The notice names only `host`;
   where the answer goes and to which key never come from a notification.
2. Register a category whose text action does **not** open the app, with the identifier the host offers as its button
   (`expo-notifications`: `textInput`, `options: { opensAppToForeground: false }`, identifier `answer`).
3. The host notifies with the button and the sealed `answer` field, and opens each press:

   ```ts
   import { openAnswer } from '@byokit/push';
   import { RelayClient } from '@byokit/relay';
   import { sealNotice } from '@byokit/seal';
   import type { Host } from '@byokit/pair';
   declare const host: Host, url: string, deliver: (event: string, text: string) => Promise<void>;
   declare const hostBox: { secretKey: Uint8Array }, devicePublic: Uint8Array, deviceId: string;
   const relay = new RelayClient(host, { url, onAction(press) {
     const text = openAnswer(press, devicePublic, hostBox.secretKey); // null: not this device, notification or button
     if (text === null) throw new Error('This answer was not accepted');
     return deliver(press.event, text);
   } });
   await relay.notify({ id: 'ask-42', title: 'An agent needs you', to: [deviceId], urgency: 'high', mutableContent: true,
     categoryId: 'agent-question', actions: ['answer'],
     data: sealNotice({ title: 'Claude asks', body: 'Run the tests? y/n', data: { answer: { host: 'home' } } }, devicePublic) },
     { includeContent: true });
   ```

On the press the phone seals the trimmed text with its notice key to the host (`sealAnswer`: static X25519,
HKDF-SHA256, ChaCha20-Poly1305), binding the notification id and the button, and posts `{ token, action, reply }` to
`<relay>/relay/v1/push/action` under a background task. The relay cannot read or forge it; a reply replayed onto
another notification opens to `null`. On success the alert is removed. On failure it stays, quiet, and says why:
the relay's own reason (for example `Computer offline`), `Nothing was sent` for empty text, a missing target or a
locked key (before the first unlock after a reboot).
The app must provision the same device key the host seals to (`setNoticeKey`); there is one per device.

### Answer with a button

A permission question needs no typing. List the choices in the sealed notice, `answer: { host, choices: [{ id, label }] }`,
and offer one plain (non-text) button per choice with the choice's `id` as its identifier (`actions: ['allow', 'deny']`,
`opensAppToForeground: false`). A press on one of them is taken the same way: the phone seals
`{ action, choice, event, v: 2 }` and the host opens it with `openChoice(press, devicePublic, hostSecretKey)`, which gives the
pressed `id` or `null` (not this device, notification or button; a typed text opens only with `openAnswer`, a choice only
with `openChoice`). The choices are read from the opened notice, so a relay cannot add a button; what each `id` does stays
on the host. The failure alert reads as above.

Android has no background Answer yet: there the press is the app's to handle.

## Android transport

Configure Firebase in the host app (including `google-services.json` and the Google Services Gradle plugin).
Request `POST_NOTIFICATIONS` in the app on Android 13+. Send a **data-only** FCM message:

```json
{ "data": { "notice": "{\"v\":1,\"sealed\":\"…\"}", "title": "New update", "body": "Open the app to read it." },
  "android": { "priority": "high" } }
```

Do not send an FCM `notification` field: background notification messages are displayed by Firebase before
this handler runs ([Firebase delivery behavior](https://firebase.google.com/docs/cloud-messaging/android/receive-messages)).
The kit posts to `byokit.notices` with a launch intent. Decrypted routing JSON is in the activity intent extra
`byokit.notice.data`; the app reads and validates it before navigating. A secure lock screen gets the generic
public copy by default (Android/user privacy settings govern display). A missing key or invalid box posts the
generic `title/body`; messages without `notice` are ignored. Notification taps do not execute actions.

If the app already has an FCM service, set plugin option `androidService: false` and forward messages from
that service to `io.github.umeranjum17.byokit.notices.NoticeHandler.handle(context, message.data, message.messageId)`.
One service must own dispatch; unrelated messages remain the host's responsibility. Token refresh remains
app-owned. The encrypted device secret lives in private preferences; its AES-GCM wrapping key lives only in
Android Keystore. A restored backup without its Keystore key fails closed. No direct-boot handler is registered.

## Verification and limits

`npm run build`, `npm run check`, `npm test`, and `npm run smoke:pack` cover the portable entry and payload parser.
CI's `push-android` assembles the example and runs JVM compatibility/fallback tests.
CI's `push-ios` runs `swift test` against the same seal fixture and the Answer vector `test/answer.test.ts` shares,
and compiles the generated extension and the Answer handler in the example simulator build. Unit/build checks do not prove APNs/FCM delivery to a sleeping physical phone.

Manual delivery proof (requires the app owner's signed build and push accounts): provision the fixture key,
background and lock the phone after unlocking once, then send a real sealed title/body and check the displayed
text and tap routing. Repeat with no key, wrong key, a modified ciphertext, and after clearing the key; each
must show the generic copy. On iOS also check the extension timeout fallback and reboot-before-first-unlock.
On Android test denied notification permission and a data-only message with the process killed (not force-stopped).
For Answer, lock the phone, answer from the notification and check the host received the text while the app stayed
closed; repeat with the host offline (the alert says why) and with empty text. Record OS, build, transport and observed results. Force-stop, platform throttling and offline delivery are controlled
by the OS/provider; this kit cannot guarantee arrival. Neither keys nor opened content are logged by the kit.
