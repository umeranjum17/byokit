# @byokit/pi

One [Pi](https://github.com/earendil-works/pi) process per bot, on macOS and Linux with Node 22.19 or later. A bot's Pi starts when it has work and stops after it has been idle; the app sees bots and events, never Pi.

Install it with the one Pi version it is pinned to: `npm i @byokit/pi @earendil-works/pi-coding-agent@1.5.0`.

```ts
import { createPiKit, PiError } from '@byokit/pi';

const kit = createPiKit({ stateDir: '/app/state', idleMs: 60_000, maxToolCalls: 30 });
const chief = kit.bot({
  id: 'chief',
  folder: '/app/bots/chief',                     // its AGENTS.md and skills/; sessions/ is written here
  session: 'task-41',                            // an existing session is picked back up
  extensions: ['/app/extensions/my-tools.ts'],   // the only extensions this bot loads
});

chief.on((event) => {
  if (event.type === 'text') process.stdout.write(event.text);
  if (event.type === 'end') console.log(event.end);          // { ok: true, text } | { ok: false, aborted: true } | { ok: false, message }
  if (event.type === 'limit') console.log(event.toolCalls, event.limit);   // the turn hit maxToolCalls
  if (event.type === 'stopped') console.log(event.reason);   // idle | asked | crashed (with detail)
});

try {
  await chief.prompt('Plan my week');   // starts Pi if needed; resolves when accepted, the answer arrives as events
  await chief.steer('Mornings only');   // before its next model call
  await chief.followUp('Then email it to me');
  await chief.abort();                  // ends the run and drops what was queued
} catch (e) {
  if (e instanceof PiError) console.error(e.code, e.message);
}
await kit.close();
```

- **Each bot is its own.** One process, one Pi home (`<stateDir>/pi/<id>`, also its `HOME`), one session folder (`<folder>/sessions`) and one extension list. Pi's discovery is off, so a bot gets only its own `AGENTS.md`, `skills/` and listed extensions, and no `AGENTS.md` from a parent folder.
- **Nothing is inherited.** Pi's environment is built from nothing: `PATH`, the bot's `env`, its Pi home, and Pi's update check, telemetry and network refresh switched off. A person's `OPENAI_API_KEY` never reaches a bot.
- **The person's own Pi is never used.** `~/.pi` is not read, copied or changed, and a `stateDir` or `folder` inside it is refused (`person-pi`).
- **One seam.** `src/transport.ts` is the only file that knows Pi: its package, flags, variables and records. Everything public is in `src/types.ts`, so replacing Pi means replacing that one file, and `test/isolation.test.ts` fails if another file learns about Pi.
- **Stopping and starting.** The idle timer asks Pi whether work is going before it stops anything, so a long run is safe. After an idle stop or a crash the next message starts a new process on the same session. A run a stop or crash cuts off still gets its `end` event.
- **A cap on tool calls.** `maxToolCalls` (default 30, a whole number above zero, else `bad-limit`) bounds the tool calls of one turn, not of a session: a model that repeats a call cannot spend without bound. When the model asks for one past the cap, the bot hears `{ type: 'limit', toolCalls, limit }`, the run is aborted with its queue dropped, and `end` follows once as `{ ok: false, message: 'Stopped: this turn reached its limit of 30 tool calls (maxToolCalls), so the run was ended.' }`. The process stays up and the next prompt starts a fresh count. The call that trips the cap was already on its way, so it may still run: a turn makes at most `maxToolCalls + 1`. 30 is above the 15 to 20 model calls a typical bot turn is budgeted and well below the 66 a looping one spent.
- **Your own launcher.** `launch` on a bot's spec chooses what actually runs, for example Pi inside a sandbox: `launch: ({ command, args }) => ({ command: '/usr/bin/bwrap', args: [...wall, command, ...args] })`. It runs at every start, after a crash too, and without it Pi starts as above. The kit talks to that command over stdin and stdout, and the bot's `pid` and stop signals reach it rather than Pi, so it must pass them through (`exec` does). A `launch` that throws or returns anything else is refused (`bad-launch`), and a command that cannot start fails the message (`pi-exited`): Pi never falls back to running without it. The kit ships no sandbox.
- **Pinned exactly.** Pi's protocol moves between releases, so another version is refused (`pi-version`) and a missing one is named (`pi-missing`). The tests below gate every bump.
- **Refusals.** `PiError` codes: `bad-state-dir`, `bad-idle`, `bad-limit`, `bad-id`, `bad-session`, `bad-folder`, `bad-extension`, `bad-launch`, `person-pi`, `bot-running` (a running bot cannot be doubled), `pi-missing`, `pi-version`, `pi-refused` (Pi's own words, such as a prompt during a run), `pi-exited`.
- **Not covered yet.** No sign-in or provider: a bot's Pi finds its models in `<stateDir>/pi/<id>/models.json`, and with none it says so. Pi has no sandbox, and `bash` is off, but `read`, `edit` and `write` are not yet limited to the bot's folder, so keep untrusted work off this kit until its tool gate lands. Extension dialogs are cancelled, as nobody can answer them yet. Windows and Electron's `process.execPath` are untested.

## Tests

`npm test -w packages/pi` drives the real pinned Pi against a loopback stand-in model (`test/fake-model.ts`), with no account or network: two bots on two sessions, steering, aborting, idle stops, crashes, a `launch` wrapped around Pi and refused, and a stand-in person's `~/.pi` hashing the same before and after. `scripts/test.sh` also compares the real `~/.pi` before and after the run.
