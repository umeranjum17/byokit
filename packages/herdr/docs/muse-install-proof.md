# Private official Muse installation proof

Local Linux x64 proof, 2026-10-02. This is a source-candidate receipt, **not a published BYOKit release or native Herdr-start/catalog qualification**.

The explicit `installMuse` helper downloaded and ran the unmodified official HTTPS installer in a task-owned staging HOME/XDG/temp with clean `/usr/bin:/bin` tools, no existing credentials, `MUSE_NO_MODIFY_PATH=1`, `MUSE_LOGIN=0`, and bounded downloads/processes. It returned an executable launcher plus selected native release in the task-owned destination. The returned PATH/environment subsequently ran only `muse --version` (exit 0):

```text
Muse Code 1.4.2 (1.4.2-R4684.1)
```

| Artifact | Source / selected release | SHA-256 |
|---|---|---|
| Installer | https://dev.meta.ai/install.sh | `5196d820127a241211c96cf38f0b2e30cff8506a82e9da9508cd5f826632a0ca` |
| Launcher | https://api.meta.ai/muse-launcher.sh | `c6db294799a190ca380da274beb3b9c0e160e0da9681a3d364ce8b0e5fa3a4bc` |
| Native | `muse-bin-1.4.2-R4684.1` | `dfb3096c91f4767c4d98006460800b7ba906a0b1a408280a926a8dc19a1af64f` |

The private home contained only the launcher/native executable and official `.muse-version` / `.muse-release-info.json` files. No profile or auth file appeared. The official installer/launcher were fetched separately as immutable evidence and their hashes matched the helper receipt. The native version command used the returned managed HOME/XDG/temp/PATH and disabled login/updates. No sign-in, account catalog, model request, personal CLI, device, or Herdr lifecycle operation was performed. This successful public download does not imply access for any other account/platform/time; protected/unavailable downloads return `protected_download` with their observed HTTP status in the message, without attempting login.

Task evidence (not shipped binaries): `.scout/muse-install/{official-result.json,official-hashes.txt,fetched-install.sh,fetched-launcher.sh,native-version.log,native-version.exit,private-files.txt}`. Offline fixtures cover missing/no-placement/no-RPC, environment isolation, launcher-only refusal, failure/cancellation/timeouts, preservation and receipt PATH reaching the prepared fake shell. The exact typed `agent.start` pass-through is unchanged. Windows is unsupported by this helper; the other supported architectures were not executed in this proof.

Official public model name: `muse-spark-1.3-contributor`. Installation/version is not evidence of the private account's own offered catalog or prompt readiness. Muse's tab-only metadata is unchanged; no folder override/resume/native-move support is added.

Previously inspected published `@byokit/herdr` 0.3.0 and 0.5.0 do not have this fix. Versions stay unchanged in this feature candidate; only the release owner can supply a verified published version after merge/release.
