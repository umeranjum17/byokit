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

**Status: in development.** This is BK-O1 (§9.4): the JS core, the Expo module layout, the manifest and the config
plugin. The native module resolves `off` and rejects everything else until the bubble lands (BK-O2); the focused
field is never available until BK-O3.
