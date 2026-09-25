# @byokit/ui-core

Headless "Sign in with …" state for any UI. `phaseOf()` turns what your back end reports (an `@byokit/accounts`
`view()` plus whether the account is signed in) into the phase to draw: opening, waiting (say yes on the provider's
page), code, done, work (a work plan: offer a personal one), cancelled, busy, expired, failed, offline. The React hook
`useSignIn({ read, start, cancel })` starts the sign-in as the sheet opens, polls, and handles cancel, close and
"Having trouble? Use a code instead". Your app keeps its own look. `@byokit/ui-core/phase` has no React dependency.

`describeRoute(url, kind?)` (also `@byokit/ui-core/route`, no React) names the route a dial address takes, for a pairing or
settings screen. Pass `tailscale`, `direct`, `private`, or `lan` when known (map reach's `tailscale-direct` to `direct`);
without provenance, 100.64/10 is labeled Private network rather than assumed to be Tailscale.

Pairing with `@byokit/link`, from `@byokit/ui-core/link` (no React either):

- `qrMatrix(offer.text)`: the pairing QR as rows of dark and light modules, with its quiet border, to draw in any UI.
- `consentWords({ hostName, role })`: the question before pairing ("Pair with Kitchen computer? This device
  will be able to see and change things on it, until you remove it there.").
- `pairingView({ phase, hostName, words, error })`: scan, compare the two words, waiting for a yes, paired, failed.
- `linkWords(status, hostName)`: the link's status in one sentence.
