# Pair: a real browser pairs from a link, even on a slow first start

A browser tab opens a pairing link, shows the same two words as the computer, pairs, asks for state over the link,
then pairs again with a typed short code and reports back, in headless Chromium against a real loopback host. The
test browser opens the pairing page over its private CDP pipe once Chromium answers there, so a slow first start
(whose network service quits unanswered after 15 s and is restarted) still loads the page, and a page Chromium cannot
open fails at once with Chromium's own navigation error instead of sitting out the 180 s deadline.

## Sub-features

- `journey`: link pairing with the two words, a state request, short-code pairing and the report, against a real host.
- `slow-first-start`: Chromium starved of CPU through startup; its network service logs "Terminating current process
  after 15 seconds with no connection." and Chromium restarts it, and the journey still passes.
- `navigation-failure`: a navigation Chromium cannot complete fails the test within seconds with "the browser could not
  open the pairing page: net::ERR_…", not "the browser never asked for the page" after 180 s.

## How to get to it (user POV)

On the computer, the app shows a pairing link; the person opens it in a browser tab, sees the same two words as the
computer and approves. The page then pairs a second time from the typed short code and reads the computer's state
over the link.

## Driving it with node scratch consumers

No scratch consumer: the maintained journey test (`npm test` in CI's `check` job) is the drive. After SKILL.md Launch,
Doctor and Drive's `$scratch_dir`, pick the Chromium under test by absolute path. CI runs the runner image's `chromium`
(`testBrowserBinary()` tries it first), a trunk snapshot that changes with the image: image 20261012.334 has
`Chromium 155.0.8059.0`, snapshot `Linux_x64/1697588` in the Chromium snapshot archive.

```bash
feature=pair-browser-journey; entry=packages/pair/test/browser.test.ts
chromium=/absolute/path/to/chrome   # the Chromium under test
wrappers=$(cd "$scratch_dir" && pwd) || exit 1
mkdir -p ".verify-artifacts/$feature" && diag=$(mktemp -d "$PWD/.verify-artifacts/$feature/diag.XXXXXX") || exit 1
drive=(env BYOKIT_CHROME="$chromium" BYOKIT_DIAGNOSTICS="$diag" sh scripts/test.sh "$entry")
```

Run SKILL.md Evidence's capture block: exit `0`, `✔ a browser pairs from a link and uses the link`, and the trace in
`$diag/link-browser.log` has `browser answered` before `page served`. Then the two hard cases, each with a fresh `diag`
and the same capture block (heavy jobs: hold the machine's heavy-job lock):

**Slow first start.** A wrapper starts Chromium and its children under 2% of one CPU until a timer lifts the quota
90 s later; the driver keeps the spawned PID because `systemd-run --scope` execs in place.

```bash
cat > "$wrappers/slow-chromium" <<EOF
#!/bin/sh
unit=byk-slowstart-\$\$
systemd-run --user --quiet --collect --on-active=90s --unit="\$unit-lift" systemctl --user set-property --runtime "\$unit.scope" CPUQuota=
exec systemd-run --user --scope --quiet --unit="\$unit" -p CPUQuota=2% -p MemoryMax=4G "$chromium" "\$@"
EOF
chmod +x "$wrappers/slow-chromium"
drive=(env BYOKIT_CHROME="$wrappers/slow-chromium" BYOKIT_DIAGNOSTICS="$diag" sh scripts/test.sh "$entry")
```

Exit `0` in about a minute and a half. In `$diag/link-browser.log` the network service's "Terminating current process
after 15 seconds with no connection." and the browser's "Network service crashed or was terminated, restarting
service." come before `URL to scan: http://127.0.0.1:…/pair`, and the trace has `page served`. No "Terminating" line
means this case was not exercised: the start was not slow enough (a quiet host gives the scope its whole quota; lower
`CPUQuota`, e.g. to 1%, and rerun), or the user manager has no `cpu` controller to apply it. A failure after 180 s with
"the browser never asked for the page" is the regression this case guards against.

**Navigation failure** (the error case). A wrapper sends loopback traffic to a proxy port nothing listens on:

```bash
cat > "$wrappers/navfail-chromium" <<EOF
#!/bin/sh
exec "$chromium" --proxy-server=127.0.0.1:9 '--proxy-bypass-list=<-loopback>' "\$@"
EOF
chmod +x "$wrappers/navfail-chromium"
drive=(env BYOKIT_CHROME="$wrappers/navfail-chromium" BYOKIT_DIAGNOSTICS="$diag" sh scripts/test.sh "$entry")
```

Exit `1` within seconds, and `drive.txt` names `the browser could not open the pairing page:
net::ERR_PROXY_CONNECTION_FAILED`. The capture block's final status check fails by design for this case.

## Gotchas

- `systemctl --user reset-failed 'byk-slowstart-*'` clears lift timers that fire after a fast run has exited.
- A host that keeps heavy jobs in their own systemd slice: add `--slice=<that slice>` to the scope's `systemd-run` so
  the starved browser stays inside it.
- Under the slow start other startup children (the storage service) can also quit unanswered; the journey still passes.
- The pairing link carries a secret fragment; the test scrubs it from the logs it keeps, so keep only those as evidence.
- The test closes the browsers it spawned over their pipe and removes their profiles; nothing to close by hand.
