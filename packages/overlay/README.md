# @byokit/overlay

A floating bubble over other apps on Android, as an Expo module: a panel (a React component the app registers) that
opens on tap, per-app visibility rules, a tap log with no text in it, and an optional focused-field reader through the
app's own accessibility service. On iOS, the web and Node it reports `unsupported`
([docs/capability-kits.md](../../docs/capability-kits.md) §7).

```ts
import { overlay, stateWords } from '@byokit/overlay';

const state = await overlay.start({ host: 'window', mood: 'calm', notice: { channel: 'bubble', title: 'Bubble', text: 'On', icon: 'ic_bubble' }, panel: 'Panel' });
if (state === 'needs-permission') await overlay.openPermission();
const off = overlay.on('tap', () => overlay.say('Hi'));
```

Add the config plugin to `app.json`: `["@byokit/overlay", { "moods": { "calm": "./assets/calm.png" } }]`. It copies
each mood image into the app's drawables and raises the app's minimum Android version to 8.0 (API 26). The library's
manifest brings the overlay and foreground-service permissions, the bubble's service and the panel's activity.

`shownFor`, `setApp` and `resetApp` keep the per-app rules; `stateWords(state)` gives the sentence to show for a state.
`@byokit/overlay/focused-field` reads the focused text field only when the app calls `read()`.

Nothing reads another app's screen in the background, and the tap log keeps no text and forgets entries after 30 days.

## Focused field

