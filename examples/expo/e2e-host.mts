// A computer for the emulator to pair with: a @byokit/link host on this machine, saying yes to every pairing, printing
// its pairing code for the phone at 10.0.2.2 (the emulator's name for this computer). Used by e2e-android.sh.
import { createServer } from 'node:http';
import ws from 'ws'; // this app's own copy (React Native's), older: the server is ws.Server
import { Host, keyPair } from '../../packages/link/src/index.ts';

const port = Number(process.argv[2] ?? 21456);
const host = await Host.open({
  keys: keyPair(), name: 'Kitchen computer',
  confirm: (p) => { console.log(`words ${p.words}`); return true; },
  handle: (r) => { console.log(`request ${r.op}`); return { op: r.op, from: 'Kitchen computer' }; },
});
const server = createServer();
new ws.Server({ server }).on('connection', (ws) => host.accept(ws));
server.listen(port, '0.0.0.0', () => console.log(`offer ${host.offer({ role: 'control', urls: [`ws://10.0.2.2:${port}/link`] }).text}`));
