// A bot's life: Pi starts when there is work and stops after there has been none. Knows nothing of Pi's own shapes.
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { openPi, type PiLink, type When } from './transport.ts';
import { PiError, type Bot, type BotEvent, type BotSpec, type KitOptions, type PiKit } from './types.ts';

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function refuseThePersonsPi(path: string): void {
  const inside = relative(join(homedir(), '.pi'), path);
  if (!inside.startsWith('..') && !isAbsolute(inside)) throw new PiError('person-pi', `${path} is inside the person's own Pi folder, which the kit never uses.`);
}

function checked(spec: BotSpec): BotSpec {
  if (!NAME.test(spec.id)) throw new PiError('bad-id', `A bot id uses letters, numbers, ".", "_" and "-", not ${JSON.stringify(spec.id)}.`);
  if (!NAME.test(spec.session)) throw new PiError('bad-session', `A session uses letters, numbers, ".", "_" and "-", not ${JSON.stringify(spec.session)}.`);
  if (!isAbsolute(spec.folder)) throw new PiError('bad-folder', `A bot's folder must be an absolute path, not ${JSON.stringify(spec.folder)}.`);
  refuseThePersonsPi(spec.folder);
  for (const path of spec.extensions ?? []) if (!isAbsolute(path)) throw new PiError('bad-extension', `An extension must be an absolute path, not ${JSON.stringify(path)}.`);
  return spec;
}

function startBot(spec: BotSpec, stateDir: string, idleMs: number, maxToolCalls: number): Bot {
  const listeners = new Set<(event: BotEvent) => void>();
  const emit = (event: BotEvent) => { for (const listener of listeners) listener(event); };
  let link: PiLink | undefined;
  let stopping: Promise<void> | undefined;
  let why: 'idle' | 'asked' | undefined;
  let timer: NodeJS.Timeout | undefined;
  let sending = 0;

  const shut = (reason: 'idle' | 'asked'): Promise<void> => {
    clearTimeout(timer);
    if (!link) return Promise.resolve();
    if (!stopping) { why = reason; stopping = link.close(); }
    return stopping;
  };
  // The timer only proposes: Pi itself says whether work is going, so a run never races its own idle stop.
  const rest = async () => {
    const open = link;
    if (!open || sending > 0) return;
    if (await open.quiet().catch(() => false) && sending === 0 && link === open) await shut('idle');
  };
  const arm = () => {
    clearTimeout(timer);
    if (link) { timer = setTimeout(() => { void rest(); }, idleMs); timer.unref(); }
  };
  const start = () => openPi(spec, stateDir, (event) => {
    emit(event);
    if (event.type === 'end') arm();
  }, maxToolCalls, (detail) => {
    clearTimeout(timer);
    const reason = why ?? 'crashed';
    link = undefined; stopping = undefined; why = undefined;
    emit({ type: 'stopped', reason, ...(reason === 'crashed' ? { detail } : {}) });
  });
  const say = async (text: string, when: When) => {
    sending += 1;
    clearTimeout(timer);
    try {
      await stopping;
      link ??= start();
      await link.say(text, when);
    } finally { sending -= 1; arm(); }
  };

  return {
    id: spec.id,
    get pid() { return link?.pid; },
    on(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    prompt: (text) => say(text, 'now'),
    steer: (text) => say(text, 'steer'),
    followUp: (text) => say(text, 'followUp'),
    async abort() { if (link) { await link.abort(); arm(); } },
    stop: () => shut('asked'),
  };
}

/** One Pi process per bot, each in its own Pi home, session folder and extension list. */
export function createPiKit(options: KitOptions): PiKit {
  const { stateDir, idleMs = 300_000, maxToolCalls = 30 } = options;
  if (!isAbsolute(stateDir)) throw new PiError('bad-state-dir', `stateDir must be an absolute path, not ${JSON.stringify(stateDir)}.`);
  if (!(idleMs > 0)) throw new PiError('bad-idle', `idleMs must be above zero, not ${idleMs}.`);
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1) throw new PiError('bad-limit', `maxToolCalls must be a whole number above zero, not ${maxToolCalls}.`);
  refuseThePersonsPi(stateDir);
  const bots = new Map<string, Bot>();
  return {
    bot(spec) {
      const open = checked(spec);
      if (bots.get(open.id)?.pid !== undefined) throw new PiError('bot-running', `Bot ${open.id} is running: stop it before replacing it.`);
      const bot = startBot(open, stateDir, idleMs, maxToolCalls);
      bots.set(open.id, bot);
      return bot;
    },
    async close() { await Promise.all([...bots.values()].map((bot) => bot.stop())); },
  };
}
