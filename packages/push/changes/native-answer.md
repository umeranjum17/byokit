- FEAT: Answer from the notification on iOS without opening the app. An app-delegate subscriber takes a text-action press on a
  relay notice carrying `data.answer`, seals the text to the host with the device's notice key (`sealAnswer`: static X25519,
  HKDF-SHA256, ChaCha20-Poly1305, bound to the notification and button) and posts it to the relay's action route; the host
  opens it with `openAnswer`. `setAnswerTargets` provisions each host's relay origin and key. Proven by Swift vectors and a
  loopback relay journey; a press on a real phone is not proven here.
- FIX: Notices sent through `@byokit/relay` (envelope at Expo's `body.data`) now open in the NSE and `openNoticeContent`.
