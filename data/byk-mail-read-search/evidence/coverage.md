# Mail read/search coverage report (slice 1: Gmail)

Scope: typed Gmail read/search journeys on a `Connection` (`MailReader` in
`@byokit/connect`). No sends, no live mailbox, no credentials leave the device.

## Providers

| Provider | Read/search | Notes |
|---|---|---|
| gmail (`gmail.readonly`) | IMPLEMENTED | `MailReader`: `search`/`list`/`get` on Gmail REST v1 |
| calendar (events) | UNSUPPORTED | Still raw `token()`; named next slice below |
| drive/notion/canva/MCP | OUT OF SCOPE | Typed `mcp()` path already exists, not mail |
| `@byokit/write` gmail platform | SEND-SIDE ONLY | Compose/check/split; no read — unchanged |
| `@byokit/outbox` | SEND QUEUE ONLY | Payload-opaque; no read — unchanged |

## Operations (implemented)

- `search(query, { maxResults, pageToken, signal })` — Gmail `q` syntax, one page of envelopes.
- `list({ maxResults, pageToken, signal })` — same without `q`.
- `get(id, { signal })` — envelope plus decoded body.
- Errors: `MailError` + `MailErrorCode` (`invalid` | `network` | `signed-out` | `rate-limited`);
  401 retries once with a fresh token, then `signed-out`; 429 carries `until` from
  `Retry-After`; caller aborts reject with `signal.reason`; bad args reject
  `TypeError`/`RangeError`. No token material in messages (asserted in tests).

## Pagination / content limits

- Pagination is the provider's opaque `pageToken`; `maxResults` 1..500, default 20;
  `resultSizeEstimate` passed through when numeric.
- Envelopes carry Subject/From/To/Date headers (absent reads `''`), snippet, label ids.
- `get` decodes `text/plain` parts depth-first (portable base64url, no `Buffer`);
  `text/html`-only mail reads as `''` with the snippet still shown.
- Body cut at `maxBodyChars` (default 20000, positive int); `body.truncated` flags the cut.
- One metadata fetch per listed id (no Gmail batch yet); a mid-page failure fails the page.

## Unsupported / out of scope (this slice)

Sends of any kind; drafts, labels, modify, watch/push; attachments; `text/html`
fallback; Gmail batch requests; Calendar typed kit; live mailboxes, devices,
credentials, paid accounts, releases; speculative support claims.

## Proof and its limits

- Proof recipe followed: typed journeys driven against fixtures/fake transports on the
  real kit — unit-style fixtures in `packages/connect/test/mail.test.ts` (4 tests),
  plus a consumer drive against built `packages/connect/dist` (see `proof.log`).
- Limits: NO live provider was touched; pagination uses 2 canned pages; 401/429/500/
  malformed legs are single canned answers; the `Connection` seating check proves
  construction fit only (no sign-in performed — sign-in stays covered by existing tests).
- Gates on this head: `npm run build` ok, `npm run check` ok, `scripts/test.sh`
  `packages/connect/test/*.test.ts` 22 pass / 0 fail, full `npm test` 2003 pass /
  0 fail (25 skipped, pre-existing), `node scripts/readme-check.ts` 0 new failures
  (30 kits), `npm run release -- lint --base origin/main` ok.

## Size

Slice 1 adds 271 lines (+162 `src/mail.ts`, +87 `test/mail.test.ts`, +18 README,
+2 `src/index.ts`, +2 CHANGELOG), inside the 299-line first-slice budget.
Evidence files in this folder are not counted as code.

## Rest (not built — later slices)

1. Calendar typed read on the same credential pattern (~same size as this slice).
2. Gmail batch (`batch/gmail/v1`) for list-then-metadata round trips.
3. `text/html` fallback and attachment metadata (`format=full` already fetches them).
4. Mid-page item failure policy (skip-and-continue vs fail-page) — currently fail-page.
5. Live-loopback qualification (fake OAuth + loopback callback, still no real mailbox).
