# PWA agents (per-agent sign-ins)

The example PWA's home page opens on **Agents**: one row per agent the page sets up (Codex, Claude Code, Pi, OpenCode, Kimi Code, Mistral Vibe; `AGENTS` in `examples/pwa/app.ts`), each with `N of M enabled`, where M counts its plans and N the plans with a ready account. Opened, an agent shows **Sign-in method · one at a time**: each plan with its billing words and a **Sign in** button, or the accounts connected on it as radio rows (`In use` / `Signed in`). Below that are a note naming the account in use, a collapsed **Pay per use (n)** list (`OpenAI API key`, `Charged per use to your OpenAI account. No form on this page for it yet.`, never startable, never counted) and **Default model**, read live from the in-use account. The rows come from `@byokit/ui/accounts` `agentView`; the choice is the kit's `setDefaults(member, { account, model }, kind)`, kept per agent kind in the browser's account index.

## How to get to it (user POV)

Open the PWA. Tap **Codex**, then **Sign in** on ChatGPT. The page scrolls to the ChatGPT card's code; type it on OpenAI's page and Codex comes back with that account **In use**. Pick a model under **Default model** and reload: the model is still chosen. Open **Pi**: the same account is listed as `Signed in` but not chosen (`Pick the account Pi uses.`) until you tap its radio. Sign out on the ChatGPT card and Codex goes back to `0 of 1 enabled`, with no other account swapped in.

## Driving it

- **Journey test.** `sh scripts/test.sh examples/pwa/pwa.test.ts`: the `agents:` case asserts the counts (`0 of 1`, `0 of 6`, `No plan sign-in`), Mistral Vibe's per-use key listed with its billing words and no Sign in or model picker, Codex's disabled picker before an account, the sign-in from Codex's row landing as Codex's account (`Codex uses umer@example.com.`) while Pi chooses nothing, a model kept across a reload, Pi taking the account by its radio while Codex keeps its model, and sign-out leaving Codex unset.
- **Frames.** `node .agents/skills/done-done-verify-byokit/capture/review-evidence.ts --base origin/main --screens agents-list,agents-codex,agents-pi --out <private-evidence-dir>`: light/dark × phone (390 px)/desktop, plus motion. `agents-list` is the closed list with every count at zero; `agents-codex` is Codex signed in from its row, the account in use, `GPT-6 Sol` chosen and kept across a reload, Pay per use open; `agents-pi` is Pi with the account signed in but not chosen and the other plans to sign in. Before frames are the base home, which had no agents (provider cards only). ChatGPT's model list (`/codex/models`) is answered from `mockOpenAI()` through the page's own `fwd/chatgpt` route.

## Gotchas

- Which agents run on which plans is the page's own table, as `AgentCapabilities.routes` is the host's: the kit does not claim an agent supports a route.
- Sign in from an agent uses the provider's card further down; only a sign-in started from an agent's row, for an agent with nothing chosen yet, becomes that agent's account.
