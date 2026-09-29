<h1 align="center">@byokit/ui-core</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@byokit/ui-core"><img alt="npm" src="https://img.shields.io/npm/v/@byokit/ui-core?style=flat&label=npm" /></a>
  <a href="https://github.com/umeranjum17/byokit/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/umeranjum17/byokit/ci.yml?style=flat&branch=main" /></a>
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-666?style=flat" /></a>
</p>

<p align="center"><strong>Headless sign-in, pairing and runtime-kit state, in plain words, for any UI.</strong><br/>
It turns what your back end reports into the phase to draw and the sentence to show: a "Sign in with …" sheet, a
pairing sheet, the link's status, the route a phone takes home, and a runtime kit's runs, approvals and agents. Your
app keeps its own look. Everything except the React hooks is framework-free.</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/docs/images/pwa-2-code.png" width="240" alt="A phone-width page titled 'byokit in a browser' reading 'Signing in to ChatGPT…' and 'On the ChatGPT page, type this code:', the code WDJB-MJHT in large letters, an 'Open ChatGPT' link and a Cancel button." />
  <img src="https://raw.githubusercontent.com/umeranjum17/byokit/main/examples/herdr-kit/docs/2-compare.png" width="240" alt="A phone-width page titled 'Agents' with a 'Pair this phone' card reading 'Check your computer shows these two words, then say yes there.' above the words 'coast comet'." />
</p>

<p align="center"><sub>Left: the <code>code</code> phase from <code>phaseOf()</code>, drawn by <a href="../../examples/pwa">examples/pwa</a> against the mock OpenAI sign-in. Right: <code>pairingView()</code>'s <code>compare</code> words, drawn by <a href="../../examples/herdr-kit">examples/herdr-kit</a>.</sub></p>

## Install

```sh
npm install @byokit/ui-core
```

