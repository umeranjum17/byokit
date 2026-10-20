# OpenClaw one chat channel (Telegram)

`KitOptions.channels.telegram` turns on one Telegram bot for the app (off by default). The [channel contract](../../../../docs/runtime-kits.md#518-one-chat-channel-telegram) claims every message from a listed person before the engine dispatches it: it reaches the app's one `onMessage` handler and no engine agent, so the app routes it to Chief's thread and answers with `kit.reply(chat, text)`. Gotchas lists what it does not cover.

## Sub-features

- A message from a listed Telegram user id reaches `onMessage({ chat, from, text })`; the app runs it in Chief's thread and `kit.reply` sends the answer to the chat.
- A message naming a helper (`@helper ...`) still reaches the handler and Chief's thread: no helper session opens.
- An unlisted sender reaches nothing; the engine never answers the chat by itself.
- A bad option (wildcard or empty `allowFrom`, a bad token or member id) throws `invalid telegram channel options` with no token in it; `reply` after `stop` rejects `gateway not ready`.
- The bot token lives only in the gateway's process env: no file under `stateDir` holds it.

## How to get to it (user POV)

Crewhouse turns the channel on with the person's bot token and their Telegram user id, and its handler sends every message to Chief's thread. The person writes to the bot from Telegram and Chief's answer comes back in the same chat; naming a helper in the message still talks to Chief.

## Driving it with node scratch consumers

Build and doctor per SKILL.md. The maintained consumer imports only the public built `@byokit/openclaw` and `@byokit/openclaw/testing` and runs the pinned engine against a loopback Bot API (`fakeTelegram`) and the model stub. No Telegram bot, account or network is used. On Linux:

```bash
feature=openclaw-telegram-channel
entry=capture/openclaw-telegram-channel.mjs
# Absolute, exclusive worktree path (Unix socket length); avoid RAM-backed /tmp.
scratch_dir=$(mktemp -d "$PWD/scratch.verify-byokit.XXXXXX") || exit 1
export CHANNEL_SCRATCH="$scratch_dir"
drive=(node .agents/skills/done-done-verify-byokit/capture/openclaw-telegram-channel.mjs)
```

Run the SKILL.md Evidence block under the host's heavy-job lock and memory gate. Set `BYOKIT_TEST_ENGINE_DIR` to an already installed pinned engine set to reuse it; otherwise the first run installs one into `$scratch_dir/engine`. Output has one JSON line per step with ms timestamps: each `onMessage`, Chief's answer, what the fake Bot API was sent, the engine's session keys per agent, and the leak count. Exit 0 and `TELEGRAM-CHANNEL OK` require every control. Keep the transcript, then remove only `$scratch_dir`.

Existing engine integration coverage: `BYOKIT_TEST_ENGINE_DIR=<installed set> sh scripts/test.sh packages/openclaw/test/engine/channel.test.ts`. It also sends `/acp spawn helper` and `/new` and proves they arrive as text with no model call and no engine session.

## Gotchas

- Run engine jobs with `PATH="/usr/bin:$PATH"` where `npm` is a mise shim: under a throwaway HOME the shim refuses and the install fails as `engine-patch: write`.
- `kit.reply` sends as the channel's `member` agent, and the engine mirrors the text into that agent's `agent:<member>:main` session: expect that key in `sessions.list`.
- An agent with the exec tool can read the token from the gateway env, as it can `OPENCLAW_GATEWAY_TOKEN`.
- A live Telegram run is not proven here: it needs a real bot token.
- No UI changed; no screenshots.
