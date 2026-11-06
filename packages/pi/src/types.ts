// The kit's public shapes. None of them is Pi's: transport.ts translates to and from these.

export type KitOptions = {
  /** Absolute folder the app owns. Each bot's Pi home is `<stateDir>/pi/<id>`. */
  stateDir: string;
  /** How long a bot with no work keeps its Pi running. Default: five minutes. */
  idleMs?: number;
  /**
   * Most tool calls a bot may make in one turn (one prompt, with whatever steering rode along), a whole number above zero.
   * A model that would make one more is stopped, so a model repeating itself cannot spend without bound. Default: 30.
   */
  maxToolCalls?: number;
};

/** A command and its arguments. */
export type Launch = { command: string; args: readonly string[] };

export type BotSpec = {
  /** Letters, numbers, `.`, `_` and `-`, starting and ending with a letter or number. */
  id: string;
  /** Absolute working folder. Its `AGENTS.md` and `skills/` are the bot's own; `sessions/` holds its sessions. */
  folder: string;
  /** The session this bot works in, same characters as `id`. An existing one is picked back up. */
  session: string;
  /** Absolute paths of the only extensions this bot loads. */
  extensions?: readonly string[];
  /** Extra variables for this bot. The environment is otherwise built from nothing but `PATH`. */
  env?: Readonly<Record<string, string>>;
  /**
   * Chooses what actually runs, at every start: it gets the command the kit would run and returns the one to run, such as
   * that command inside a sandbox. The kit talks to it over stdin and stdout, and the bot's `pid` and the kit's stop signals
   * reach it, not Pi, so it must pass those through. If it throws or returns anything else, nothing starts (`bad-launch`).
   */
  launch?: (pi: Launch) => Launch;
};

export type RunEnd = { ok: true; text: string } | { ok: false; aborted: true } | { ok: false; message: string };

export type BotEvent =
  | { type: 'started' | 'thinking' }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; phase: 'start' | 'end'; error?: boolean }
  | { type: 'usage'; tokens: number }
  /** The turn hit `maxToolCalls`: the model's next call was not run, and `end` follows as a failure naming the limit. `toolCalls` is how many ran. */
  | { type: 'limit'; toolCalls: number; limit: number }
  | { type: 'end'; end: RunEnd }
  /** The bot's process is gone: it was idle, the app asked, or it crashed (`detail` says why). The next message restarts it. */
  | { type: 'stopped'; reason: 'idle' | 'asked' | 'crashed'; detail?: string };

export type Bot = {
  readonly id: string;
  /** The running process, while there is one. */
  readonly pid: number | undefined;
  /** Hears every event until the returned function is called. */
  on(listener: (event: BotEvent) => void): () => void;
  /** Starts the bot if it is stopped and gives it work. Refused while a run is going: use steer or followUp. */
  prompt(text: string): Promise<void>;
  /** Redirects a running bot before its next model call; with no run going, this starts one. */
  steer(text: string): Promise<void>;
  /** Waits for the running work to finish first; with no run going, this starts one. */
  followUp(text: string): Promise<void>;
  /** Ends the run and drops queued messages. The bot stays up. */
  abort(): Promise<void>;
  stop(): Promise<void>;
};

export type PiKit = {
  /** One bot per id: a stopped bot may be replaced, for example to move it to another session. */
  bot(spec: BotSpec): Bot;
  /** Stops every bot. */
  close(): Promise<void>;
};

export type PiErrorCode = 'bad-state-dir' | 'bad-idle' | 'bad-limit' | 'bad-id' | 'bad-session' | 'bad-folder' | 'bad-extension' | 'bad-launch' | 'person-pi'
  | 'bot-running' | 'pi-missing' | 'pi-version' | 'pi-refused' | 'pi-exited';

export class PiError extends Error {
  readonly code: PiErrorCode;
  constructor(code: PiErrorCode, message: string) { super(message); this.name = 'PiError'; this.code = code; }
}
