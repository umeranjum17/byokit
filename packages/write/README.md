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

## React Native and Hermes

React Native resolves `@byokit/write` to a portable client. Other bundlers can select it explicitly with
`@byokit/write/portable`. This entry requires an app-supplied `Engine`; it shares the Node client's validation,
protocol 1 gate, methods and result types, and imports no Node modules or default writing engine.

```ts
import { Compose, type Engine } from '@byokit/write/portable';

// The host supplies a local native bridge or another implementation of the Engine seam.
// handle receives { verb, params } and returns the protocol 1 result or error envelope.
function writerFor(engine: Engine) {
  return new Compose({ engine });
}
```

The portable client does not supply a transport. The host owns where its engine runs and whether text leaves the
device. The Node entry and CLI still default to the pinned in-process engine. The bundled default engine is not
supported on Hermes: the current engine contains incompatible lookbehind expressions. Protocol 1 remains
unchanged and does not carry voice samples.

The built-entry fixture in `test/fixtures/portable.ts` uses scripted protocol replies; portability tests verify
package export resolution, results and absence of Node/default-engine imports. Run after `npm run build`:

```sh
sh scripts/test.sh 'packages/write/test/*.test.ts'
sh packages/write/test/hermes.sh /absolute/path/to/hermes
```

The standalone Hermes fixture reports results from the built client over scripted protocol replies; it does not qualify a
native engine bridge or the bundled default engine.

The installed agent CLI uses the same engine:

```sh
npx write platforms
```

Threads come back as the engine writes them, numbered (`1/3 …`).

The kit reads no environment variables, holds no key, makes no network call and writes no file.
