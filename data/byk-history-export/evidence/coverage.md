# Mail history/export coverage report (slice 1: Gmail, owner-bound)

Scope: access-controlled history retrieval and export on a signed `Connection`
(`MailHistory` in `@byokit/connect`). Authentication, storage and history are
reused, not duplicated: `Connection.token()` is the only credential,
`MailReader.search`/`list` is the only history source, the host's per-person
keystore is the only store. No sends, no live mailbox, no credentials leave the
device, no complete-history claims beyond what is proven below.

## Stores

| Store | Role | Notes |
|---|---|---|
| Host per-person keystore (`Keystore` from `@byokit/secrets`) | Authentication | `Connection` seats the grant per person/provider/client; a second person's handle on the same store reads nothing (existing isolation journey, unchanged) |
| `MailHistory` owner binding | Authorization | Host passes `owner` once; every call names `principal`; mismatch rejects `HistoryError denied` before any provider fetch (proven: 0 fetches during denial) |
| No new store | — | Grants, envelopes and exports are never persisted by this slice |

## Formats

| Format | Output | Notes |
|---|---|---|
| `json` | 2-space array of `MailEnvelope` | Round-trips through `JSON.parse` in tests and drive |
| `csv` | `id,threadId,subject,from,to,date,snippet,labelIds` + one row per envelope | `labelIds` joined with `|`; cells with `,"` or newline are quoted per RFC 4180 |

## Scope (implemented)

- `messages({ principal, query?, maxMessages?, pageSize?, signal? })` — envelopes
  across pages (provider's opaque `pageToken`), oldest page first, cut at
  `maxMessages` (default 100, at most 500); `pageSize` 1..500 for `MailReader`.
- `export({ ..., format })` — same envelopes serialized as `json` or `csv`.
- Principal checks run before argument validation of the provider call and before
  any fetch; bad owner/principal/query/size/format reject `TypeError`/`RangeError`
  without touching the transport.
- Provider failures keep their `MailError` code, `status` and `until` under
  `HistoryError`; messages stay plain sentences with no token material (asserted).

## Unsupported operations / out of scope (this slice)

Sends of any kind; drafts, labels, modify, watch/push; message bodies in export
(envelopes only); attachments; `text/html` fallback; Gmail batch requests;
Gmail `history.list` (change deltas) — retrieval pages `messages.list` snapshots
instead; multi-owner or group principals; persistence of exports; calendar/drive/
notion typed kits; live mailboxes, devices, credentials, paid accounts, releases;
speculative support claims.

## Proof and its limits

- Proof recipe followed: primitives driven against fixtures/fake stores on the real
  kit — `packages/connect/test/history.test.ts` (2 journeys: a PKCE-signed
  `Connection` reads 3 envelopes across 2 canned pages and exports both formats;
  a foreign principal is denied with 0 provider fetches), plus a consumer drive
  against built `packages/connect/dist` (see `proof.log` and `.verify-artifacts/`).
- Limits: NO live provider was touched; pagination uses 2 canned pages;
  the OAuth leg is one canned token answer; denial is proven for one foreign
  principal on fixtures, not for every principal shape; exports are proven for 3
  envelopes, not provider-scale mailboxes.
- Gates on this head: `npm run build` ok, `npm run check` ok,
  `scripts/test.sh packages/connect/test/*.test.ts` 24 pass / 0 fail, full
  `npm test` 2006 pass / 0 fail (25 skipped, pre-existing),
  `node scripts/readme-check.ts` 0 new failures (30 kits),
  `npm run release -- lint --base origin/main` ok.

## Size

Slice 1 adds 182 lines (+89 `src/history.ts`, +74 `test/history.test.ts`, +16
README, +2 `src/index.ts`, +1 CHANGELOG), inside the 299-line first-slice budget.
Evidence files in this folder are not counted as code.

## Rest (not built — later slices)

1. Bodies-in-export opt-in (`get` per envelope, bounded, with a truncation column).
2. Gmail `history.list` deltas (change feed) on the same owner-bound pattern.
3. Gmail batch (`batch/gmail/v1`) for list-then-metadata round trips.
4. Calendar typed history on the same credential pattern.
5. Live-loopback qualification (fake OAuth + loopback callback, still no real mailbox).
