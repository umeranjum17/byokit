# Changelog

## 0.3.0

- `respond(member, { instructions, input, onText })` asks ChatGPT with the member's own sign-in, the answer streaming in over an injected `fetch` (whole answer at once when the fetch can't stream); limits and lapsed sign-ins are acted on as `failed()` does.
- FIX: a plain HTTP 429 or an undated `rate_limit_exceeded` is a temporary rate limit, not "plan doesn't include this"; a streamed error keeps its code.
- FIX: a refresh that fails on the network before asking is reported as network trouble; a refused refresh signs the account out.
- FIX: `@byokit/accounts/testing` `decoy()` now requires a caller-owned root; migrate from `decoy()` to `decoy(root)` and clean up that root when done.
