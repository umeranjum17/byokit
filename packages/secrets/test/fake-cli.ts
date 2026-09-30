// Fake keyring CLIs for both tools the kit drives: `security` (Keychain) and `secret-tool`
// (Secret Service). A Node script pinned to the running Node, configured only through its env:
// FAKE_TOOL, FAKE_LOG (JSON lines of { argv, env, stdinBytes }), FAKE_STATE (the emulated store),
// FAKE_CANARY_FILE (the secret that must never appear in argv or env; a hit exits 3 at once).
//
// The source below is raw text (String.raw): it must not contain a backtick or a ${ sequence.
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type FakeTool = 'security' | 'secret-tool';

const FAKE_SOURCE = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const log = process.env.FAKE_LOG;
const stateFile = process.env.FAKE_STATE;
const canary = readFileSync(process.env.FAKE_CANARY_FILE, 'utf8');
const argv = process.argv.slice(2);

const hit = argv.some((a) => a.includes(canary)) || Object.values(process.env).some((v) => (v || '').includes(canary));
const record = { argv, env: { ...process.env }, stdinBytes: 0 };
if (hit) {
  appendFileSync(log, JSON.stringify({ ...record, selfCheck: 'FAIL' }) + '\n');
  process.exit(3);
}

let stdin = Buffer.alloc(0);
process.stdin.on('data', (c) => { stdin = Buffer.concat([stdin, c]); });
process.stdin.on('end', () => {
  record.stdinBytes = stdin.length;
  appendFileSync(log, JSON.stringify(record) + '\n');
  const store = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  const keyOf = (service, account) => service + '\x01' + account;
  const fail = (message, code) => { process.stderr.write(message + '\n'); process.exit(code); };
  try {
    if (process.env.FAKE_TOOL === 'secret-tool') {
      const verb = argv[0];
      const rest = argv.slice(1);
      const attrs = {};
      for (let i = 0; i < rest.length; i++) {
        if (rest[i].slice(0, 2) === '--') continue;
        attrs[rest[i]] = rest[i + 1];
        i++;
      }
      const key = keyOf(attrs.service, attrs.account);
      if (verb === 'store') { store[key] = stdin.toString('base64'); }
      else if (verb === 'lookup') {
        if (!Object.hasOwn(store, key)) process.exit(1);
        process.stdout.write(Buffer.from(store[key], 'base64'));
        process.stdout.write('\n');
      } else if (verb === 'clear') { delete store[key]; }
      else fail('unknown verb', 2);
    } else {
      const verb = argv[0];
      const rest = argv.slice(1);
      let service;
      let account;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '-s') service = rest[++i];
        else if (rest[i] === '-a') account = rest[++i];
      }
      const key = keyOf(service, account);
      if (verb === 'add-generic-password') { store[key] = stdin.toString('base64'); }
      else if (verb === 'find-generic-password') {
        if (!Object.hasOwn(store, key)) fail('could not be found', 44);
        process.stdout.write(Buffer.from(store[key], 'base64'));
        process.stdout.write('\n');
      } else if (verb === 'delete-generic-password') {
        if (!Object.hasOwn(store, key)) fail('could not be found', 44);
        delete store[key];
      } else fail('unknown verb', 2);
    }
    writeFileSync(stateFile, JSON.stringify(store));
    process.exit(0);
  } catch (e) {
    fail('fake failed: ' + (e && e.message ? e.message : String(e)), 1);
  }
});
process.stdin.resume();
`;

export function writeFakeCli(dir: string, tool: FakeTool): string {
  const bin = join(dir, tool === 'security' ? 'security-fake' : 'secret-tool-fake');
  writeFileSync(bin, '#!' + process.execPath + '\n' + FAKE_SOURCE, { mode: 0o700 });
  chmodSync(bin, 0o700);
  return bin;
}
