// A loopback Telegram Bot API (5.18): the engine's Telegram channel long-polls it exactly as it would
// api.telegram.org, so a channel test needs no bot, no account and no network. Point `channels.telegram.apiRoot`
// at `url`. Only the token it was made with is accepted; every other token answers 401 as Telegram does.
import { createServer } from 'node:http';

export type FakeTelegramCall = { method: string; body: Record<string, unknown> };
export type FakeTelegram = {
  url: string;
  calls: FakeTelegramCall[]; // every Bot API call, token never recorded
  sent: { chat: string; text: string }[]; // every sendMessage
  /** Queues one private message from user `from` to the bot; the next getUpdates returns it. */
  message(from: string, text: string): void;
  close(): Promise<void>;
};

export function fakeTelegram(o: { token: string; username?: string }): Promise<FakeTelegram> {
  const calls: FakeTelegramCall[] = [], sent: FakeTelegram['sent'] = [];
  const updates: { update_id: number; message: object }[] = [];
  let waiters: (() => void)[] = [];
  let nextUpdate = 1, nextMessage = 1;
  const wake = () => { const w = waiters; waiters = []; for (const fn of w) fn(); };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      const answer = (status: number, body: object) => {
        if (res.writableEnded) return;
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      };
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(new URL(req.url ?? '/', 'http://x').pathname);
      if (!match || match[1] !== o.token) return answer(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      let body: Record<string, unknown> = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* a form body: no fields this fake reads */ }
      const method = match[2]!;
      calls.push({ method, body });
      const ok = (result: unknown) => answer(200, { ok: true, result });
      if (method === 'getMe') return ok({ id: 7000001, is_bot: true, first_name: 'Chief', username: o.username ?? 'byokit_test_bot',
        can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false });
      if (method === 'sendMessage') {
        const chat = String(body.chat_id), text = String(body.text ?? '');
        sent.push({ chat, text });
        return ok({ message_id: nextMessage++, date: Math.floor(Date.now() / 1000), chat: { id: Number(chat), type: 'private' }, text });
      }
      if (method === 'getUpdates') {
        const offset = Number(body.offset ?? 0);
        const pending = () => updates.filter(u => u.update_id >= offset);
        if (!pending().length && Number(body.timeout ?? 0) > 0) {
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, Math.min(Number(body.timeout), 30) * 1000);
            waiters.push(() => { clearTimeout(timer); resolve(); });
          });
        }
        return ok(pending());
      }
      // deleteWebhook, setMyCommands, sendChatAction, ...: accepted with nothing to report.
      return ok(true);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address !== 'string' ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`, calls, sent,
        message(from, text) {
          const id = Number(from), date = Math.floor(Date.now() / 1000);
          updates.push({ update_id: nextUpdate++, message: { message_id: nextMessage++, date, text,
            chat: { id, type: 'private', first_name: 'Umer' }, from: { id, is_bot: false, first_name: 'Umer' } } });
          wake();
        },
        close: () => new Promise<void>(done => { wake(); server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}
