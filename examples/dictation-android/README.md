# Android dictation consumer proof

This app bundles the public `@byokit/dictation` workspace export, then injects an app-owned WebView/native port into `systemEngine`. Android's real `SpeechRecognizer` binds through Binder to an explicitly selected, deterministic local `RecognitionService` in the app. The app has no INTERNET permission and requires no account or model download. It never uses a person's installed recognizer or microphone recording.

The instrumentation flow asserts stable partials, final-only word replacements, language and punctuation forwarding, final callbacks before `finish()` settles, idempotent finish, free usage, missing language-pack reporting, cancellation reaching the service, and idle cleanup. This proves the kit-to-native consumer path on Android, including platform service binding and callbacks. It does not prove a vendor service's offline behavior or recognition accuracy. A production port must enforce on-device recognition (for example with `createOnDeviceSpeechRecognizer` after checking its availability), permission and language support; `EXTRA_PREFER_OFFLINE` alone cannot guarantee that for arbitrary services.

From the repository root, install and build the kit, then run on your own disposable emulator:

```sh
npm ci
npm run build
ANDROID_SERIAL=emulator-5554 ./android/gradlew -p examples/dictation-android --no-daemon connectedDebugAndroidTest
```

The repository's `android` CI job creates its own API 35 x86_64 emulator and runs this flow after the frozen Kotlin mirror's JVM tests. The reports are uploaded as `android-test-reports`, including successful runs. The example's Gradle build bundles the public package entry with esbuild into assets; no kit logic is copied into Java.

Local qualification on 2026-09-30T06:47:50Z: API 35 (Android 15), x86_64 Google APIs image, task-owned `emulator-5678`; `DictationFlowTest.systemRecognizerSettlesAndCancelsThroughThePublishedKit` passed (1 test, 0 failures/errors/skips). The transcript was `hello app`, stable partials were `["", "hello kit"]`, usage was 1000 fixture milliseconds/free, and cancellation reached the Android service. CI also runs the flow on the default AOSP image.
