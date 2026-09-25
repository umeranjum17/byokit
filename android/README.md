# byokit-android

The Kotlin mirror of `@byokit/accounts`: "Continue with ChatGPT" done entirely on the phone, sign-ins sealed with the
app's own Android Keystore key, refresh, "resting until 3:40 pm", and one-question model calls to the person's ChatGPT
plan. minSdk 26, no dependencies beyond the Kotlin standard library.

Frozen and unpublished; known issue: sign-out can race a token refresh or a pending sign-in; revoke uses fixed-length streaming (other requests do not), and its client id constant and authBase come from Kotlin rather than catalogue.json.

It bundles the TypeScript package's own `catalogue.json` and `words.json` (`../packages/accounts/src`) and passes the same
conformance fixtures (`../fixtures/conformance`), so both say the same plain sentences and classify failures the same way.

## Which sign-in works from a phone

| Flow | How | Works on a phone? |
|---|---|---|
| **Code** (default, `SignIn.Via.CODE`) | The person types a code at `auth.openai.com/codex/device`, on this phone or any other screen. The app only polls outward. | **Yes, proven on a real phone** (OnePlus 13, Android 16): code on screen in 0.5 s, signed in, renewed and answering with GPT-6 Sol, no computer involved. ChatGPT may first need "device code sign-in" turned on (Settings, Security); the words for that are `signIn.deviceCodeOff`. |
| **Browser, loopback return** (`SignIn.Via.BROWSER`, explicit opt-in) | The app listens on `127.0.0.1:1455`, opens ChatGPT's sign-in in a Custom Tab, and catches the browser coming back to `http://localhost:1455/auth/callback`. Nothing to type; falls back to the code if port 1455 is taken. | **Not yet proven on a phone.** On Android 15+ the phone cuts even loopback traffic to an app in the background, so once the Custom Tab covers the app the port stops answering within 5–45 s. A short foreground service fixes that (below); Custom Tabs' `KEEP_ALIVE` does not. The authorize page and the listener work on a phone, but the real sign-in's return to the app is still to be proven there. |
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
    val signIn = chatgpt.signIn { state ->                   // a code; called from a background thread
        activity.runOnUiThread { show(state) }               // state.words is the sentence, state.code the code to type
    }
    thread { signIn.run() }                                  // ends DONE, CANCELLED, EXPIRED, FAILED or OFFLINE
    return signIn                                            // Cancel → signIn.cancel()
}

// "Copy code and open the page": state.url is auth.openai.com/codex/device, where the person pastes state.code.
fun openCodePage(activity: Activity, state: SignIn.State) {
    activity.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("code", state.code))
    CustomTabsIntent.Builder().build().launchUrl(activity, Uri.parse(state.url))
}

fun signOut(onError: (Exception) -> Unit) = thread {        // network, so off the main thread
    try { chatgpt.signOut() } catch (e: Exception) { onError(e) } // locally deleted; hand error to UI thread
}

suspend fun draft(prompt: String): String = withContext(Dispatchers.IO) {
    try {
        chatgpt.ask(prompt, instructions = "Write the reply.", model = chatgpt.fastModel)
    } catch (e: ChatGptException) {                          // e.limit?.kind: RATE_LIMIT, OVERLOADED, SIGNED_OUT, NETWORK
        nano.draft(prompt)                                   // chatgpt.status().words says why, in plain words
    }
}
```

- Show the code large with one "Copy code and open the page" button, and say it can be approved on another screen too
  (someone helping from their own computer). The person comes back to the app by themselves (Back or Recents), and
  the sign-in finishes on its own when they do. Android 15+ cuts the app's network while it is behind the browser; a
  check that can't get through just waits for the next one, so that never ends the sign-in (15 minutes at most).
- `chatgpt.status()` gives `READY`, `RESTING` (with `until`) or `SIGNED_OUT`, always with one sentence to show.
- A rate limit rests the account until ChatGPT says it lifts (an hour if it didn't say); `ask` then fails fast without
  a network call. Only ChatGPT refusing a refresh signs the person out; a network hiccup never does.
- Sign-ins live in `noBackupFilesDir/byokit/<name>.sealed`, AES-256-GCM under a Keystore key: a copy of the app's files
  is useless off this phone. Use `KeystoreStore(context, name)` with a different `name` per person.
- `signOut()` attempts to end the sign-in at ChatGPT too (`POST auth.openai.com/oauth/revoke`, as Codex's own sign-out
  does), then deletes it here even if the request fails. A failed revoke throws after local deletion: report it to the
  person because the remote sign-in may remain active in ChatGPT Settings, Security.

## The browser sign-in (explicit opt-in)

Only for trying the browser flow on a device until its return to the app is proven. Use
`chatgpt.signIn(SignIn.Via.BROWSER) { … }`; then, when the state is
`WAITING` with a `url` and no `code`, open `state.url` in a Custom Tab.

On Android 15+ hold a short foreground service for as long as the sign-in waits, or the phone blocks `127.0.0.1:1455`
once the Custom Tab covers the app. The service is the app's, not the library's:

```kotlin
// Manifest: FOREGROUND_SERVICE and FOREGROUND_SERVICE_DATA_SYNC permissions, and
// <service android:name=".SignInService" android:exported="false" android:foregroundServiceType="dataSync" />
class SignInService : Service() {
    override fun onBind(i: Intent?) = null
    override fun onStartCommand(i: Intent?, flags: Int, id: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("signin", "Signing in", NotificationManager.IMPORTANCE_LOW))
        val n = Notification.Builder(this, "signin").setContentTitle("Connecting to ChatGPT…")
            .setSmallIcon(android.R.drawable.stat_notify_sync).build()
        startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        return START_NOT_STICKY
    }
}
// startForegroundService(Intent(context, SignInService::class.java)) before signIn.run(), stopService(...) in finally.
```

`dataSync` is a stretch for Play review; `shortService` needs no type permission but stops after about 3 minutes. The
loopback listener lives only while a browser sign-in is waiting and only on `127.0.0.1`; it accepts a return only with
the sign-in's own random `state`.

## Tests

```sh
./test.sh               # JVM: every shared fixture (revoke included), the sign-in state machine and the account against
                        # a mock ChatGPT
./test.sh <serial>      # also the instrumented tests on a device or emulator: the same state machine (loopback on the
                        # device's own 127.0.0.1:1455) and the Keystore store
```

Both run in a throwaway HOME and fail if canary `~/.pi`, `~/.codex` or `~/.claude` there, or the real `~/.pi`, change.

Not in v0.1: other providers (Grok and Copilot are partner-only, OpenRouter is desktop-first), a model ladder over
several accounts, the usage endpoint (D8, off), the `link` and `decide` clients.