`@byokit/overlay/focused-field` works through the app's own accessibility service; the kit declares none. The service
calls `ByokitAccessibility.attach(this)` in `onServiceConnected` and `ByokitAccessibility.detach(this)` in `onUnbind`,
and in `onDestroy` (idempotent; cancels outstanding inserts), and its config sets `android:canRetrieveWindowContent="true"` and
`android:accessibilityFlags="flagRetrieveInteractiveWindows|flagReportViewIds"` (the example's is
[`examples/expo/modules/a11y-demo`](../../examples/expo/modules/a11y-demo)). Subscribe to window/content changes,
view focus, text changes and selection changes so Chromium keeps its virtual tree current. The old
`flagRequestEnhancedWebAccessibility` is unused on API 26 and later (the kit's supported Android versions). Then:

```ts
import { focusedField } from '@byokit/overlay/focused-field';

if (await focusedField.available()) {
  const field = await focusedField.read();          // { app, text, selection } or null
  const result = await focusedField.insert('Hi');   // 'inserted', 'copied' (then show words('field.copied')) or 'failed'
}
```

`insert` puts the text over the selection (or all of it with `{ replace: 'all' }`), reads the field back, and
retries up to `attempts` times (default 2, pausing `retryMs`, default 150 ms, between tries): while the panel's
window is on top Chrome refuses the set, so `{ attempts: 13, retryMs: 150 }` lands it. A contenteditable that dropped
only the newlines resolves `'landedWithoutNewlines'` when `acceptNewlineLoss` is set, so the app can accept the text
as typed; otherwise the text is copied for the person to paste (`'copied'`) or the insert `'failed'`. The field is
resolved with input focus across every window root, then accessibility focus, including virtual nodes inside
WebView content. Resolution refreshes the field and waits for two agreeing snapshots, with at most three 75 ms
pauses while focus settles. Insertion re-acquires the same captured field before its first write, including virtual
fields without resource ids (matched by framework node identity). With no focus
the kit reports no field. A password node anywhere on the focused path prevents reads, writes and clipboard fallback. The same service also gives the `accessibility` host (no overlay switch needed),
the foreground app that `rules` and `spots: 'per-app'` follow, and the keyboard's top so the bubble rests above it.
The bubble's window never takes focus, so a tap or long press on it leaves the other app's field focused.

```ts
import { focusedField } from '@byokit/overlay/focused-field';

const draft = 'First line\nSecond line';
const capture = new AbortController();
const pending = focusedField.insert(draft, { attempts: 13, retryMs: 150, acceptNewlineLoss: true, signal: capture.signal });
// On capture invalidation: capture.abort();
const result = await pending; // exactly one result, including 'cancelled'
if (result === 'landedWithoutNewlines') { /* typed in, but check the line breaks */ }
```

Cancellation stops subsequent field reads, set-text actions and clipboard fallback; an action already in progress
finishes before native cancellation returns. Every insert settles once. Service detach and native module teardown
cancel pending inserts. Existing calls without a signal keep working.

The bubble responds to TalkBack ACTION_CLICK and touch taps through the same click handler, once per activation.
It carries a TalkBack label (`label` in `start`, or `setLabel`, cleared with `null`), and
`say(text, mood, ms, { announce: true })` reads the pill aloud.

A service that must show the bubble with no JS running (after a reboot or process death) drives it from Kotlin
alone: keep a `ServiceBubble`, call `start(config)` in `onServiceConnected` with the persisted rules, and the bubble
shows on attach and restores after every rebind. `Rules(app-rules).shows(app)` is the per-app decision in Kotlin;
`FocusedFields.read(service)` and `FocusedFields.insert(node, ...)` are the focused-field read and insert for the
captured node. The service can hand over the `AccessibilityNodeInfo` it captured itself (or wrap it with
`FieldNode.of(node)`); the insert retries it and re-acquires only the same field (view id, bounds and package):

```kotlin
class Assistant : AccessibilityService() {
  private lateinit var bubble: ServiceBubble
  private var field: FieldNode? = null
  private var insertCancellation: InsertCancellation? = null

  override fun onServiceConnected() {
    ByokitAccessibility.attach(this)
    bubble = ServiceBubble(ServiceBubble.drawables(this), PrefsSpotStore(this), ServiceBubble.reducedMotion(this))
    bubble.events.add { e ->
      if (e == OverlayEvent.Tap) {
        insertCancellation?.cancel() // invalidate the previous capture before replacing it
        field = FocusedFields.capture(this) // resolves exact focus at tap time
        PanelActivity.launch(this, "Panel", emptyMap())
      }
    }
    bubble.start(ServiceBubble.Config(mood = "calm", label = "Assistant", rules = savedRules()))
  }

  fun insert(draft: String) {
    val node = field ?: return
    insertCancellation?.cancel()
    val cancellation = InsertCancellation() // created before launching the worker
    insertCancellation = cancellation
    thread { // insert waits between tries: off the main thread
      val result = FocusedFields.insert(node, draft, opts = InsertOpts(attempts = 13),
        copy = FocusedFields.clipboard(this), service = this, cancellation = cancellation)
      // result is inserted, landedWithoutNewlines, copied, failed or cancelled, exactly once
    }
  }

  override fun onUnbind(intent: Intent?): Boolean { bubble.stop(); ByokitAccessibility.detach(this); return false }
  override fun onDestroy() { ByokitAccessibility.detach(this); bubble.stop(); super.onDestroy() }
  override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
  override fun onInterrupt() {}
}
```

Both Kotlin `insert` overloads accept an optional `InsertCancellation`; `cancel()` is idempotent and returns
`"cancelled"` from the pending insert. Call `ByokitAccessibility.detach(this)` in `onUnbind` and `onDestroy` to cancel
all service-owned inserts, including those with no explicit cancellation signal. The captured node remains owned
by the caller and must stay alive until the insert returns. `FieldNode.of(node, service)` retains the service owner.

`FocusedFields.capture(service)` does the same capture as a `FieldNode`. An app's own foreground service shows the
bubble with `ServiceBubble(WindowOverlayHost(this), moods, spots)`, which takes no rules and shows everywhere.

**Status: ready to publish (BK-O3).** The bubble, both hosts, the panel, the tap log and the focused field are built
and proven on an Android emulator (API 36). On iOS, the web and Node `overlay.state()` is `unsupported`.

## One screen picture and a point marker

`@byokit/overlay/screen-frame` asks Android's system consent dialog **every time** `frame()` is called. It captures
one PNG after the dialog leaves, stops the projection and foreground service, and returns a local `file://` URI.
It never uploads the picture. iOS, web and Node return `{ status: 'unsupported' }`; no ReplayKit support is claimed.

With the config plugin above installed, this runnable handler starts the window overlay, captures, and points at
the middle of the resulting image. Call it from a button in a foreground Expo development build (Expo Go cannot
load this module). If permission settings open, return to the app and press the button again.

```ts
import { overlay } from '@byokit/overlay';
import { screenFrame } from '@byokit/overlay/screen-frame';

export async function showUmerWhere() {
  const state = await overlay.start({
    host: 'window', mood: 'calm',
    notice: { channel: 'guide', title: 'Umer’s guide', text: 'Ready to help.', icon: 'ic_bubble' },
  });
  if (state === 'needs-permission') { await overlay.openPermission(); return; }
  if (state !== 'on') return;
  const frame = await screenFrame.frame();
  if (frame.status !== 'captured') return;
  const result = await overlay.pointHere({
    x: frame.width / 2, y: frame.height / 2,
    label: 'Umer, tap here', space: frame.space, ms: 2500,
  });
  if (result === 'display-changed') { /* ask for a fresh picture after rotating or resizing */ }
  // Optional early removal: await overlay.dismissPoint();
  // After using the image: await screenFrame.clear();
}
```

`frame()` returns `captured` with `uri`, `mimeType: 'image/png'`, `width`, `height` and `space`; or `cancelled`,
`busy`, `unsupported`, or `failed` with `reason: 'timeout' | 'display-changed' | 'capture-failed'`. Only one request
can run at once. A missing foreground activity fails; denial and system revocation cancel. Capture times out after
six seconds; an abandoned consent request times out after sixty seconds. Module teardown settles pending calls and
stops its capture. The next request deletes the previous cached PNG, even if consent is denied; `clear()` also deletes
it, and rejects during a capture. Copy a picture the app needs to retain before the next request.

`space` describes the default display, including system bars: `width`, `height`, `density`, `densityDpi`, `rotation`
(Android's 0–3 quarter turns), `displayId`, `origin: 'top-left'`, and `unit: 'physical-pixels'`. The PNG is not scaled.
Android 14+ requests the entire default display; an OEM override to app-only capture or a geometry change fails
instead of returning a picture with misleading coordinates. Protected content can be blank, as enforced by Android.
If coordinates came from a resized preview, convert them back to the original image pixels first.

`pointHere({ x, y, label, space?, ms? })` centres a ring at those full-display pixels, draws the label beside it and
announces the full label for TalkBack. It needs an already started overlay (either host). It replaces the previous
marker, defaults to 2500 ms (allowed range 1–60000), and returns `shown`, `not-running`, `needs-permission`,
`display-changed`, or `unsupported`. Pass `frame.space` to reject stale geometry; without it the current display is
used. Coordinates must be finite and inside the display, with a non-empty label. A marker never takes focus or
accepts touches; its window opacity stays below Android's pass-through threshold. The bubble keeps its own existing
touch behavior. `dismissPoint()`, `stop()`, native teardown and host loss remove the marker. Auto-dismiss uses elapsed
time, with no animation. A ring near an edge may be clipped and a long visual label is shortened; TalkBack receives
it in full.

For an account-free emulator demo and repeatable consent/marker proof, build the Expo example with
`EXPO_PUBLIC_SCREEN_DEMO=1` and run `examples/expo/e2e-screen-frame.sh <emulator-serial>`. Its two PNG captures are
uploaded by the Android CI job and linked in the pull request.
