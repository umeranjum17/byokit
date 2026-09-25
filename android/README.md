# byokit-android

The Kotlin mirror of `@byokit/accounts`: "Continue with ChatGPT" done entirely on the phone, sign-ins sealed with the
app's own Android Keystore key, refresh, "resting until 3:40 pm", and one-question model calls to the person's ChatGPT
plan. minSdk 26, no dependencies beyond the Kotlin standard library.

It reads the same `catalogue.json` and `words.json` as the TypeScript package and passes the same conformance fixtures
(`../fixtures`), so both say the same plain sentences and classify failures the same way.

## Which sign-in works from a phone

| Flow | How | Works on a phone? |
|---|---|---|
| **Browser, loopback return** (default) | The app listens on `127.0.0.1:1455`, opens ChatGPT's sign-in in a Custom Tab, and catches the browser coming back to `http://localhost:1455/auth/callback`. | **Yes, by design.** It is the only return address Codex's sign-in client accepts (Codex CLI and pi-ai use it too). Nothing to type. If port 1455 is taken, it falls back to the code by itself. Proven on an emulator against a mock ChatGPT; the live round trip is waiting on an arranged test sign-in. |
| **Code** (`SignIn.Via.CODE`) | The person types a code at `auth.openai.com/codex/device`. Plain HTTPS only. | **Yes, anywhere**, but ChatGPT first needs "device code sign-in" turned on (Settings, Security). The words for that are in `words.json` (`signin.code_off`). |
| App-owned redirect (`yourapp://…`) | – | **No.** The client belongs to OpenAI (Codex) and has no app-registered redirects, and OpenAI offers no third-party program to register one. |

Terms: ChatGPT is `grey` in the catalogue. Show `account.termsLine` ("Uses your ChatGPT plan. OpenAI may change this at
any time.") next to the button, keep an on-phone fallback, and keep a remote switch to hide it.

## Add the dependency

**JitPack** (from a tag or commit of this repo):

```kotlin
// settings.gradle.kts
dependencyResolutionManagement { repositories { google(); mavenCentral(); maven("https://jitpack.io") } }
// app/build.gradle.kts
dependencies { implementation("com.github.umeranjum17.byokit:byokit-android:<tag or commit>") }
```

**Local Maven** (from a checkout, before a tag exists):

```sh
cd byokit/android && ./gradlew :byokit-android:publishToMavenLocal
```
```kotlin
repositories { mavenLocal() }
dependencies { implementation("io.github.umeranjum17.byokit:byokit-android:0.1.0") }
```

## Use it

```kotlin
val chatgpt = ChatGptAccount(KeystoreStore(context))          // one per person, kept for the app's lifetime

fun continueWithChatGpt(activity: Activity, show: (SignIn.State) -> Unit): SignIn {
    val signIn = chatgpt.signIn { state ->                   // called from a background thread
        activity.runOnUiThread {
            show(state)                                      // state.words is the sentence; state.code the code to type
            if (state.phase == SignIn.Phase.WAITING && state.code == null)
                CustomTabsIntent.Builder().build().launchUrl(activity, Uri.parse(state.url))
        }
    }
    thread { signIn.run() }                                  // ends DONE, CANCELLED, EXPIRED, FAILED or OFFLINE
    return signIn                                            // Cancel → signIn.cancel(); "Having trouble?" → signIn.paste(text)
}

suspend fun draft(prompt: String): String = withContext(Dispatchers.IO) {
    try {
        chatgpt.ask(prompt, instructions = "Write the reply.", model = chatgpt.fastModel)
    } catch (e: ChatGptException) {                          // e.limit?.kind: RATE_LIMIT, OVERLOADED, SIGNED_OUT, NETWORK
        nano.draft(prompt)                                   // chatgpt.status().words says why, in plain words
    }
}
```

- In the code flow `state.url` is the page to open and `state.code` what to type there: show the code with an
  "Open ChatGPT" button rather than covering it with the Custom Tab.
- `chatgpt.status()` gives `READY`, `RESTING` (with `until`) or `SIGNED_OUT`, always with one sentence to show.
- A rate limit rests the account until ChatGPT says it lifts (an hour if it didn't say); `ask` then fails fast without
  a network call. Only ChatGPT refusing a refresh signs the person out; a network hiccup never does.
- Sign-ins live in `noBackupFilesDir/byokit/<name>.sealed`, AES-256-GCM under a Keystore key: a copy of the app's files
  is useless off this phone. Use `KeystoreStore(context, name)` with a different `name` per person.
- The loopback listener lives only while a browser sign-in is waiting and only on `127.0.0.1`; it accepts a return only
  with the sign-in's own random `state`.

## Tests

```sh
./test.sh               # JVM: every shared fixture, the sign-in state machine and the account against a mock ChatGPT
./test.sh <serial>      # also the instrumented tests on a device or emulator: the same state machine (loopback on the
                        # device's own 127.0.0.1:1455) and the Keystore store
```

Both run in a throwaway HOME and fail if canary `~/.pi`, `~/.codex` or `~/.claude` there, or the real `~/.pi`, change.

Not in v0.1: other providers (Grok and Copilot are partner-only, OpenRouter is desktop-first), a model ladder over
several accounts, the usage endpoint (D8, off), the `link` and `decide` clients.
