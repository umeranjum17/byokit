// The loopback fake upstream of the failover plan's appendix B: fails the first call, then answers; logs who called.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
const port = Number(process.env.PORT), failFirst = Number(process.env.FAIL_FIRST ?? 1), failStatus = Number(process.env.FAIL_STATUS ?? 503), logFile = process.env.HITLOG;
let n = 0;
http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404).end('{}'); return; }
    n++;
    const auth = String(req.headers.authorization ?? '');
    const id = createHash('sha256').update(auth).digest('hex').slice(0, 8);
    const status = n <= failFirst ? failStatus : 200;
    appendFileSync(logFile, JSON.stringify({ call: n, status, authId: id, disguised: /claude-cli/i.test(String(req.headers['user-agent'] ?? '')) }) + '\n');
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200
      ? JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'fake-model', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      : JSON.stringify({ error: { message: 'fixture failure', type: 'fixture' } }));
  });
}).listen(port, '127.0.0.1');
