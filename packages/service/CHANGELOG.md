# Changelog

## Unreleased

## 0.1.1 (2026-10-27)

- FEATURE: `@byokit/service` (docs/service-kit.md A1 Linux half): `install({ name, bin, env })` writes one `byokit-<name>.service` per-user systemd unit through `@byokit/cloud/unit` and starts it with `systemctl --user enable --now`; `status({ name })` reads `running`, `stopped`, `not-installed` or `failed`; `uninstall({ name })` disables it and removes the file. No environment variable is read; a refused `loginctl enable-linger` rejects `linger` with the line to run, never escalating. Every platform but Linux and macOS rejects `unsupported` (`status` resolves `{ phase: 'unsupported' }`). Words: `service.*`.
- FEATURE: `@byokit/service` on macOS (docs/service-kit.md A2): `install` writes one `~/Library/LaunchAgents/com.byokit.<name>.plist` (absolute `bin`, the caller's env plus a `PATH` headed by `bin`'s directory, `RunAtLoad`, `KeepAlive`) loads it with `launchctl bootstrap gui/<uid>` and starts it with `launchctl kickstart`; `status` reads `launchctl print` (`running`, `stopped` or `not-installed`); `uninstall` boots it out and removes the plist. Windows and every other platform still reject `unsupported`.
- FEATURE: `@byokit/service/testing` (docs/service-kit.md S8/A1): the fake `ServiceExec` (`FakeSystemd`, an in-memory `systemd --user`) and the one `serviceContract` suite that runs the same assertions against the fake and the real manager. The kit's file steps (`test -f`, `rm -f`) go through the `exec` seam, so the fake drives the whole journey with no real manager, no filesystem writes and no network.

- Dependency update: pins @byokit/cloud 0.6.1.

- Dependency update: pins @byokit/cloud 0.6.0.

- Dependency update: pins @byokit/cloud 0.5.0.

- Dependency update: pins @byokit/cloud 0.4.0.

- Dependency update: pins @byokit/cloud 0.3.0.

- Dependency update: pins @byokit/cloud 0.2.1.

- Dependency update: pins @byokit/cloud 0.2.0.
