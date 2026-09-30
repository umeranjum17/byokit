# @byokit/record

Record a screen into a local take, then make an MP4. `Capture` drives the open
[recorder protocol v1](../../docs/capability-kits.md#6-recorder-protocol-v1).
It now includes a real Linux X11 recorder. Passing an absolute `bin` selects an external recorder instead.

```sh
npm install @byokit/record
# Debian/Ubuntu, for the bundled recorder:
sudo apt-get install ffmpeg
```

## Runnable example (Linux X11, Node 22.18+)

Save as `record-demo.mjs` and run `node record-demo.mjs`. The explicit question is the Start action:
construction and `hello()` record nothing. X11 has no OS screen-sharing prompt, so your app must ask before starting.
Use `screen` with an external recorder when you need the OS consent dialog.

```js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Capture } from '@byokit/record';

const question = createInterface({ input: stdin, output: stdout });
const yes = await question.question('Umer, record this screen for five seconds? Type yes: ');
question.close();
if (yes !== 'yes') process.exit(0);

const dir = mkdtempSync(join(tmpdir(), 'rec-'));
const capture = new Capture({
  stateDir: join(dir, 'state'),
  display: { ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}) },
});
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
console.log(await capture.hello());
for await (const event of capture.record({
  source: `x11:${process.env.DISPLAY ?? ':0'}`,
  root: join(dir, 'takes'), maxSeconds: 5, signal: abort.signal,
})) {
  console.log(event);
  if (event.event === 'done') {
    const result = await capture.make({
      take: event.take, title: 'Umer records a demo',
      captions: [{ t: 0, text: 'Umer starts here', d: 1 }],
      set: { crf: 23, preset: 'fast' },
    });
    console.log('Local video:', result.out);
  }
}
// After saving/sharing the video yourself, remove all take and state files:
// rmSync(dir, { recursive: true, force: true });
```

`record()` starts only when its iterator is consumed. `maxSeconds` is a hard stop (1–3600).
`await capture.stop()`, aborting the signal, or leaving the iterator stops recording and waits for cleanup.
Completed takes stay local in the returned directory. Delete that directory to discard the recording.
The bundled recorder opens no input devices, records no typed events, captures no audio, calls no model,
and makes no network calls. The video itself contains everything visible on the chosen X11 display.

## Platforms and dependencies

| Host/source | Bundled recorder |
|---|---|
| Linux Node/Electron, `x11::0` (or another X display) | Screen video; `/usr/bin/ffmpeg` and `/usr/bin/ffprobe` with x11grab and libx264 required |
| Linux Wayland, `screen` | Unsupported; pass a consent-aware external protocol-v1 recorder |
| macOS / Windows | Unsupported by the bundled recorder |
| Android source from Node | Unsupported by the bundled recorder; external protocol-v1 recorder required |
| Browser/PWA / React Native (Android/iOS) | No entry: this package requires Node; call a host service or use a native recorder separately |

Only `events: 'none'` is supported by the bundled backend. `make()` reuses the recorded frames;
`title` becomes MP4 metadata, and `captions` become a selectable timed subtitle track (not burned-in text).
Render settings are `crf` (integer 0–51) and `preset` (FFmpeg's standard x264 presets).
Unknown settings and planners are rejected. `planOnly: true` writes no video and spends nothing.
The bundled entry uses the running Node executable, so Node need not be installed in `/usr/bin`.

State and takes are private (0700 directories/0600 files). Failed or pre-start-stopped recordings
leave no take; stop clears active state. A forced SIGKILL or power loss can leave an `active` lock:
after confirming that recorder has ended, delete only your app's `stateDir/capture/recorder/active`
to recover. Never remove it while a recording is running.

## External recorders and verification

The typed Node API uses the same options:

```ts
import { Capture, type CaptureOptions } from '@byokit/record';

const options: CaptureOptions = { stateDir: '/tmp/umer-recorder' };
const capture = new Capture(options);
console.log(await capture.hello()); // no recording or display access
```

`new Capture({ bin: '/absolute/path/to/recorder', stateDir })` retains full protocol pass-through:
source, events, max duration, title, captions, render settings and the optional planner key.
OS screen consent remains the external recorder's responsibility: the kit never answers or retries it.
Planner keys go only over fd 3, never environment, command line or a file.

`@byokit/record/testing` exports `fakeRecorder` and `captureContract` for external integrations.
The original protocol/client proof was an owner-machine conformance run (BK-C3);
the kit's fake contract tests remain offline. The bundled backend adds fake media-tool tests and a real
Linux smoke recording its own isolated Xvfb, stopping, rendering and probing H.264/subtitle output.

```sh
# From this repository, after npm ci and npm run build:
sh scripts/test.sh packages/record/test/real/smoke.test.ts
```

The smoke skips if Linux, Xvfb, FFmpeg or FFprobe is unavailable. CI installs these dependencies
and runs the smoke separately; ordinary `npm test` uses fakes. No test uses the owner's display.
The library reads no environment variables; the supervised recorder sees only the environment
Capture builds from nothing, including the XAUTHORITY path the app explicitly passes.
