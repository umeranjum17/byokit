# @byokit/write

Drafting in a person's voice, without a model call: voice rules, the places a post can go with their length limits,
the brief lines a writer follows, checks on drafts (fits, voice, stock phrasing, kept the facts) and thread splits.
The app or agent writes the drafts; this kit checks them over the pinned public
[`ownvoice-engine`](https://www.npmjs.com/package/ownvoice-engine) package, loaded in process.

It ships a typed client (`new Compose()`), a `write` agent CLI with plain TOON output, and `./testing` (a fake
engine and a contract suite).

## Install

Node 22.18 or later:

```sh
npm install @byokit/write@0.1.0
```

The kit installs its exact dependency `ownvoice-engine@0.1.0` from npm. No engine checkout or separate install is
needed. The committed protocol 1 schema is in `schema/engine-protocol-1.json` (sha256 in `ENGINE_SCHEMA_SHA256`);
`npm run gen:write` regenerates the typed wire. CI's `write-engine` job runs the real engine contract in process
and through its own bin.

```ts
import { Compose } from '@byokit/write';

const writer = new Compose();
const draft = 'Umer shipped the first version today.';
const [check] = await writer.check({ drafts: [draft], platform: 'x' });
console.log(check.fits, check.words);
```

The installed agent CLI uses the same engine:

```sh
npx write platforms
```

Threads come back as the engine writes them, numbered (`1/3 …`).

The kit reads no environment variables, holds no key, makes no network call and writes no file.
