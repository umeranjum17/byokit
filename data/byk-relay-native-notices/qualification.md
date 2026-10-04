# Linux native notice qualification — 2026-10-02

Continuation of the accepted foundation at https://github.com/umeranjum17/byokit/pull/290.
Foundation source history retained (original c603a143 and 2fef2908); rebased normally onto
main 8969ed90b20bfa7ecdfb30b0a5387bfa5844f297, producing 3900c6fb61e36c71ea087a09c0525b443571f548.
No notification contract, native implementation or TypeScript-owned vector changes were needed.

## Stock toolchain execution

No installed Swift executable was found; used the official Docker Library `swift:5.10.1-jammy`
Linux/amd64 manifest `swift@sha256:2d1c71154f1f9c8ca712997f49a7b42366978ae7d28fa9a76ea3672d62dbd251`.
The pull digest and runtime both verified: Swift 5.10.1 (`swift-5.10.1-RELEASE`), target
`x86_64-unknown-linux-gnu`. No local/patched upstream toolchain.
`Package.resolved` records stock swift-crypto 3.15.1 at
95ba0316a9b733e92bb6b071255ff46263bbe7dc and swift-asn1 1.4.0 at
f70225981241859eb4aa1a18a75531d26637c8cc.

Ran `swift test --jobs 2` in `packages/seal`, container limited to 2 CPUs and 4 GiB,
with only the task's seal directory mounted and an ephemeral HOME. Correctly held
`/home/umer/.treehouse/firstmate-8bf1b0/10/firstmate/state/heavy-jobs.lock` on fd 9
for the complete pull/build/test lifetime (`flock -w 1800 9` inside the fd-redirection subshell).
Queue bound 1800 seconds; execution bound 1200 seconds, TERM then KILL after 20 seconds;
owned container cleanup by exact name. Completed within the bounds, exit 0.

First compile/test attempt passed unchanged: `testNoticeVectors` (all exactly 35 TS-owned
vectors: 8 positives and 27 fail-closed negatives) and `testNoticeFromExpoUserInfo`
(valid Expo `body.data` and missing envelope). XCTest: 2 tests, 0 failures.
No original compile/test failure exists; the original successful log is retained, not replaced.

SHA-256 at execution (unchanged in this qualification):
- Swift source: 30bce75ad1d2c879c478ad30b3ddadf59dd45edc3b34425d468546dc238c0fe9
- Vectors: 194fee686d5761ca7201ba9de7b86859c80c6d05e9917f3e24405993123b53ad

## Enforcement / exact source gates

The minimal `seal-swift` job in existing CI uses this identical digest, `swift test --jobs 2`,
and a 10-minute job timeout. The existing Node matrix checks TS-generated vectors against the
committed file and cross-opens with libsodium; Swift consumes that file without rewriting it.
Build products are ignored; the dependency resolution is committed for reproducibility.

Under the same lifetime lock and queue/execution bounds, stock Node 24.21.0 ran
`npm ci --no-audit --no-fund && npm run build && npm run check && node scripts/readme-check.ts && npm test`.
All commands exited 0. Tests: 1911 discovered, 1886 passed, 25 skipped, 0 failed/cancelled.
Includes real relay/paired-host/injected Expo fetch counterfactual tests, omitted and false options,
category rejection, Android no-visible-alert and older subscription behavior, content-free preset,
and the TS/libsodium vector ownership gate. Test runner confirmed real `~/.pi` unchanged byte-for-byte.

Original stdout/stderr, exit files and registry image manifest are archived alongside the supervisor's
existing foundation proof (`proof/linux-swift-20261002/`); historical reproduction remains intact.
No account, model, device, Mac, consumer, auth or publication work was performed.

## Release and proof boundaries

Linux execution now qualifies the shared crypto/JSON opener and Expo userInfo extraction only.
It does **not** compile CryptoKit/Security against an iOS SDK, exercise the keychain entitlement,
or prove NSE replacement, background delivery, or force-quit/force-stop behavior on a device.
The documented unpaired-surrogate limitation remains. Apple/iOS qualification remains with its owner.

Sole publisher remains byk-launch-env, from merged exact-main source and fresh required CI.
Do not bump versions or publish in this lane. Relay 0.5.2 is independent of seal and is separately
releasable for the Android route after its source gates. Seal's requested new native API is 0.3.0;
actual Linux Swift tests now pass, but this is not iOS SDK/device acceptance. No dependency cascade:
herdr 0.7.0 -> infer 0.1.0 -> relay 0.5.2 (+ seal 0.3.0 only with its remaining owner gates) -> signaling 0.1.0.
