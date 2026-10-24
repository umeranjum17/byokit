// The MiniMax user-code stand-in for the phone journey (expo-minimax.sh): the built @byokit/accounts/testing
// mockDevice({ dialect: 'minimax' }) on every interface, so the emulator reaches it at 10.0.2.2:<port>, and a
// loopback-only approve port standing in for the person typing the code on MiniMax's page. It prints the
// requests the phone sent as `METHOD path grant` lines (never bodies), and nothing secret.
//   node expo-minimax-host.mjs <device-port> <approve-port>
import { createServer } from 'node:http';
import { mockDevice } from '@byokit/accounts/testing';

const [port, approvePort] = process.argv.slice(2).map(Number);
const m = await mockDevice({ dialect: 'minimax', port, host: '0.0.0.0' });
const approve = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/requests') {
    res.end(m.state.requests.map((r) => `${r.method} ${r.path} ${new URLSearchParams(r.body).get('grant_type') ?? ''}`.trim()).join('\n') + '\n');
    return;
  }
  const ok = url.pathname === '/approve' && m.approve(url.searchParams.get('code') ?? '');
  res.writeHead(ok ? 200 : 404).end(ok ? 'approved\n' : 'no such code\n');
});
approve.listen(approvePort, '127.0.0.1', () => console.log(`stand-in MiniMax on ${m.base}; approve on 127.0.0.1:${approvePort}`));
const stop = async () => { approve.close(); await m.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
