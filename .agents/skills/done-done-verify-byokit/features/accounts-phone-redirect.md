# ChatGPT one-button sign-in on a phone (in-app browser return)

A phone or browser app signs a member into ChatGPT with its own page instead of a device code: `login(member, 'chatgpt', { via: 'redirect' })` gives the page and the address to watch for (`returnTo`, ChatGPT's one registered `http://localhost:1455/auth/callback`); the app's in-app browser is sent there, and `complete(member, 'chatgpt', address)` finishes the sign-in. Rules: `fixtures/conformance/chatgpt-redirect-typescript.json`.

## Sub-features

- `redirect-start`: `login` with `via: 'redirect'` on `portable` returns `{ state: 'waiting', via: 'browser', url, returnTo, expiresAt }`; the URL carries the fixture's `authorize` parameters plus `state` and `code_challenge`, never a verifier.
- `redirect-complete`: the address the stand-in's authorize page sends the browser to, handed to `complete`, ends `done`; `status` says `ChatGPT is connected.`
- `redirect-refusals`: another state → `SignInReturnError` `wrong_state` (the sign-in stays waiting); the same address again → `replayed`; past `signInMs` → `expired`; no such sign-in → `no_sign_in`.
- `redirect-live-page`: against the real provider, the started URL opens OpenAI's real sign-in page. Stop there: never type an email or sign in.

## How to get to it (user POV)

- The consumer constructs `new Accounts({ authBase, apiBase, store: () => memoryStore() }, portable)` with `mockOpenAI()`'s base, calls `login(1, 'chatgpt', { via: 'redirect' })`, plays the in-app browser with `fetch(url, { redirect: 'manual' })` (the stand-in is already signed in, so it answers with a `302` to `returnTo?code&state`), then `complete` (README "ChatGPT with one button on a phone").

## Driving it with node scratch consumers

Preconditions: baseline (features/README.md).

- **Write the consumer.** `"$scratch_dir/verify-phone-redirect.mjs"` importing `Accounts, memoryStore, portable, SignInReturnError` from `@byokit/accounts` and `mockOpenAI` from `@byokit/accounts/testing`: start, print `url` origin + path and `returnTo`; follow one `302`; `complete` with the state swapped (print the `SignInReturnError` code and message); `complete` with the real address (print the state and `status` words); `complete` again (print `replayed`); a second `Accounts` with `signInMs: 200` that completes after 300 ms (print `expired`); `await openai.close()`.
- **Run and capture.** `feature=accounts-phone-redirect; entry=@byokit/accounts; drive=(node "$scratch_dir/verify-phone-redirect.mjs")`, then SKILL.md Evidence's capture block. Exit code `0`.
- **Shows.** `returnTo: http://localhost:1455/auth/callback`, `wrong_state …`, `done ChatGPT is connected.`, `replayed …`, `expired …`.
- **Live page (no sign-in).** A second consumer starts the same login with no `authBase` (the real `auth.openai.com`), prints only the URL's origin, path and parameter names, and writes the full URL to a file in the evidence folder. Open that file's URL in a real browser (`chrome-devtools-axi` headed under `xvfb-run -a`, `CHROME_DEVTOOLS_AXI_CHROME_ARGS=--ozone-platform=x11`; headless Chrome stays on Cloudflare's check), wait for the title, screenshot, `cancel` and stop the browser. The page's title is OpenAI's sign-in (`Welcome back - OpenAI` / `Log in`), not `invalid_authorize_request`.

## Gotchas

- Curl and headless Chrome get Cloudflare's `403`/"Just a moment…" at `auth.openai.com`: that is the bot check, not the authorize request's answer.
- On a computer (`computer` platform) `via: 'redirect'` is refused by design: the kit's listener on port 1455 catches the same address.
- A system browser tab (`ASWebAuthenticationSession`, Chrome Custom Tabs) cannot be watched for an `http://localhost` address; only an in-app WebView can.
