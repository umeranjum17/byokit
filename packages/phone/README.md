# @byokit/phone

An agent that runs on the phone itself, with no computer: the person signs in to their own AI account on the phone,
chats with an agent there, and the agent uses only the app's own tools. The chat is kept on the phone, so an app the
phone killed reopens where it stopped.

It is a second kind of session beside the Herdr panes an app such as muxr shows for each computer. A pane's terminal
is its own truth; a phone session has no terminal, so it owns its chat instead.

Private at 0.1.0: the kit name is confirmed with the owner before a first publish
([docs/kit-conventions.md](../../docs/kit-conventions.md) §1.2). Portable: nothing from Node, so the same entry runs in
React Native (iOS, Android) and in a browser.

## What it promises, and what it does not

- **One account, honestly labelled.** A session answers from the one account the app names, signed in through
  [`@byokit/accounts`](../accounts) on this phone, and never from another: a limit ends the turn with its words, it
  never moves the turn to a second account, and accounts are never pooled. `account()` gives the catalogue's own
  billing sentence: "Uses your ChatGPT plan." for a subscription, "Charged per use to your OpenRouter account, not a
  plan." for a per-use key. Show it before the first send, so the person knows whether each answer is charged.
- **Nothing runs twice by itself.** Every step is written to the app's log before the next one starts. After a kill
  the turn reads `interrupted` and the session `blocked`; nothing reruns until the person taps Try again
  (`resume`). A tool the phone cut off mid-run is run again only when it says `replaySafe: true` (its effect is keyed
  by `callId`, so a second run finds the first); any other tool is reported to the model as stopped, "may or may
  not have acted", and is not run again. A `requestId` already sent returns that turn and sends nothing.
- **No background time.** The phone gives an app none, so "survives" means "continues correctly when reopened". A
  streamed answer the kill cut off is asked again on Try again.
- **Not here yet:** moving a phone chat to a computer or the cloud (a later slice: a handoff note, as `@byokit/herdr`
  starts any agent with a prompt), shell or file tools (a phone has neither; tools are the app's own), Claude plan
  turns (accounts' own Messages path), and Pi Durable (its `pi-ai` 1.x does not match the pin in `@byokit/accounts`).

## Use it

The app keeps the chat in a file of its own. `PhoneLog` is three calls: read every line, append one, delete them all.
Over Expo's `File` (`new File(Paths.document, 'phone-chat.jsonl')` from `expo-file-system`):

```ts
import type { PhoneLog } from '@byokit/phone';

// The members of expo-file-system's File this log uses.
type ChatFile = {
  exists: boolean; textSync(): string; delete(): void;
  create(o?: { intermediates?: boolean }): void; write(text: string, o?: { append?: boolean }): void;
};

export const fileLog = (file: ChatFile): PhoneLog => ({
  read: async () => file.exists ? file.textSync().split('\n').filter(Boolean) : [],
  append: async (line) => { if (!file.exists) file.create({ intermediates: true }); file.write(`${line}\n`, { append: true }); },
  clear: async () => { if (file.exists) file.delete(); },
});
```

Then open the session over the app's own `Accounts` (signed in on the phone as
[accounts' phone sign-in](../accounts/README.md#on-a-phone-or-in-a-browser) shows), with the app's own tools:

```ts
import type { Accounts, AuthHost } from '@byokit/accounts';
import { PhoneSession, type PhoneLog, type PhoneTool } from '@byokit/phone';

export async function phoneChat(accounts: Accounts<AuthHost, string>, log: PhoneLog, show: (answer: string) => void) {
  const note: PhoneTool = {
    name: 'save_note', description: 'Save a short note on this phone.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    replaySafe: true, // the note is keyed by callId, so a second run finds the first
    run: async (args, { callId }) => `Saved note ${callId}: ${String(args.text)}`,
  };
  const session = await PhoneSession.open({ accounts, member: 'Umer', account: 'chatgpt', log, tools: [note],
    instructions: 'You run on this phone only. Anything that needs a computer, say so in one line.' });

  const account = await session.account(); // { name: 'ChatGPT', billing: 'subscription', words: 'Uses your ChatGPT plan.', signedIn }
  show(account.words);

  // On reopen: a turn the phone cut off waits for the person's Try again.
  const cut = session.turns.find((t) => t.state === 'interrupted');
  if (cut) show(cut.words!); // "The app closed before this finished. Tap Try again to finish it."
  // ... and when they tap it: await session.resume(cut.requestId, { onText: show });

  const turn = await session.send('Remind me to call the plumber', { onText: show });
  show(turn.state === 'done' ? turn.answer : turn.words!);
}
```

For any account but ChatGPT, pass the model too (`model`, a pinned Pi `Model` whose provider matches the account,
as accounts' [key routes](../accounts/README.md#key-routes) need); a per-use key also needs
`withKeys(portable)` from `@byokit/accounts/keys`.

## Beside Herdr panes

`status` uses Herdr's own words (`AgentStatus`), so a Home row draws it like a pane: `working` while a turn runs,
`blocked` when the last turn was cut off and waits for Try again, `idle` otherwise. `turns` is the whole chat:
each turn's `text`, `answer`, `state` (`running`, `done`, `failed`, `interrupted`), its tools' states and, when it
did not finish, `code` and `words`.

## API

| Export | What it does |
|---|---|
| `PhoneSession.open(options)` | Read the kept chat (a line torn by a kill is skipped) and return the session |
| `send(text, { requestId?, signal?, onText? })` | Run one turn to its end; a known `requestId` returns that turn unsent. An abort rejects with the signal's reason and leaves the turn `interrupted` |
| `resume(requestId, { signal?, onText? })` | Finish an interrupted turn from its last kept step |
| `account()` | `{ id, name, billing, words, signedIn }` for the session's one account |
| `turns`, `status` | The chat as turns, and the session as a Home row |
| `clear()` | Forget the chat on this phone (sign-out, Clear chat) |
| `memoryLog()` | A `PhoneLog` in memory, for tests and demos |
| `PhoneError`, `PhoneErrorCode` | Why a turn did not finish: the account limits (`signed-out`, `resting`, `rate-limited`, `not-included`, `network`) plus `out-of-credit`, `cut-short`, `step-limit`, `busy` (one turn at a time) and `failed` |
| `WORDS`, `words`, `errorWords` | The sentences a person sees; UI shows these, never a code |

Options: `accounts`, `member`, `account` (`chatgpt` or an id from `accounts.list`), `model` (every account but
ChatGPT), `instructions`, `tools`, `log`, `maxSteps` (model calls per turn, default 8), `now`, `newId`.

## License

Apache-2.0.
