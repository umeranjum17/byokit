# Relay notification action replies

A device that presses a notification button may attach one bounded opaque sealed reply — a free-text answer sealed to
the host's key — and the built `@byokit/relay` action route carries it unchanged to the host's `onAction`, without
reading or storing it, while the one-use token, action authorization and rate limits stay as they were.

## Sub-features

- `reply-forwarded`: `POST /relay/v1/push/action` with `{ token, action, reply }` reaches `onAction` as
  `PushAction.reply`, byte for byte.
- `reply-bounded`: a non-empty string of at most `MAX_ACTION_REPLY` (8192) UTF-8 bytes is accepted, including a
  multi-byte or control-character reply that JSON inflates; anything else is refused with
  `400 { error: 'bad reply' }` before the one-use token is spent.
- `reply-opaque`: the relay neither reads nor stores the reply; its state holds no ciphertext.

## How to get to it (user POV)

- A host publishes a notification with `RelayClient.notify({ id, title, actions: ['answer'] })`; its device receives a
  one-use action token.
- A consumer app posts `{ token, action: 'answer', reply }` to the relay's `/relay/v1/push/action`; the host's
  `onAction` receives `{ device, event, action, reply }`.

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md), plus the built `@byokit/relay` and `@byokit/link`.

- **Write the consumer.** `"$scratch_dir/verify-relay-action-reply.mjs"` imports `Relay`, `RelayClient` from
  `@byokit/relay` and `Host`, `keyPair`, `pairWithOffer` from `@byokit/link`. It opens a loopback relay with a
  stand-in `push.fetch` (no egress), registers a host, pairs a device, subscribes an Expo token, notifies with
  `actions: ['answer']`, and reads the one-use token from the recorded push message.
- **Run and capture.** `feature=relay-action-reply; entry=@byokit/relay; drive=(node "$scratch_dir/verify-relay-action-reply.mjs")`,
  then run SKILL.md Evidence’s capture block. Exit code `0`.
- **Forwarded unchanged, not stored.** The successful press logs status `200` with `value.got === reply`, the host
  callback shows the same `reply`, and `reply stored by relay?` is `false`.
- **Bounded, and the token survives a refusal.** An 8193-byte reply logs `400 {"error":"bad reply"}` and the
  next press with the same `token` logs `200`, so the token was not spent.
- **The oversized leg is the error case**, showing the real typed HTTP status and body.

## Gotchas

- Import only the public entries; never `packages/relay/src`.
- The stand-in `push.fetch` replaces Expo/Web Push; no provider, account or egress is used.
- Close the host, relay client, relay and HTTP server (the consumer does) before exit.
