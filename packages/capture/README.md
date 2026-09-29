# @byokit/capture

Record a screen or a desktop into a take, then make a video from it. The kit owns an open **recorder protocol v1**
([docs/capability-kits.md](../../docs/capability-kits.md) §6) and drives any recorder that implements it; the app
passes that recorder by absolute path. The kit ships no recorder of its own.

`new Capture({ bin, stateDir, display? })` gives `hello()`, `record()` (an async iterator of recording events; an
abort signal stops the recording), `stop()` and `make()`. Consent to record a screen is always the system's own
prompt; the kit never answers or retries it. A planner key, when the app passes one, reaches the recorder only on a
file descriptor, never through the environment, the command line or a file.

**Status: in development.** This is the BK-0 scaffold (§9.3): types, signatures and words are frozen; behaviour lands
work package by work package.

Tests run only against the kit's fake recorder, in `npm test` and CI. A real recorder runs on the owner's machine or
in a lab, where the contract suite is run against it; there is no download helper, because recorders ship outside
byokit. The kit pins a protocol, not a recorder version, so the upstream pin watch has nothing to watch here.

The kit reads no environment variables and gives every recorder process an environment built from nothing.
