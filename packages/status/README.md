# @byokit/status

One ongoing job the person started, shown as a status-bar chip on Android 16 (a Live Update: a promoted ongoing
notification), as an Expo module. It has a counts-only copy for the lock screen and screen sharing, up to three actions
that need the phone unlocked, and a dismissal that sticks until the job ends. On iOS, the web, Node and Android below
16 (API 36) it reports `unsupported` ([docs/capability-kits.md](../../docs/capability-kits.md) §12).

```ts
import { status, stateWords } from '@byokit/status';

status.show({
  title: 'Scribe is working', text: '2 need you',   // private: only on an unlocked phone
  chip: '2 busy', publicText: '2 working',          // public: counts and fixed words only, chip at most 7 characters
  promote: true, timeoutMs: 15 * 60_000,
  actions: [{ id: 'needs', label: 'See what needs you' }, { id: 'ask', label: 'Ask Chief' }],
});
const off = status.on('action', ({ id }) => open(id));
status.on('dismissed', () => { /* the person swiped it away: show() posts nothing until clear() */ });
if ((await status.state()) === 'off') await status.openSettings();
status.clear();   // the job ended
```

Add the config plugin to `app.json`: `"@byokit/status"`. It adds `POST_PROMOTED_NOTIFICATIONS`, which has no prompt.
The library's manifest brings `POST_NOTIFICATIONS`; the app asks for that one itself (for example with
`PermissionsAndroid`) and shows `stateWords('needs-permission')` until it is granted.

- **Keep calling `show()`** from the app's own refresh. An unchanged call posts nothing, except that once half of
  `timeoutMs` has passed it posts again to keep the chip. A dead app's chip clears itself after `timeoutMs`.
- **Posts are throttled** to one per 1.5 s; the latest options win.
- **Use it for work the person started**, with a start and an end. Android's rules forbid alerts, chat, ads and quick
  access to app features. Call `clear()` when the work ends.
- There is no foreground service: keeping the app alive is the app's business.

**Status: in development.** `private` until the emulator proof on an Android 16 QPR2 (API 36.1) image lands (BK-S1).
