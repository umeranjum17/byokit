# @byokit/ui-core

Headless "Sign in with …" state for any UI. `phaseOf()` turns what your back end reports (an `@byokit/accounts`
`view()` plus whether the account is signed in) into the phase to draw: opening, waiting (say yes on the provider's
page), code, done, work (a work plan: offer a personal one), cancelled, busy, expired, failed, offline. The React hook
`useSignIn({ read, start, cancel })` starts the sign-in as the sheet opens, polls, and handles cancel, close and
"Having trouble? Use a code instead". Your app keeps its own look. `@byokit/ui-core/phase` has no React dependency.

`describeRoute(url)` (also `@byokit/ui-core/route`, no React) names the route a dial address takes, for a pairing or
settings screen: Tailscale, Cloudflare tunnel, Local or private network, or Hosted VPS / custom relay.
