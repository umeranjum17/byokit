- Add a Swift notice opener for iOS Notification Service Extensions (`ios/Sources/ByokitSeal`, CryptoKit only):
  `ByokitSeal.openNotice` opens `sealNotice` envelopes with the same bytes and failures as the TypeScript
  `openNotice`, from an envelope or an Expo notification's `userInfo`, and `keychainSecret` reads the app's notice
  secret from one item in a shared keychain access group. Parity vectors are made by the TypeScript tests and opened
  by libsodium.
