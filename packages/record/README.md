# @byokit/record

Record a screen or a desktop into a take, then make a video from it. The kit owns an open **recorder protocol v1**
([docs/capability-kits.md](../../docs/capability-kits.md) §6) and drives any recorder that implements it; the app
passes that recorder by absolute path. The kit ships no recorder of its own.

## Install

```sh
npm install @byokit/record
```

## Quickstart

`new Capture({ bin, stateDir })` gives `hello()`, `record()` (an async iterator of recording events; an
abort signal stops the recording), `stop()` and `make()`. The app passes its recorder by absolute path; here the
kit's scripted fake from `@byokit/record/testing` stands in so the block runs as is:

```ts
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Capture } from '@byokit/record';
import { fakeRecorder } from '@byokit/record/testing';

const dir = mkdtempSync(join(tmpdir(), 'record-quickstart-'));
const fake = fakeRecorder({ dir: join(dir, 'fake') });
const capture = new Capture({ bin: fake.bin, stateDir: join(dir, 'state') });

console.log(await capture.hello());

const root = join(dir, 'takes');
mkdirSync(root);
for await (const e of capture.record({ source: 'x11::99', root, maxSeconds: 1 })) {
  if (e.event === 'done') console.log('take:', e.take);
}
```

Consent to record a screen is always the system's own
prompt; the kit never answers or retries it. A planner key, when the app passes one, reaches the recorder only on a
file descriptor, never through the environment, the command line or a file.

**Status: ready to publish.** The client, supervision, recorder protocol v1 and words are built, and the contract
suite passes against a conforming recorder in TakeOne's conformance run (BK-C3).

Tests run only against the kit's fake recorder, in `npm test` and CI. A real recorder runs on the owner's machine or
in a lab, where the contract suite is run against it; there is no download helper, because recorders ship outside
byokit. The kit pins a protocol, not a recorder version, so the upstream pin watch has nothing to watch here.

The kit reads no environment variables and gives every recorder process an environment built from nothing.
