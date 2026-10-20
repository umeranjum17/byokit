# House Google client file

A consumer app on a computer loads the one house Google client (the Desktop-app JSON Google offers to download, kept mode 600 at `~/.config/byokit/google-oauth-client.json`) with `googleClientFile(path)`, then signs a person in to Gmail over loopback with it and sends through `MailSender`.

## Sub-features

- `client-missing`: an absent file returns `null`; a Gmail sign-in without a client rejects `ConnectError` `configuration` with no provider call.
- `client-refused`: a file other users can read, a non-Desktop (`web`) client or a FIFO is refused with a plain message that never repeats the file's contents.
- `consent-approved`: the consent URL carries the file's client id, both Gmail scopes, `access_type=offline` and `prompt=consent`; the token exchange sends the file's secret.
- `consent-denied`: an `error=access_denied` callback rejects `done` with `ConnectError` `declined` and saves nothing.
- `send-approved` / `send-denied`: one Gmail POST on approval; `MailError` `denied` and no request on refusal.

## How to get to it (user POV)

- `googleClientFile(path)` and `connectLoopback('gmail', { client, scopes, open })` from `@byokit/connect/node`, then `MailSender` from `@byokit/connect` (packages/connect/README.md, "The house Google client").

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-connect-house-client.mjs"` importing `googleClientFile`, `connectLoopback` from `@byokit/connect/node` and `connect`, `MailSender`, `MailError`, `ConnectError` from `@byokit/connect`. Keep the real `fetch` for loopback callbacks only and replace `globalThis.fetch` with one that throws for any other host. Write fixture client files under `"$scratch_dir"` (`installed` with a `*.apps.googleusercontent.com` id and fixture secret): missing, mode 644, `web`, a `mkfifo -m 600` pipe, then a valid mode 600 file. A fixture `fetch` answers `https://oauth2.googleapis.com/token` (recording the form) and records `gmail.googleapis.com` POSTs, answering `{ id: 'sent-1', threadId: 't-1', labelIds: ['SENT'] }`. In `open`, fetch the `redirect_uri` with the flow's `state` and either `error=access_denied` or a fixture `code`. Print each leg's outcome, whether any error message contains the fixture secret, and exit 1 unless exactly one Gmail POST happened.
- **Run and capture.** `feature=connect-house-client; entry=@byokit/connect/node; drive=(node "$scratch_dir/verify-connect-house-client.mjs")`, then SKILL.md Evidence's capture block. Exit code `0`.
- **Shows.** `missing: null`; `signIn without client: ConnectError configuration ... | provider calls: 0`; `mode 644 refused`, `web refused` and `fifo refused` with plain messages; `consent denied: ConnectError declined ... | saved: false`; `consent: client_id ok, scopes ok, offline consent ok, secret sent ok | saved: true`; `send denied: MailError denied ... | gmail calls added: 0`; `send approved: sent-1 | gmail POSTs: 1`; `secret in errors: false`.

## Gotchas

- Pass the fixture `fetch` to `connectLoopback` and `MailSender`; only the loopback callback uses the real `fetch`.
- Never read the real `~/.config/byokit/google-oauth-client.json` in a drive; fixture files only. A live consent needs the owner's click and a real send needs the owner's approval first.
