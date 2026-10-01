# Android lazy microphone proof

This disposable Expo consumer runs the built `@byokit/realtime` client and its
React Native WebRTC export with `react-native-webrtc` 124.0.8. A second native
peer in the same app stands in for the provider; it accepts the offer and sends
no microphone track. There is no account, credential, model or remote endpoint.
The real Android JavaAudioDeviceModule and microphone are exercised.

From the repository root, install and build the kits, then:

```sh
cd examples/realtime-android
npm ci
npm run typecheck
CI=1 npx expo prebuild -p android --no-install
(cd android && CI=1 NODE_ENV=production ./gradlew assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon)
./e2e-android.sh emulator-5554
```

The script refuses physical phones, grants the fixture app microphone permission,
opens it, and observes five seconds of an established warm call before any tap.
It asserts no running RECORD_AUDIO appop, no active recording in `dumpsys audio`,
and no native startRecording. It taps attach and release twice and
checks that recording starts and stops while the same call stays connected.
Evidence is saved under `.proof/`; only this app is force-stopped on exit.

To confirm the regression detector with the pre-fix kit build, pass
`.proof-baseline --expect-warm-recording` after the emulator serial. That mode
requires warm recording to be present, then stops the app without attaching.
It is a baseline probe, not a privacy pass.

CI runs the privacy check in the existing Android emulator job and uploads the
appops, dumpsys audio and native logs. iOS is outside this device proof.
