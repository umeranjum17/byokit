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

`bin` is an absolute path to an executable file; the unit's environment is exactly `env` plus a
`PATH` headed by `bin`'s directory. `name` matches `^[a-z][a-z0-9-]{0,30}$`. Failures reject a
`ServiceError` with `code` `bad-name`, `bad-bin`, `missing-bin`, `linger` (with
`detail.command`), `provider` (the command and the end of its stderr) or `unsupported`.

The library reads no environment variable. Home and login come from `os.userInfo()`; every
spawned command gets an env built from nothing. It never writes a system unit, never runs `sudo`
and only runs `systemctl --user` and `loginctl enable-linger`.

Entry: `.` is Node only. Platforms: Linux (`systemd --user`). macOS (a per-user LaunchAgent)
lands next and rejects `unsupported` until then, as does every other platform; `status`
resolves `{ phase: 'unsupported' }` there.

**Status: in development** (private, not published). The CI job `service-linux` proves the
journey on a disposable GitHub-hosted Ubuntu runner: install a loopback echo, see it `active`
and answering, uninstall it and see the file gone. A hosted runner never reboots or signs out
under the job, so starting again after a restart or sign-out is **unproven**.