[![npm](https://img.shields.io/npm/v/@byokit/ui-core?style=flat&label=)](https://www.npmjs.com/package/@byokit/ui-core) · [Latest release](https://github.com/umeranjum17/byokit/releases?q=ui-core-v) · [All releases](https://github.com/umeranjum17/byokit/releases)

## Quickstart

```sh
npm install @byokit/ui-core
```

React is an optional peer dependency, needed only for the hooks (`useSignIn`, `useRun`, `useApprovals`,
`useHerdrTree`, `useBlocked`).

```ts
import { phaseOf, stepOf } from '@byokit/ui-core/phase';
import { describeRoute } from '@byokit/ui-core/route';
import { consentWords, linkWords, pairingView, qrMatrix } from '@byokit/ui-core/link';

// What the back end reports: a sign-in waiting on a typed code.
const phase = phaseOf({ ready: false, signIn: { state: 'waiting', via: 'code', code: 'ABCD-1234' } });
console.log(phase, stepOf(phase));
console.log(phaseOf({ ready: true, work: true }));
console.log(phaseOf({ signIn: { state: 'failed', why: 'busy' } }));

console.log(describeRoute('wss://home.tail1234.ts.net/link'));
console.log(describeRoute('ws://100.101.102.103:7777'));

console.log(consentWords({ hostName: 'Kitchen computer', role: 'control' }));
console.log(pairingView({ phase: 'compare', hostName: 'Kitchen computer', words: 'coast comet' }));
console.log(linkWords('offline', 'Kitchen computer'));
console.log(qrMatrix('hello').length, 'rows');
```

Output from running it with Node:

```text
code 1
work
busy
Tailscale
Private network
Pair with Kitchen computer? This device will be able to see and change things on it, until you remove it there.
{
  phase: 'compare',
  title: 'Check Kitchen computer shows these two words, then say yes there.',
  words: 'coast comet'
}
Can't reach Kitchen computer right now. This device keeps trying by itself.
25 rows
```

In React, `useSignIn` drives the whole sheet from three calls to your back end:

```ts
import { useSignIn } from '@byokit/ui-core';
import type { AccountView } from '@byokit/ui-core';

// Your back end's routes; the hook only needs these three calls.
declare const api: {
  account(): Promise<AccountView | null>;
  signIn(body?: { via?: 'code'; fresh?: boolean }): Promise<unknown>;
  cancel(): Promise<unknown>;
};

export function useChatGptSheet() {
  const s = useSignIn({ read: () => api.account(), start: (b) => api.signIn(b), cancel: () => api.cancel() });
  // s.phase: what to draw. s.code / s.url: what to show. s.start({ via: 'code' }): "Having trouble? Use a code instead".
  // s.cancel(), s.close(), s.keepWork(): the sheet's buttons. Leave `start` out when something else starts the
  // sign-in: the sheet then only watches, and nothing begins as it opens.
  return s;
}
```

## API at a glance

| Export | What it does |
|---|---|
| `phaseOf(account, { offline, cancelled, keepWork })` | The sign-in phase to draw, from an `@byokit/accounts` `view()` plus whether the account is signed in |
| `stepOf(phase)` | Where the three-step progress bar ("Open", "Say yes", "Done") stands |
| `useSignIn({ read, start?, cancel, offline?, ms?, pinned? })` | React hook: starts the sign-in as the sheet opens, polls, and handles cancel, close, keep-work and "use a code instead"; without `start` it only watches and nothing begins |
| `describeRoute(url, kind?)` | Names the route a dial address takes, for a pairing or settings screen |
| `qrMatrix(text, { border }?)` | The pairing QR as rows of dark and light modules, with its quiet border (2 unless given) |
| `qrText(text, { border }?)` | The same QR as half-block text rows for a terminal |
| `consentWords({ hostName, role, device?, detail? })` | The question before pairing |
| `pairingView({ phase, hostName?, words?, error?, device?, detail? })` | The pairing sheet's title and words for each phase |
| `linkWords(status, hostName)` | The link's status in one sentence |
| `runStore(oc)`, `runView(state, { words, name })` | One run: the reply streaming in, the tool at work, how it ended in the kit's words |
| `approvalsStore(oc)`, `approvalWords(a, words, helper)` | The approvals waiting for a yes, live, each gone when answered or expired |
| `herdrStore(hd)`, `herdrTreeView(tree)`, `blockedView(state)` | Herdr's agents by where they run, and the ones waiting for an answer, live |
| `useRun`, `useApprovals`, `useHerdrTree`, `useBlocked` | React hooks over those stores |
| Types | `Phase`, `SignInView`, `AccountView`, `UseSignIn`, `Route`, `PairPhase`, `Role`, `DeviceKind`, `LinkStatus`; `RouteKind` from `@byokit/ui-core/route` |

Entry points: `@byokit/ui-core` (everything, including the React hooks), `@byokit/ui-core/phase`,
`@byokit/ui-core/route`, `@byokit/ui-core/link` and `@byokit/ui-core/kits` (no React dependency).

## Sign-in phases

`phaseOf()` turns what your back end reports (an `@byokit/accounts` `view()` plus whether the account is signed in)
into the phase to draw:

| Phase | Meaning |
|---|---|
| `opening` | getting the provider's page or a code ready |
| `waiting` | say yes on the provider's page |
| `code` | type this code on the provider's page instead |
| `done` | signed in, and it works |
| `work` | signed in with a work plan: offer a personal one |
| `cancelled` | declined on the page, or cancelled here |
| `busy` | something else on this computer is signing in |
| `expired` | the page or code ran out of time |
| `failed` | anything else, with a plain sentence |
| `offline` | the home computer isn't answering |

`phaseOf()` and `stepOf()` also come from `@byokit/ui-core/phase`, which has no React dependency.

## Routes

`describeRoute(url, kind?)` (also `@byokit/ui-core/route`, no React) names the route a dial address takes, for a
pairing or settings screen. Pass `tailscale`, `direct`, `private`, or `lan` when known (map reach's `tailscale-direct`
to `direct`); without provenance, 100.64/10 is labeled Private network rather than assumed to be Tailscale.

## Pairing words

Pairing with `@byokit/link`, from `@byokit/ui-core/link` (no React either):

- `qrMatrix(offer.text, { border }?)`: the pairing QR as rows of dark and light modules, with its quiet border
  (2 unless given), to draw in any UI.
- `qrText(offer.text, { border }?)`: the same QR as half-block text rows, so `console.log` in a setup script shows a
  code a phone can scan.
- `consentWords({ hostName, role, device?, detail? })`: the question before pairing ("Pair with Kitchen computer? This device
  will be able to see and change things on it, until you remove it there."). `device` names the pairing side when it
  isn't the app (`phone`, or `browser` for the web pairing link); `detail` adds one app sentence after.
- `pairingView({ phase, hostName, words, error, device?, detail? })`: scan, compare the two words, waiting for a yes, paired, failed.
- `linkWords(status, hostName)`: the link's status in one sentence.

## Runtime kits' state

Runtime kits' state, from `@byokit/ui-core/kits` (no React), typed to fit `@byokit/openclaw/device` and
`@byokit/herdr/device` as they are:

- Runs: `runStore(oc)` with `send(message)` and `stop()`; `runView(state, { words, name })` gives the reply so far, the
  tool at work and, for a failed run, the kit's sentence (`words` from `@byokit/openclaw/device`, `name` "ChatGPT").
- Approvals: `approvalsStore(oc)` keeps the waiting list live (each leaves when answered anywhere or when it expires);
  `approvalWords(approval, words, 'Your helper')` asks the question.
- Herdr: `herdrStore(hd)` keeps the tree and the agents waiting for an answer live from one stream;
  `herdrTreeView(tree)` groups the agents by where they run, with the status the kit's `agentWords` takes;
  `blockedView(state)` names each waiting agent.
- Each store is `{ get, subscribe }`: draw from `get()` in any UI; the first `subscribe` starts following, the last
  unsubscribe stops. `runStep`, `approvalsStep` and `herdrStep` are the reducers underneath.

In React or React Native: `useRun(oc, { words, name })`, `useApprovals(oc)`, `useHerdrTree(hd)` and `useBlocked(hd)`,
with the device client made once (`useMemo(() => herdrDevice(link), [link])`).

## Links

- [byokit](../../README.md): the monorepo and its other packages, including
  [`@byokit/accounts`](../accounts) and [`@byokit/link`](../link).
- Examples: [`examples/pwa`](../../examples/pwa) (sign-in phases in a browser),
  [`examples/herdr-kit`](../../examples/herdr-kit) (pairing words and `herdrStore` from a phone browser),
  [`examples/expo`](../../examples/expo) (React Native).
- [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](../../NOTICE).
