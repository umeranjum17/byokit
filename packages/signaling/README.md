<h1 align="center">@byokit/signaling</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@byokit/signaling"><img alt="npm" src="https://img.shields.io/npm/v/@byokit/signaling?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Node 22+ | browsers | React Native" src="https://img.shields.io/badge/platform-Node%2022%2B%20%7C%20browsers%20%7C%20React%20Native-666?style=flat" />
</p>

<p align="center"><strong>One bridge socket, correlated requests and typed session events.</strong><br/>
A portable WebRTC signaling adapter with a fresh socket on every authorization. No runtime dependencies,
Node imports, native modules, accounts, discovery or automatic authority renewal.</p>

## Install

```sh
npm install @byokit/signaling
```

Node 22.18+, browsers and React Native provide the global `WebSocket` used by the adapter. An environment without
one can pass `{ WebSocket: YourWebSocket }` to either factory. The injected constructor implements `WebSocketLike`.

## Quickstart

```ts
import { bridgeSignaling } from '@byokit/signaling';

const signaling = bridgeSignaling('wss://your-host/desktop?token=YOUR_TOKEN');
const off = signaling.subscribe(event => {
  if (event.kind === 'description') console.log(event.description.type);
});
try {
  const capabilities = await signaling.request<{ protocol: number }>('capabilities');
  console.log(capabilities.protocol);
} finally {
  off();
  signaling.close();
}
```

### A phone screen in about 30 application lines

For an app using published `@desklink/react-native@0.3.1`, install it with `npx expo install @desklink/react-native`,
configure its documented native plugins, and rebuild the app. The following `App.tsx` uses that package's
`useDesktopSession` contract; the signaling kit itself does not depend on Expo or that receiver.

```jsx
import { useEffect, useMemo } from 'react';
import { Button, Text, View } from 'react-native';
import { DesktopView, useDesktopSession, CONTROL_PERMISSIONS } from '@desklink/react-native';
import { authorizeBridge } from '@byokit/signaling';

export default function App() {
  // Supply the reachable authenticated bridge URL from your app's pairing flow.
  const url = 'wss://your-host/desktop?token=YOUR_TOKEN';
  const authorize = useMemo(() => authorizeBridge(url, {
    permissions: CONTROL_PERMISSIONS,
  }), [url]);
  const desktop = useDesktopSession({ authorize });
  useEffect(() => () => authorize.close(), [authorize]);
  return (
    <View style={{ flex: 1 }}>
      <Button title="Connect" onPress={() => void desktop.connect()} />
      <Text>{desktop.snapshot.status}</Text>
      <DesktopView sessionId={desktop.nativeId} style={{ flex: 1 }} />
      <Button title="Enable control" onPress={() => desktop.setInputEnabled(true)} />
      <Button title="Disconnect" onPress={async () => {
        try { await desktop.close(); } finally { authorize.close(); }
      }} />
    </View>
  );
}
```

Connect is a user action. Every call to `authorize` closes its previous socket and creates a new adapter, even
following `authorize.close()` or an unexpected disconnect. `authorize.close()` releases the current socket;
it does not permanently disable the callback. Keep the callback stable between renders, and dispose it on unmount.
Use `ws://` only over loopback or an already protected tunnel; it is plaintext. Never log a token-bearing URL.

## Contract

- `bridgeSignaling(url, options?)`: returns `BridgeSignaling`, structurally implementing `Signaling`, plus `close()`.
- `request<T>(method, params?)`: sends `{id, method, params?}`, preserving every method, parameter and result field.
  Request parameters use the engine's snake_case wire names. Concurrent results correlate by id, not arrival order.
  Calls made during socket opening wait for it. No request timeout or reconnect loop is imposed; your session client
  owns deadlines and retries. Dispose the adapter to cancel outstanding requests.
- `subscribe(handler)`: delivers the receiver's complete typed `SessionEvent` union: description, candidate, state,
  cursor, restoreToken and revoked, retaining session ids and revocation codes. Returns an unsubscribe function.
  Unknown or malformed events are ignored. This is the receiver contract, not a raw stream of every engine event:
  capture.stopped, keyframeRequest and input have no member in that union and are not delivered.
- `close()`: idempotently rejects opening/pending requests, removes listeners and subscribers, and closes the socket.
- `authorizeBridge(url, session, options?)`: an async authorization callback returning `{ signaling, session }`, plus
  `close()`. The session object is passed through unchanged. Authorization resolves with the adapter immediately;
  its first request waits for WebSocket upgrade and rejects if that fails.
- `toSessionEvent(event, params)`: the same event mapping, exported for apps with another authenticated transport.

The bridge wire is `{id, result}` or `{id, error: {code, message}}` for replies and `{event, params}` for events.
An id-less malformed-request error cannot be correlated and is ignored. The stock bridge checks `?token=` at upgrade,
performs its own engine handshake, chooses the source on the host, and refuses client-selected sources and local
frame reads. It never forwards host-local restore tokens or frame-change events; the corresponding type is retained
for receiver compatibility, not a promise that the stock bridge emits it.

### Errors and disconnections

Requests reject with `SignalingError`, whose `code` is:

| Code | Meaning |
| --- | --- |
| `transport` | Upgrade failed, connection lost, or send failed. A refused token and unreachable bridge are indistinguishable through the portable WebSocket API. |
| `closed` | The app explicitly disposed this adapter. |
| Any bridge/engine code | Passed through unchanged, with its message; for example `source`, `operation`, `unsupported-protocol`, `permission` or `consent-timeout`. |

Missing WebSocket or an empty URL is a synchronous `TypeError`. Constructor transport failures are synchronous
`SignalingError`s. A lost previously-open socket emits one synthetic `revoked` event with `code: 'transport'`, then
clears subscribers. Explicit close emits no revocation. A new authorization never receives events from the old socket.

## Verification limits

The package tests use a loopback mock bridge and controllable WebSockets: concurrency, refusals, events, close/error
cleanup, late callbacks and repeated authorization. The portable entry bundles without Node runtime imports.
Packed-install qualification separately checks this screen against published receiver types and runs the adapter
against a stock host on loopback. Type/bundle and transport fixtures do not prove a physical phone connection,
a rendered frame, portal consent, clipboard or input on a person's desktop.
