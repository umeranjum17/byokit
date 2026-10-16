# Service kit: `@byokit/service`

Per-user autostart of an app's host companion on the person's **own** desktop: `systemd --user` on Linux and a
`launchd` `LaunchAgents` plist on macOS. Windows is unsupported.

Status: **binding spec, not implemented.** This is a docs-only recut; the package, its tests and its real-host
proof land in the work packages in section 8. [`@byokit/cloud`](cloud-kit.md) installs a host on a remote machine;
this kit starts one on the machine the person is sitting at, and it never touches another machine.

Contents: [1 Goal](#1-goal) · [2 Decisions](#2-decisions) · [3 Surface](#3-surface) · [4 Units](#4-units) ·
[5 Reuse from `@byokit/cloud`](#5-reuse-from-byokitcloud) · [6 Errors, state and words](#6-errors-state-and-words) ·
[7 Proof on real hosts](#7-proof-on-real-hosts) · [8 Tests and work packages](#8-tests-and-work-packages)

## 1. Goal

An app ships a host companion (a Node entry, an agent runner, a local server) and wants it running whenever the
person is logged in, without either of them opening the app. `@byokit/service` does exactly that, per user:

- `install({ name, bin, env })` writes one per-user unit that runs `bin`, starts it now and enables it at login.
- `status({ name })` reads whether that unit is running, stopped, missing or failed.
- `uninstall({ name })` stops and removes it.

Out of scope: system units and root; service discovery; Windows; supervising the host's own children (one unit
restarts one process, cloud-kit 8.1). The kit manages the OS's per-user service manager and nothing else.

## 2. Decisions

These close every design call. The builder follows them literally and stops with `blocked:` rather than redesigning.

| # | Decision |
|---|---|
| S1 | **Per user only, never system units.** The kit writes only under the login's home, runs only `systemctl --user`, `loginctl enable-linger` and `launchctl … gui/<uid>/…`, and never writes `/etc/systemd/system`, never calls `sudo`, and never runs `systemctl` without `--user`. |
| S2 | **Absolute `bin`.** `bin` must be an absolute path; a relative or empty one rejects `bad-bin` before any command runs. A `bin` that is not an executable file rejects `missing-bin` before any unit is written. |
| S3 | **Env from nothing** (kit-conventions §8). The unit's environment is exactly the caller's `env` plus the `PATH` head the unit renderer sets from `bin`'s directory. The kit reads no environment variable and never copies `process.env`. Home and login come from `os.userInfo()` — never `os.homedir()`, which falls back to `$HOME`. |
| S4 | **One dependency: `@byokit/cloud`**, for its systemd user-unit writer and linger rules (section 5). The kit imports no other kit and reads no other kit's private file. |
| S5 | **Linux is systemd `--user`; macOS is a per-user LaunchAgent.** Every other platform, Windows included, is unsupported: `install` and `uninstall` reject `unsupported`, `status` resolves `{ phase: 'unsupported' }`. |
| S6 | **Names.** `name` matches `^[a-z][a-z0-9-]{0,30}$`; a unit is `byokit-<name>.service` on Linux and `com.byokit.<name>` on macOS. A name that fails the expression rejects `bad-name` before any path is built. |
| S7 | **No word claims survival.** No sentence in `words.json` says the host will return after a reboot or logout; section 7 states that as unproven. |
| S8 | **Entries.** `.` (Node only; the kit spawns `systemctl`, `loginctl` and `launchctl`) and `./testing` (the fake exec). No browser or React Native entry: starting a companion on the person's device is the app host's job. |

## 3. Surface

```ts
export type ServiceOptions = {
  name: string;                                    // S6
  bin?: string;                                    // absolute; required by install, ignored by status/uninstall
  env?: Readonly<Record<string, string>>;          // the unit's whole environment besides PATH (S3)
  exec?: ServiceExec;                              // injectable command runner; defaults to a local spawn
  timeoutMs?: number;                              // per command; defaults to 10_000
}

export type ServiceState = {
  phase: 'running' | 'stopped' | 'not-installed' | 'failed' | 'unsupported';
  why?: 'load' | 'exit';                           // only for 'failed'
}

export function install(o: ServiceOptions): Promise<void>;      // idempotent: re-running rewrites and restarts
export function uninstall(o: ServiceOptions): Promise<void>;    // idempotent: a missing service resolves
export function status(o: ServiceOptions): Promise<ServiceState>;
```

- `install` writes the unit, starts it now and enables it at login. A second `install` with the same bytes is a
  reload, not a duplicate.
- `uninstall` stops and removes the unit and its file; a service that is not installed resolves (cloud's 404-counts-
  as-deleted rule, cloud-kit 6.1 `remove`).
- `status` never throws for a missing service; it resolves `not-installed`. `running` means the service manager
  reports the unit active; `stopped` means it is present but not active; `failed` means it is present and the
  manager reports failure, with `why` `exit` when the host's own last exit was nonzero and `load` when the unit
  could not be loaded.

## 4. Units

### 4.1 Linux (`systemd --user`)

The unit is `byokit-<name>.service` at `<home>/.config/systemd/user/byokit-<name>.service`, mode 0644, no `User=`
line and `WantedBy=default.target` — exactly what cloud's `renderUnit` produces for `kind: 'user'` (cloud-kit 8.4).
Its environment is the caller's `env` plus the renderer's `PATH` head; `ExecStart` is `bin`.

Install runs, in order: write the unit file; `loginctl enable-linger <login>`; `systemctl --user daemon-reload`;
`systemctl --user enable --now byokit-<name>.service`. Uninstall: `systemctl --user disable --now
byokit-<name>.service`, remove the file, `systemctl --user daemon-reload`. This is cloud-kit 8.3 step 9 unchanged;
nothing here is a second writer (section 5).

### 4.2 macOS (`launchd`)

The LaunchAgent is `com.byokit.<name>` at `<home>/Library/LaunchAgents/com.byokit.<name>.plist`, mode 0644, with
`ProgramArguments = [bin]`, `EnvironmentVariables = env`, `RunAtLoad = true` and `KeepAlive = true`. There is no
linger step: a LaunchAgent with `RunAtLoad` starts at login by design.

Install runs `launchctl bootstrap gui/<uid> <plist>` (`<uid>` from `process.getuid()`), falling back to
`launchctl load -w <plist>` only when the runner's launchd session refuses `bootstrap` (section 7 decides which).
Install then runs `launchctl kickstart gui/<uid>/com.byokit.<name>`, so the agent is running when `install` resolves
(`bootstrap` only schedules the `RunAtLoad` spawn).
Uninstall runs `launchctl bootout gui/<uid>/com.byokit.<name>`, removes the plist, and is idempotent. `status` runs
`launchctl print gui/<uid>/com.byokit.<name>`: a nonzero exit is `not-installed`; a successful print whose `state`
is `running` is `running`, otherwise `stopped`.

## 5. Reuse from `@byokit/cloud`

The Linux half is **not** a second writer. It reuses cloud's per-user unit writer, whose header comment already
promises this reuse (`packages/cloud/src/unit.ts:1-3`: "The per-user writer is exported for reuse: a later service
kit writes and enables per-user units the same way"):

- `renderUnit(r, o)` (`packages/cloud/src/unit.ts:25`, `o.kind: 'user'`) renders the systemd user unit bytes. The
  kit passes only the fields the renderer reads — `name`, `workDir` (= `dirname(bin)`, so `WorkingDirectory` is the
  host's own directory and no environment lookup is needed) and `run` (= `{ argv: [bin], env }`) — as a
  `HostRecipe`-shaped value.
- `writeUserUnit(o)` (`packages/cloud/src/unit.ts:100`) does mkdir, the 0644 atomic write, `loginctl enable-linger`,
  `systemctl --user daemon-reload` and `systemctl --user enable --now`.
- `userUnitDir(home)` and `userUnitPath(home, name)` (`packages/cloud/src/unit.ts:68`, `:71`) build the paths, so
  the service kit and cloud agree on one location.
- `UnitExec`, `writeUnitFile` and `quoteEnv` (`packages/cloud/src/unit.ts:73`, `:79`, `:16`) are the seam and the
  quoting the kit reuses rather than restating.

The **linger rules are cloud's**, cloud-kit §8.3 step 9 and §15.2 ("`loginctl enable-linger` starts a user manager
at boot and keeps it after logout; polkit may refuse it for a non-root user"): `enable-linger` first, a refusal
rejects `linger` with the line to run, and the kit never escalates. `writeUserUnit` throws
`MachineError('linger', …, { command: 'sudo loginctl enable-linger <login>' })`; the service kit catches it and
rethrows the kit's own `ServiceError('linger')` with that exact line in `detail.command` and the `MachineError` as
`cause`. Over a reboot it is the OS's job, not the kit's.

Today `unit.ts` is exported from its module but not from cloud's package entry. The build work package adds the
`@byokit/cloud/unit` subpath export (a cloud change, spec-first per kit-conventions Precedence); with it the service
kit imports these names directly. **There is no second writer.**

macOS **cannot** reuse cloud: cloud is Linux/systemd-only and rejects any other host with `not-linux` (cloud-kit 8.3
step 2), so it has no launchd writer to share. The service kit owns its launchd plist writer (section 4.2). That is
the one platform half cloud does not cover.

## 6. Errors, state and words

One error class (kit-conventions §3), `ServiceError`, with `code` from
`'unsupported' | 'bad-name' | 'bad-bin' | 'missing-bin' | 'linger' | 'provider'`, optional `detail` and `cause`. A
failing command rejects `provider` with the command and the last 200 characters of stderr; the `linger` case carries
`detail.command` as in section 5.

`src/words.json` keys: `service.running`, `service.stopped`, `service.notInstalled`, `service.failed`,
`service.setupFailed`, `service.unsupported` and `service.linger` (the last mirrors cloud's `host.linger`: the line to run, once). The kit
exports `WORDS`, `WordKey`, `words`, `stateWords` and `errorWords` (kit-conventions §9). `stateWords` returns `''`
only for a phase with nothing to say.

## 7. Proof on real hosts

Every implementation package for `@byokit/service` proves itself on **disposable GitHub-hosted runners, never the
owner's machine**: `ubuntu-latest` (systemd `--user`) and `macos-latest` (launchd). One CI job per OS runs the same
journey against a trivial companion binary:

1. `status` → `not-installed`.
2. `install` → `status` reports `running`.
3. `uninstall` → `status` reports `not-installed`.

The runner is thrown away after the job, so nothing is installed on a person's computer. The Linux job also proves
the per-user-only rule is real: the unit lands under `$HOME/.config/systemd/user`, `loginctl show-user <login>`
reports `Linger=yes` after install, and the kit never runs `sudo`; CI setup may. The macOS job's first run establishes which of
`launchctl bootstrap` or `launchctl load -w` the runner's launchd session accepts (4.2); that answer is recorded in
the kit's README as the launchd fact, not re-derived.

**Unproven, and stated as unproven:** reboot and logout survival. A hosted runner neither reboots nor logs out under
the job, so `install` earning autostart across a real reboot or logout is **not** proven by this run and no report
may claim it. Proving it needs a persistent machine the owner controls, which this task forbids; the proof is
deferred with that limitation on the record.

## 8. Tests and work packages

Tests are contract and integration tests only (the worker rules forbid unit or mock-heavy tests): `./testing` ships
a fake `ServiceExec` and a contract suite that drives `install`, `status` and `uninstall` against it on both
platform code paths; the section 7 CI jobs are the end-to-end proof. No test reboots a runner.

Work packages, each ≤ 300 lines:

- **A1 — surface and Linux.** The error class, state, words, `install`/`uninstall`/`status`, the systemd path built
  on `renderUnit`, `writeUserUnit`, `userUnitDir` and `userUnitPath` (section 5), plus the `@byokit/cloud/unit`
  subpath export cloud needs. Ship `./testing` with the fake exec and the contract suite.
- **A2 — macOS.** The launchd plist writer, `launchctl` calls, the same surface and contract suite on darwin.
- **A3 — real-host proof.** The `ubuntu-latest` and `macos-latest` CI jobs from section 7, with the reboot/logout
  limitation recorded in the README.

`private: true` at 0.1.0 until A3 is green; then the canonical release order in `scripts/release.ts` gains
`service`. A signature or decision change here is a spec change first, then code (kit-conventions Precedence).
