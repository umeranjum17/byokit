# @byokit/phone

An agent that runs on the phone itself, with no computer: the person signs in to their own AI account on the phone
and chats with an agent that uses only the app's own tools. A second kind of session beside the Herdr panes an app
such as muxr shows: a pane's terminal is its own truth, so a phone session, with none, owns its chat. Portable
(nothing from Node: React Native and browsers).

## What it promises, and what it does not

- **One account, honestly labelled.** A session answers from the one account the app names, signed in through
  [`@byokit/accounts`](../accounts) on this phone. A limit ends the turn with its words; it never moves to a second
  account, and accounts are never pooled. Show `account().words` before the first send ("Uses your ChatGPT plan.",
  "Charged per use to your OpenRouter account, not a plan.").
- **Nothing runs twice by itself.** Every step is written to the app's log before the next. After a kill the turn
  reads `interrupted` and the session `blocked` until the person taps Try again (`resume`). A tool cut off mid-run
  runs again only when `replaySafe: true` (keyed by `callId`); any other is reported to the model as "may or may not
  have acted". A `requestId` already sent returns that turn and sends nothing.
- **No background time.** A phone gives an app none: "survives" means "continues correctly when reopened".
- **Not here yet:** moving a phone chat to a computer or the cloud, shell or file tools, Claude plan turns, and Pi
  Durable (its `pi-ai` 1.x does not match the pin in `@byokit/accounts`).

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
  const session = await PhoneSession.open({ accounts, member: 'Umer', account: 'chatgpt', model: 'gpt-6-sol', log, tools: [note],
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

Any account but ChatGPT needs a pinned Pi `model` ([key routes](../accounts/README.md#key-routes)); a per-use key
also `withKeys(portable)` from `@byokit/accounts/keys`.

## API

`PhoneSession.open({ accounts, member, account, model, instructions, tools?, log, maxSteps?, now?, newId? })` reads
the kept chat (a line torn by a kill is skipped). `account` is `chatgpt` or an id from `accounts.list`; `model` is a
ChatGPT model id (from `accounts.models()`), or the `Model` for any other account; `maxSteps`
caps model calls per turn (default 8). Then:

- `send(text, { requestId?, signal?, onText? })` runs one turn to its end; an abort rejects with the signal's reason
  and leaves the turn `interrupted`. `resume(requestId, opts)` finishes an interrupted turn from its last kept step.
- `account()` is `{ id, name, billing, words, signedIn }`; `clear()` forgets the chat on this phone.
- `turns` is the whole chat: each turn's `text`, `answer`, `state` (`running`, `done`, `failed`, `interrupted`), its
  tools' states and, when it did not finish, `code` and `words`. `status` uses Herdr's own words (`AgentStatus`), so
  a Home row draws it beside the panes: `working`, `blocked` (waits for Try again) or `idle`.
- `PhoneErrorCode`: the account limits plus `out-of-credit`, `cut-short`, `step-limit`, `busy` (one turn at a time)
  and `failed`. `WORDS`, `words`, `errorWords` are the sentences a person sees; UI shows these, never a code.
  `memoryLog()` is a `PhoneLog` in memory, for tests and demos.

## License

Apache-2.0.
