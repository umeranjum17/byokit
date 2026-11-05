// A loopback stand-in for an OpenAI-style model, so the real Pi runs end to end with no account or network.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Bot, BotEvent, BotSpec } from '../src/index.ts';

export type Seen = { system: string; said: string[]; tools: string[] };
type Message = { role: string; content: string | { text?: string }[] };
const words = (m: Message) => typeof m.content === 'string' ? m.content : m.content.map((part) => part.text ?? '').join('');
const chunk = (res: ServerResponse, delta: object, finish: string | null = null) => res.write(
  `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);

/** Answers `answer: <text>` with that text, `hold` with one word until `release()`, and `fail` with a refusal Pi does not retry. */
export async function fakeModel() {
  const seen: Seen[] = [];
  const held: (() => void)[] = [];
  let holding: () => void = () => {};
  let hold = new Promise<void>((resolve) => { holding = resolve; });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (part) => { body += part; });
    req.on('end', async () => {
      const request = JSON.parse(body) as { messages: Message[]; tools?: { function: { name: string } }[] };
      const said = request.messages.filter((m) => m.role === 'user').map(words);
      seen.push({ system: request.messages.filter((m) => m.role === 'system' || m.role === 'developer').map(words).join('\n'),
        said, tools: (request.tools ?? []).map((tool) => tool.function.name) });
      const last = said.at(-1) ?? '';
      if (last === 'fail') { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"the fake model refused"}}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      chunk(res, { role: 'assistant', content: '' });
      if (last === 'hold') { chunk(res, { content: 'holding' }); holding(); await new Promise<void>((resolve) => { held.push(resolve); res.on('close', resolve); }); }
      chunk(res, { content: last.startsWith('answer: ') ? last.slice(8) : `heard ${said.length}` });
      chunk(res, {}, 'stop');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    /** Resolves once a `hold` answer has started, then re-arms for the next one. */
    holding: async () => { await hold; hold = new Promise<void>((resolve) => { holding = resolve; }); },
    release: () => { for (const resolve of held.splice(0)) resolve(); },
    close: () => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

export type Scene = { stateDir: string; root: string; folder(id: string, context?: string): string; bot(id: string): BotSpec };

/** A crew under one parent folder whose own AGENTS.md no bot should ever see. Each bot's Pi home knows the fake model. */
export function scene(root: string, url: string): Scene {
  const stateDir = join(root, 'state');
  writeFileSync(join(root, 'AGENTS.md'), 'CANARY parent folder context');
  const folder = (id: string, context = `I am ${id}`) => {
    const path = join(root, 'bots', id);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'AGENTS.md'), context);
    mkdirSync(join(stateDir, 'pi', id), { recursive: true });
    writeFileSync(join(stateDir, 'pi', id, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: url, api: 'openai-completions', apiKey: 'none', models: [{ id: 'fake-1' }] } } }));
    return path;
  };
  // Pi's own environment is built from nothing, so the run's egress guard has to be handed over for it to cover Pi too.
  const env = process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : undefined;
  return { stateDir, root, folder, bot: (id) => ({ id, folder: folder(id), session: `${id}-task`, ...env ? { env } : {} }) };
}

/** The next event that fits, heard from now on. */
export const next = <T extends BotEvent>(bot: Bot, fits: (event: BotEvent) => event is T, ms = 15_000) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => { off(); reject(new Error(`No such event from ${bot.id} in ${ms} ms.`)); }, ms);
  const off = bot.on((event) => { if (fits(event)) { clearTimeout(timer); off(); resolve(event); } });
});
export const ended = (event: BotEvent): event is Extract<BotEvent, { type: 'end' }> => event.type === 'end';
export const stopped = (event: BotEvent): event is Extract<BotEvent, { type: 'stopped' }> => event.type === 'stopped';
