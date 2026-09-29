# Changelog

## Unreleased

- Scaffold (docs/machine-kit.md M1): frozen public types (4.1 with 4.3 merged in), `MachineError`,
  words, `renderUnit`, recipe checks with the range compare and marker hash, node install argv, cost
  rules, `machine()` for 5.1–5.5 and 5.7, the fake provider and the contract suite, with
  `test/{exports,words,unit,recipe,node,cost,machine,contract,portable}.test.ts` and three unit
  golden files. Stubs throw `not built` until M3 (install and supervise),
  M7 (sleep and wake) and M8 (account link) land.
- Sandbox API adapter (docs/machine-kit.md M4): `sandboxApi()` for section 6 (create, sleep,
  wake, snapshot, fork, remove, exec, write and an HTTPS URL per port, plus usage, key,
  plan and why, with the trial retry and the `noEnv` rules), the loopback fake server bench
  in `./testing`, the sandbox bench in `test/contract.test.ts` and `test/sandbox-api.test.ts`.
- SSH VM adapter (docs/machine-kit.md M2): `sshVm()` and `sshHostKey()` over the
  app-passed `ssh` binary with a kit-owned config, a fixed spawn env and pinned host
  keys, the fake `ssh`/`ssh-keyscan` bench, the SSH contract bench (create by adoption
  after `confirm()`), and `test/{ssh,isolation}.test.ts` with behaviour assertions in
  `test/exports.test.ts`.
- Install and supervise (docs/machine-kit.md M3): `install`, `update`, `host`, `logs`
  and `deliver` in `src/machine.ts` (8.3 step order, Node selection, root steps with
  the marker and `needs-root`, `user` with `runuser`, system units for the sandbox
  API and user units plus linger for SSH VMs, `Restart=always` on both), the reusable
  per-user unit writer in `src/unit.ts`, the install-family contract cases with
  `installs` on in `test/contract.test.ts`, `test/install.test.ts`, and recipe
  sections in the README.
