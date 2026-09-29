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
and its config sets `android:canRetrieveWindowContent="true"` and
`android:accessibilityFlags="flagRetrieveInteractiveWindows"` (the example's is
[`examples/expo/modules/a11y-demo`](../../examples/expo/modules/a11y-demo)). Then:

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
the focused node itself when it is editable, else the first editable focused descendant (WebView/Chrome). Password
fields are never read or typed into. The same service also gives the `accessibility` host (no overlay switch needed),
the foreground app that `rules` and `spots: 'per-app'` follow, and the keyboard's top so the bubble rests above it.
The bubble's window never takes focus, so a tap or long press on it leaves the other app's field focused.

```ts
const result = await focusedField.insert(draft, { attempts: 13, retryMs: 150, acceptNewlineLoss: true });
if (result === 'landedWithoutNewlines') { /* typed in, but check the line breaks */ }
```

The bubble carries a TalkBack label (`label` in `start`, or `setLabel`, cleared with `null`), and
`say(text, mood, ms, { announce: true })` reads the pill aloud.

A service that must show the bubble with no JS running (after a reboot or process death) drives it from Kotlin
alone: keep a `ServiceBubble`, call `start(config)` in `onServiceConnected` with the persisted rules, and the bubble
shows on attach and restores after every rebind. `Rules(app-rules).shows(app)` is the per-app decision in Kotlin;
`FocusedFields.read(service)` and `FocusedFields.insert(node, ...)` are the focused-field read and insert for the
captured node.

**Status: ready to publish (BK-O3).** The bubble, both hosts, the panel, the tap log and the focused field are built
and proven on an Android emulator (API 36). On iOS, the web and Node `overlay.state()` is `unsupported`.
