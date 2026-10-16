# @byokit/service

Per-user autostart of an app's host companion on the person's own computer: the kit writes one
per-user service that runs the app's host, starts it now and starts it again at login, without
the person opening the app ([spec](../../docs/service-kit.md)).

```ts
import { install, status, uninstall, stateWords, errorWords, ServiceError } from '@byokit/service';

export async function keepRunning(bin: string, show: (s: string) => void): Promise<void> {
  try {
    await install({ name: 'tracker', bin, env: { TRACKER_PORT: '4400' } });
  } catch (e) {
    if (!(e instanceof ServiceError)) throw e;
    // 'linger': show the words and e.detail.command, the one line the person runs; the kit never escalates.
    show(errorWords(e, { app: 'Tracker' }));
    return;
  }
  show(stateWords(await status({ name: 'tracker' }), { app: 'Tracker' })); // "Tracker is running on this computer."
}

export const stop = (): Promise<void> => uninstall({ name: 'tracker' });
```

- `install({ name, bin, env })` writes `~/.config/systemd/user/byokit-<name>.service` with
  `@byokit/cloud`'s per-user unit writer, runs `loginctl enable-linger`, then
  `systemctl --user daemon-reload` and `systemctl --user enable --now`. Re-running rewrites and restarts.
- `status({ name })` resolves `{ phase }`: `running`, `stopped`, `not-installed`, `failed` (with
  `why: 'exit' | 'load'`) or `unsupported`. It never throws for a missing service.
- `uninstall({ name })` runs `systemctl --user disable --now`, removes the file and reloads; a
  service that is not installed resolves.

On macOS the same calls drive one per-user LaunchAgent: `install` writes
`~/Library/LaunchAgents/com.byokit.<name>.plist` (`ProgramArguments` `[bin]`, `EnvironmentVariables`,
`RunAtLoad`, `KeepAlive`), loads it with `launchctl bootstrap gui/<uid>` (booting out a loaded
copy first so a re-install runs the new bytes) and starts it now with `launchctl kickstart`; `status` reads `launchctl print gui/<uid>/com.byokit.<name>`
(`state = running` is `running`, any other loaded state `stopped`, a failed print `not-installed`);
`uninstall` runs `launchctl bootout` and removes the plist. The launchd fact (spec 7): a hosted
runner's gui session accepts `launchctl bootstrap`, so the kit never falls back to `launchctl load -w`.

`bin` is an absolute path to an executable file; the unit's environment is exactly `env` plus a
`PATH` headed by `bin`'s directory. `name` matches `^[a-z][a-z0-9-]{0,30}$`. Failures reject a
`ServiceError` with `code` `bad-name`, `bad-bin`, `missing-bin`, `linger` (with
`detail.command`), `provider` (the command and the end of its stderr) or `unsupported`.

The library reads no environment variable. Home and login come from `os.userInfo()`; every
spawned command gets an env built from nothing. It never writes a system unit, never runs `sudo`
and only runs `systemctl --user`, `loginctl enable-linger` and `launchctl` in the login's `gui/<uid>` domain.

Entry: `.` is Node only. `./testing` (Node only) ships the test tooling: `FakeSystemd`, a fake
`ServiceExec` that answers the commands the kit runs from memory (no real manager, nothing on
disk), and `serviceContract(label, make)` — the one contract suite that runs the same assertions
against the fake and a real manager:

```ts
import { install, status } from '@byokit/service';
import { FakeSystemd } from '@byokit/service/testing';

const fake = new FakeSystemd();
const bin = process.execPath;
await install({ name: 'tracker', bin, exec: fake.exec }); // runs nowhere; fake.runs records the commands
console.log(await status({ name: 'tracker', exec: fake.exec })); // { phase: 'running' }
console.log(fake.unitBytes('tracker')); // the rendered unit, from memory
```

`FakeSystemd` answers the Linux half's commands only; on macOS the kit runs `launchctl`, which
it does not model, so a fake bench there rejects `provider` and writes nothing.

Platforms: Linux (`systemd --user`) and macOS (a per-user LaunchAgent). Every other platform,
Windows included, rejects `unsupported`; `status` resolves `{ phase: 'unsupported' }` there.

**Status: in development** (private, not published). The CI job `service-linux` proves the
journey on a disposable GitHub-hosted Ubuntu runner: install a loopback echo, see it `active`
and answering, uninstall it and see the file gone; it also proves a refused linger rejects
`linger`. The CI job `service-macos` proves the same journey on a disposable `macos-latest` runner:
`launchctl print` shows `state = running`, the echo answers, and after uninstall the plist is gone
and `launchctl print` fails. A hosted runner never reboots or signs out
under the job, so starting again after a restart or sign-out is **unproven**.
