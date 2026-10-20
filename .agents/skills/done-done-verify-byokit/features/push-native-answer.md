# Push: Answer from the notification

A person answers an agent's question from the notification, without opening the app: the host sends a sealed notice
carrying `answer: { host }` through `@byokit/relay` with an `answer` button, the phone's native handler seals the typed
text to the host with the device's notice key and presses the relay's action route, and the host opens it with
`openAnswer` from the built `@byokit/push`. A reply for another notification, button or device opens to `null`.

## Sub-features

- `notice-opens-relay-shape`: `openNoticeContent` opens the envelope where the relay puts it (Expo's `body.data`) and
  returns the notice's `data.answer`.
- `answer-journey`: `sealAnswer` → `POST /relay/v1/push/action` `{ token, action: 'answer', reply }` → `onAction` →
  `openAnswer` gives the typed text; the press answers `200`.
- `answer-refusals`: the same reply replayed on a newer notification, and a reply sealed by another device key, are
  refused by the host (`502` with the host's error); no answer is recorded.
- `native-ios` (not provable on Linux): `ios/NoticeAnswerCenter.swift` takes the press in the background. Its sealer and
  payload parser run under `swift test` in `packages/push/ios` (CI `push-ios`, or the pinned Swift Linux image with
  swift-crypto standing in for CryptoKit); the delegate itself needs an iOS build on a device (see Gotchas).

## How to get to it (user POV)

- The app provisions its device key (`setNoticeKey`) and its hosts (`setAnswerTargets([{ host, relay, key }])`), and
  registers a category whose `answer` text action does not open the app.
- The host notifies with `actions: ['answer']`, `categoryId`, `mutableContent: true` and
  `data: sealNotice({ title, body, data: { answer: { host } } }, devicePublic)`, and opens each press with `openAnswer`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), plus the built `@byokit/push`, `@byokit/relay`, `@byokit/pair` and
`@byokit/seal`.

- **Write the consumer.** `"$scratch_dir/verify-push-native-answer.mjs"` imports `openAnswer`, `openNoticeContent`,
  `sealAnswer` from `@byokit/push`, `Relay`, `RelayClient` from `@byokit/relay`, `Host`, `keyPair`, `pairWithOffer` from
  `@byokit/pair`, and `boxKeyPair`, `sealNotice` from `@byokit/seal`. It opens a loopback relay with a stand-in
  `push.fetch` that records Expo messages, registers and pairs a host, subscribes an iOS Expo token, notifies as above,
  takes `userInfo = { body: message.data }`, opens it, seals `'y'`, presses, then replays that reply on a second
  notification and presses a third with a stranger's key.
- **Run and capture.** `feature=push-native-answer; entry=@byokit/push; drive=(node "$scratch_dir/verify-push-native-answer.mjs")`,
  then run SKILL.md Evidence's capture block. Exit code `0`.
- **Expect.** `opened` logs the question and `{"host":"home"}`; the press logs `200 {"ok":true,"value":{"answered":"ask-42"}}`
  and the host logs `y`; the replay and stranger legs log `502` with the host's own error; `answers` is `["y"]`.

## Gotchas

- Import only public entries; never `packages/push/src`.
- The stand-in `push.fetch` replaces Expo; no provider, account or egress.
- The iOS delegate (background task, `UNTextInputNotificationResponse`, settling the alert) is not reachable here:
  declare it unavailable. It is proved by the app's TestFlight build on a phone: lock the phone, answer from the
  notification, and see the host receive the text while the app stays closed; then with the host offline see the
  alert say the relay's reason.
