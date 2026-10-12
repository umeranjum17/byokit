// Sample hosted relay: computers dial out to this, phones reach them through it. One process, one state file,
// enrolment-only signup. The owner token arrives as a file (never argv or env, so it never lands in `ps` or logs);
// the state file holds host keys, enrolment hashes and push addresses, so it stays 0600 on a mounted volume.
// Run with: `node server.mjs /srv/relay/config.json`
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer } from 'node:http';
import { Relay } from '@byokit/relay';

const config = JSON.parse(readFileSync(process.argv[2] ?? './config.json', 'utf8'));
const ownerToken = readFileSync(config.ownerTokenFile, 'utf8').trim();
if (!ownerToken) throw new Error('The owner token file is empty.');

let saved;
try { saved = JSON.parse(readFileSync(config.store, 'utf8')); } catch { saved = undefined; }
const relay = await Relay.open({
  store: {
    load: () => saved,
    save: (s) => {
      mkdirSync(dirname(config.store), { recursive: true });
      writeFileSync(config.store, JSON.stringify(s), { mode: 0o600 });
      chmodSync(config.store, 0o600);
      saved = s;
    },
  },
  ownerToken,
  trustProxy: config.trustProxy === true,
  push: { subject: config.pushSubject },
});

const server = createServer();
server.on('upgrade', (req, socket, head) => { if (!relay.upgrade(req, socket, head)) socket.destroy(); });
server.on('request', (req, res) => {
  if (new URL(req.url ?? '/', 'http://relay').pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, hosts: relay.hosts().length, devices: relay.count() }));
    return;
  }
  void relay.request(req, res).then((ours) => {
    if (!ours) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'not found' }));
    }
  });
});
server.listen(config.port, config.bind ?? '127.0.0.1');
server.on('listening', () => {
  const a = server.address();
  console.log(`hosted relay on ${typeof a === 'object' && a ? `${a.address}:${a.port}` : a}`);
});
