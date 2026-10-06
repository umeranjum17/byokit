# Gmail send with one approval per message

A consumer app signs a person in to Gmail with the `gmail.send` scope through `@byokit/connect`, then sends one plain-text message with `MailSender`; the host's approval function sees the frozen message first, and only `true` sends.

## Sub-features

- `send-approved`: an approved send posts one `messages/send` request whose MIME carries the exact To/Subject/body the approval saw, and returns `{ id, threadId, labelIds }`.
- `send-denied`: an approval returning anything but `true` rejects with `MailError` code `denied` and leaves no Gmail request.
- `send-scope`: a grant missing `gmail.send` fails sign-in with `ConnectError` code `scope`.

## How to get to it (user POV)

- `connect('gmail', { ..., scopes: ['https://www.googleapis.com/auth/gmail.send'] })`, sign in, then `new MailSender(connection, approve, { fetch }).send({ to, subject, body })` (packages/connect/README.md, "Send Gmail").

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-connect-mail-send.mjs"` importing `connect`, `MailSender`, `MailError`, `ConnectError` from `@byokit/connect`. First line after imports replaces `globalThis.fetch` with a function that throws, so any call outside the fixture transport fails. A fixture `fetch` answers `https://oauth2.googleapis.com/token` with fixture tokens and a `scope` field, and records every `gmail.googleapis.com` POST (`JSON.parse(body).raw`) before answering `{ id: 'sent-1', threadId: 'thread-1', labelIds: ['SENT'] }`. Sign in with an in-memory keystore, `client: { id: 'fixture-client' }`, `redirectUri: 'https://app.test/cb'`, and finish the flow with a callback carrying the flow's `state` and a fixture code. Send once approved, once with `() => false`, then sign in again with a token answer scoped `gmail.readonly`. Print the result, the decoded MIME headers and body, the denial's code and the Gmail-call delta, the scope refusal's code, and whether any error message contains a fixture token; exit 1 unless exactly one Gmail POST happened.
- **Run and capture.** `feature=connect-mail-send; entry=@byokit/connect; drive=(node "$scratch_dir/verify-connect-mail-send.mjs")`, then SKILL.md Evidence's capture block. Exit code `0`.
- **Approved send shows.** `approvals asked: 1`, `frozen: true`, `POST /gmail/v1/users/me/messages/send`, headers `To: crew@example.test` with an RFC 2047 `=?UTF-8?B?...?=` subject for non-ASCII text, and the body decoding to the draft with CRLF line ends.
- **Denial shows.** `MailError denied | gmail calls added: 0`.
- **Scope refusal shows.** `ConnectError scope`; `token in errors: false`.

## Gotchas

- Always pass the fixture `fetch` to both `connect` and `MailSender`: `MailSender` otherwise uses `globalThis.fetch`, which reaches Google.
- Never point a drive at a real mailbox or credential; a real send needs the owner's approval first.
