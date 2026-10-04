<h1 align="center">@byokit/approve</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@byokit/approve"><img alt="npm" src="https://img.shields.io/npm/v/@byokit/approve?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
  <img alt="Node 22+ | browsers | React Native" src="https://img.shields.io/badge/platform-Node%2022%2B%20%7C%20browsers%20%7C%20React%20Native-666?style=flat" />
</p>

<p align="center"><strong>An approval for exactly one action, button, app and reason.</strong><br/>
The person approved <em>this</em> request, and only this request: a different or mutated request, a later raise of
the same words, or a past deadline is refused with a typed code. No dependencies, no storage, no clock of its own.</p>

## Install

```sh
npm install @byokit/approve
```

Node 22.18+, browsers and React Native: the kit uses only Web Crypto (`crypto.getRandomValues`), which every
supported platform provides. Requests and grants are frozen plain JSON, so they cross a worker or process
boundary unchanged.

## Quickstart

```ts
import { Approvals, authorizeApproval } from '@byokit/approve';

const approvals = new Approvals(); // { ttlMs = 10 min, now = Date.now }

// Something wants to act; name exactly what the person will see.
const request = approvals.raise({
  action: 'mail.send', button: 'Send reply to plumber', app: 'Mail',
  reason: 'Tenant confirmed the Thursday visit',
});

// The person pressed that button. The grant names that request and nothing else.
const outcome = approvals.approve(request.id);
if (!outcome.ok) { /* 'unknown-request' | 'superseded-request' | 'expired' */ throw new Error(outcome.code); }
const { grant } = outcome;

// Later, at the moment of acting: does this grant authorize exactly this request?
const authorization = authorizeApproval(grant, request);
if (!authorization.ok) throw new Error(authorization.code); // refusal code below
// authorization.subject is the approved subject; act on it.
```

The raising app keeps requests current: raising the same `action` again supersedes the previous request, so a
grant can never be minted for a superseded raise, and a verifier that also holds the registry can compare
`approvals.request(action)!.id === grant.requestId` before acting. A stateless verifier (a queue worker holding
the serialized pair) calls `authorizeApproval(grant, request)` alone; that check is exact and pure, and the
sender decides which pair to hand over.

## Contract

- `new Approvals(options?)`: the host-side registry. No I/O in the constructor; `options` are
  `{ ttlMs?: number = 600_000, now?: () => number }`.
- `raise(subject)`: makes `subject` the current request for its action, superseding any previous raise, and
  returns it with a fresh 128-bit url-safe `id`, `raisedAt` and `expires = raisedAt + ttlMs`. Frozen.
- `approve(requestId)`: the person pressed that request's button. Returns
  `{ ok: true, grant }` or `{ ok: false, code }` with `code` one of:

  | Code | Meaning |
  | --- | --- |
  | `unknown-request` | No such id was ever raised here. |
  | `superseded-request` | The action was raised again; that press settles nothing. Show the current request. |
  | `expired` | Past the request's deadline. |

- `request(action)`: the current `ApprovalRequest` for an action, or `undefined`.
- `authorizeApproval(grant, request, options?)`: pure. `{ ok: true, subject }` or the first refusal:

  | Code | Meaning |
  | --- | --- |
  | `action` | The request's action differs from the approved one. |
  | `button` | The button label differs: the person pressed different words. |
  | `app` | The app identity differs: another app is spending this approval. |
  | `reason` | The reason differs: what the person read is not what is running. |
  | `stale-identity` | The grant names another raise's id, even one with identical words. |
  | `expired` | Past the request's deadline — checked against the grant's copied deadline too, so extending a request's `expires` does not revive a grant. |

A `subject` is four non-empty strings (`action` ≤ 64, `button` ≤ 80, `app` ≤ 60, `reason` ≤ 280 chars); anything
else is a programming mistake and throws the built-in `TypeError`. `approve` and `authorizeApproval` never
throw on unexpected data: a pair that does not match exactly is refused, and garbage-carrying inputs are
refused, never authorized. Bad input never yields `{ ok: true }`.

## Verification limits

The package tests cover the full matrix — exact match, each of `action`/`button`/`app`/`reason`/`stale-identity`/
`expired` refusals, supersession, unknown ids, forged deadlines, frozen outputs — against the real
implementation, with the committed `test/fixtures.json` regenerated from it (`node test/scenario.ts`). The
portable entry bundles for browsers and React Native without Node imports. The kit proves the binding and its
refusals; it does not store, transport, sign or persist anything, does not decide policy, and does not know
which button a person physically pressed — the host renders the button from `request.subject` and calls
`approve` on the press.
