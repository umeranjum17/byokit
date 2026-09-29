# @byokit/compose

Drafting in a person's voice, without a model call: voice rules, the places a post can go with their length limits,
the brief lines a writer follows, checks on drafts (fits, voice, stock phrasing, kept the facts) and thread splits.
The app or agent writes the drafts; this kit checks them over the pinned public
[`ownvoice-engine`](https://www.npmjs.com/package/ownvoice-engine) package, loaded in process.

It ships a typed client (`new Compose()`), a `compose` agent CLI with plain TOON output, and `./testing` (a fake
engine and a contract suite).

**Status: in development.** This is the BK-0 scaffold ([docs/capability-kits.md](../../docs/capability-kits.md) §9.2):
types, signatures and words are frozen; behaviour lands work package by work package. The package stays private until
its contract passes against the real pinned engine in CI (BK-P2).

The kit reads no environment variables, holds no key, makes no network call and writes no file.
