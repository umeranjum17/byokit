// Phone-key enrol (docs/cloud-kit.md 5.12): fake provider and loopback link; no network, key or real machine is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { DeviceLink, Host, b64url, keyPair, type DeviceGrant, type Grant, type LinkStatus } from '../../pair/src/index.ts';
import { machine } from '../src/machine.ts';
import { setup, type SetupStep } from '../src/setup.ts';
import { OUTBOX_SHELL, OWNER_KEY_FILE, PHONE_KEY_FILE, RECEIPT_FILE, bindPhoneKey, deliverPhoneKey, pairEnrol, phoneReceipt, replacePhoneKey } from '../src/enrol.ts';
import { CLEAR_SHELL, DELIVER_SHELL, NEWEST_SHELL, WORKDIR_SHELL, takeInbox, writeOutbox } from '../src/host.ts';
import { checkRecipe } from '../src/recipe.ts';
import { MachineError } from '../src/errors.ts';
import type { ExecResult, HostRecipe, Machine, MachineRef, Provider } from '../src/types.ts';
import { fakeProvider, fakeSshTransport, memoryStore } from '../src/testing/index.ts';
import { sshResolve } from '../src/ssh-vm.ts';

const sha = (c: string): Record<'linux-x64' | 'linux-arm64', string> => ({ 'linux-x64': c.repeat(64), 'linux-arm64': c.repeat(64) });
const recipe = (name = 'web'): HostRecipe => ({
  name,
  node: { version: '24.15.0', sha256: sha('a') },
  install: [['npm', 'ci']],
  run: { argv: ['node', 'server.mjs'], env: { PORT: '7310' } },
  workDir: '/home/user/app',
});

const grantsBacking = () => {
  let saved: Grant[] = [];
  return { saved: () => saved, store: { load: () => saved, save: (g: Grant[]) => { saved = g; } } };
};

const openHost = async (backing: ReturnType<typeof grantsBacking>) => Host.open({
  keys: keyPair(), name: 'Cloud computer',
  grants: backing.store,
  confirm: () => false,
  handle: async () => ({ ok: true }),
});

test('the one phone key enrols once through delivery and the binding survives a restart', async () => {
  const provider = fakeProvider();
  const store = memoryStore();
  const m = machine({ provider, store });
  const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });
  await m.install(recipe('web'));

  const phone = keyPair();
  await deliverPhoneKey(m, recipe('web'), phone.publicKey);
  const inbox = `/home/user/app/.byokit/inbox/${PHONE_KEY_FILE}`;
  const landed = provider.fake.machine.files.get(inbox);
  assert.ok(landed !== undefined && landed.mode === 0o600 && landed.owner === 'user');
  assert.deepEqual(landed.bytes, phone.publicKey);
  const deliverRun = provider.fake.machine.runs.at(-1)!;
  assert.deepEqual(deliverRun.argv, ['sh', '-c', DELIVER_SHELL, 'sh', '/home/user/app/.byokit/inbox', PHONE_KEY_FILE]);
  assert.equal(deliverRun.inputBytes, 32);

  const backing = grantsBacking();
  const host = await openHost(backing);
  try {
    const first = await bindPhoneKey(host, landed.bytes.slice());
    assert.equal(first.bound, true);
    const grants = host.devices();
    assert.equal(grants.length, 1);
    assert.deepEqual([grants[0].key, grants[0].role, grants[0].kind], [b64url(phone.publicKey), 'control', 'phone']);

    const again = await bindPhoneKey(host, phone.publicKey.slice());
    assert.deepEqual(again, { id: first.id, bound: false });
    assert.equal(host.devices().length, 1);

    const other = keyPair();
    await assert.rejects(bindPhoneKey(host, other.publicKey), (e: unknown) => e instanceof MachineError && e.code === 'owner-enrolled');
    assert.deepEqual(host.devices().map((g) => g.id), [first.id]);

    await assert.rejects(bindPhoneKey(host, new Uint8Array([1, 2, 3])), (e: unknown) => e instanceof MachineError && e.code === 'bad-recipe');
    await assert.rejects(deliverPhoneKey(m, recipe('web'), new Uint8Array(31)), (e: unknown) => e instanceof MachineError && e.code === 'bad-recipe');
  } finally { host.close(); }

  // A restart reopens the same durable grants: the same key rebinds, any other is refused.
  const rebooted = await openHost(backing);
  try {
    assert.deepEqual(rebooted.devices().map((g) => g.key), [b64url(phone.publicKey)]);
    const same = await bindPhoneKey(rebooted, phone.publicKey.slice());
    assert.equal(same.bound, false);
    await assert.rejects(bindPhoneKey(rebooted, keyPair().publicKey), (e: unknown) => e instanceof MachineError && e.code === 'owner-enrolled');
  } finally { rebooted.close(); }
  assert.equal(m.ref, ref);
});

const waitStatus = async (seen: LinkStatus[], want: LinkStatus): Promise<void> => {
  for (let i = 0; i < 500 && !seen.includes(want); i++) await new Promise((r) => setTimeout(r, 20));
  if (!seen.includes(want)) throw new Error(`never saw link status ${want}: ${seen.join(',')}`);
};

test('only the enrolled phone pairs over the link; a wrong phone is refused', async (t) => {
  const backing = grantsBacking();
  const host = await openHost(backing);
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const sockets: WsSocket[] = [];
  wss.on('connection', (ws) => { sockets.push(ws); host.accept(ws); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/link`;
  t.after(() => { host.close(); for (const s of sockets) s.terminate(); wss.close(); server.close(); });

  const phone = keyPair();
  const { id } = await bindPhoneKey(host, phone.publicKey);
  const grantFor = (secret: Uint8Array, deviceId: string): DeviceGrant => ({ v: 1, secretKey: b64url(secret),
    host: b64url(host.keys.publicKey), hostName: 'Cloud computer', urls: [url],
    device: { id: deviceId, name: 'Phone', role: 'control' } });
  const link = (g: DeviceGrant, seen: LinkStatus[]) => new DeviceLink(g, { store: { save() {}, clear() {} }, onStatus: (s) => seen.push(s) });

  const rightSeen: LinkStatus[] = [];
  const right = link(grantFor(phone.secretKey, id), rightSeen);
  t.after(() => right.stop());
  await waitStatus(rightSeen, 'online');
  assert.equal(host.devices().find((g) => g.id === id)?.online, true);

  const wrongSeen: LinkStatus[] = [];
  const wrong = link(grantFor(keyPair().secretKey, 'nobody'), wrongSeen);
  t.after(() => wrong.stop());
  // The host answers not-paired, so the link drops the dead grant: 'removed', never 'online'.
  await waitStatus(wrongSeen, 'removed');
  assert.ok(!wrongSeen.includes('online'));
  assert.deepEqual(host.devices().map((g) => g.id), [id]);
});

test('setup secures the SSH route, the host answers with a receipt, and the phone links with only that receipt', async (t) => {
  const provider = fakeProvider();
  const listed: MachineRef = { provider: 'sandbox-api', account: 'acct-test', id: 'sb-1', name: 'computer', keepCopies: true };
  const store = memoryStore();
  // The machine's host process binds the delivered key with a real Host, listening on the machine's loopback.
  const backing = grantsBacking();
  const host = await openHost(backing);
  const withHost: Provider = { ...provider, list: async () => [listed], exec: async (ref, argv, o) => {
    const r = await provider.exec(ref, argv, o);
    if (argv[5] === PHONE_KEY_FILE) {
      const landed = provider.fake.machine.readFile(`/home/user/app/.byokit/inbox/${PHONE_KEY_FILE}`)!;
      await bindPhoneKey(host, landed);
      provider.fake.machine.writeFile(`/home/user/app/.byokit/outbox/${RECEIPT_FILE}`, new TextEncoder().encode(phoneReceipt(host, landed)), 0o600);
    }
    return r;
  } };
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const sockets: WsSocket[] = [];
  wss.on('connection', (ws) => { sockets.push(ws); host.accept(ws); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  // The app's SSH transport reaches the same machine; its forward carries the app port to the host above.
  const transport = fakeSshTransport({ machine: provider.fake.machine });
  transport.loopback.set(7300, (server.address() as AddressInfo).port);
  const pins = { load: async () => transport.fingerprint };
  const address = { port: 7300, transport, target: { host: 'computer.example', user: 'user' }, pins };
  t.after(() => { host.close(); for (const s of sockets) s.terminate(); wss.close(); server.close(); });

  // Nothing listens on the app port yet: securing fails before any pairing, and a retry may pass it.
  const phone = keyPair();
  const m = machine({ provider: withHost, store });
  const gate = pairEnrol(m, recipe('web'), phone.publicKey);
  const run = async () => {
    const steps: SetupStep[] = [];
    for await (const s of setup({ provider: withHost, store, recipe: recipe('web'), pick: (all) => all[0], confirmId: 'sb-1', address, pair: gate })) steps.push(s);
    return steps;
  };
  assert.deepEqual((await run()).at(-1), { step: 'failed', at: 'securing', cause: 'state.failed', retryable: true });
  assert.equal(host.devices().length, 0);

  provider.fake.machine.listening.add(7300);
  const steps = await run();
  assert.deepEqual(steps.map((s) => s.step), ['checking-access', 'listing', 'inspecting', 'installing', 'securing', 'pairing', 'ready']);
  const route = { host: 'computer.example', port: 22, user: 'user', fingerprint: transport.fingerprint, appPort: 7300 };
  assert.deepEqual(steps[4], { step: 'securing', route });
  const pairing = steps[5];
  assert.ok(pairing.step === 'pairing' && pairing.receipt !== undefined);
  const receipt = pairing.receipt;
  const [grant] = host.devices();
  assert.deepEqual(receipt, {
    host: b64url(host.keys.publicKey), device: { id: grant.id, name: 'Phone', role: 'control' }, urls: ['ws://127.0.0.1:7300'], ssh: route,
  });
  assert.equal(grant.key, b64url(phone.publicKey));

  // The phone holds only its own secret, its SSH transport and the receipt: the link dials the machine's loopback
  // through the receipt's SSH route.
  const resolve = sshResolve({ transport, pins, target: receipt.ssh!, port: receipt.ssh!.appPort });
  const seen: LinkStatus[] = [];
  const link = new DeviceLink({ v: 1, secretKey: b64url(phone.secretKey), hostName: 'Cloud computer', ...receipt }, {
    store: { save() {}, clear() {} }, onStatus: (s) => seen.push(s), resolve,
  });
  t.after(async () => { link.stop(); await resolve.close(); });
  await waitStatus(seen, 'online');
  assert.equal(host.devices().find((g) => g.id === grant.id)?.online, true);
});

test('on its own disk the host takes the delivered key from its inbox and answers through its outbox', async (t) => {
  // The machine's disk is a real directory, written and read by the kit's real delivery and outbox shells.
  const workDir = mkdtempSync(`${process.env.TMPDIR ?? '/tmp'}/byokit-host-`);
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const sh = (script: string, args: string[], input?: Uint8Array) => execFileSync('sh', ['-c', script, 'sh', ...args], { input }).toString();
  const host = await openHost(grantsBacking());
  t.after(() => host.close());
  const answered = (async () => {
    for (;;) {
      const got = await takeInbox(workDir, PHONE_KEY_FILE);
      if (got !== null) {
        await bindPhoneKey(host, got.bytes);
        await writeOutbox(workDir, RECEIPT_FILE, phoneReceipt(host, got.bytes));
        await got.done();
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  const m = { deliver: async (_r: HostRecipe, file: string, bytes: Uint8Array) => { sh(DELIVER_SHELL, [`${workDir}/.byokit/inbox`, file], bytes); } } as unknown as Machine;
  const phone = keyPair();
  // An app whose link route has a path builds it from each address root and the host's key.
  const gate = pairEnrol(m, { ...recipe(), workDir }, phone.publicKey, { url: (root, hostKey) => `${root}/link/${hostKey}` });
  const receipt = await gate({} as MachineRef, {
    urls: ['ws://127.0.0.1:7300'],
    read: async (file) => sh(OUTBOX_SHELL, [`${workDir}/.byokit/outbox/${file}`]) || null,
  });
  await answered;
  const hostKey = b64url(host.keys.publicKey);
  assert.deepEqual(receipt.urls, [`ws://127.0.0.1:7300/link/${hostKey}`]);
  assert.equal(receipt.host, hostKey);
  assert.equal(statSync(`${workDir}/.byokit/outbox/${RECEIPT_FILE}`).mode & 0o777, 0o600);
  assert.equal(statSync(`${workDir}/.byokit/outbox`).mode & 0o777, 0o700);
  assert.equal(await takeInbox(workDir, PHONE_KEY_FILE), null, 'the handled key is gone from the inbox');
  await assert.rejects(writeOutbox(workDir, '../escape', 'x'), (e: unknown) => e instanceof MachineError && e.code === 'bad-recipe');
});

test('on its own disk the newest offer is chosen by time, a handoff clears old offers, and a command runs in workDir with the node dir and recipe env first', async (t) => {
  const workDir = mkdtempSync(`${process.env.TMPDIR ?? '/tmp'}/byokit-newest-`);
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const sh = (script: string, args: string[]) => execFileSync('sh', ['-c', script, 'sh', ...args]).toString();
  const outbox = `${workDir}/.byokit/outbox`;
  assert.equal(sh(NEWEST_SHELL, [outbox, 'offer-']), '', 'no outbox yet');
  // The name order and the write order disagree, so only the time can pick offer-a; a directory and another prefix never win.
  for (const [file, at] of [['offer-b.json', 100], ['offer-a.json', 300], ['offer-c.json', 200], ['other.json', 400]] as const) {
    await writeOutbox(workDir, file, `text of ${file}\n`);
    utimesSync(`${outbox}/${file}`, at, at);
  }
  mkdirSync(`${outbox}/offer-dir`);
  utimesSync(`${outbox}/offer-dir`, 500, 500);
  assert.equal(sh(NEWEST_SHELL, [outbox, 'offer-']), 'offer-a.json\ntext of offer-a.json\n');
  assert.equal(sh(NEWEST_SHELL, [outbox, 'missing-']), '');
  // A handoff clears its own prefix's files first: directories and other names stay.
  assert.equal(sh(CLEAR_SHELL, [`${workDir}/none`, 'offer-']), '', 'no outbox yet');
  sh(CLEAR_SHELL, [outbox, 'offer-']);
  assert.deepEqual(readdirSync(outbox).sort(), ['offer-dir', 'other.json']);
  assert.equal(sh(NEWEST_SHELL, [outbox, 'offer-']), '');
  // The unit's view: cwd is workDir, the node dir leads PATH, and the recipe env reaches the command.
  const seen = sh(WORKDIR_SHELL, [workDir, '/nodebin', 'env', 'PORT=7310', 'sh', '-c', 'pwd -P; echo "$PATH"; echo "$PORT"']).split('\n');
  assert.equal(seen[0], workDir);
  assert.ok(seen[1].startsWith('/nodebin:'));
  assert.equal(seen[2], '7310');
});

test('the recipe guard still refuses key-like names', () => {
  // The guard refuses KEY-looking names even for public material: the seam uses delivery bytes instead.
  for (const name of ['PHONE_KEY', 'OWNER_TOKEN']) {
    assert.throws(() => checkRecipe({ ...recipe(), run: { argv: ['node', 'server.mjs'], env: { [name]: 'x' } } }, 'web'),
      (e: unknown) => e instanceof MachineError && e.code === 'bad-recipe');
  }
  assert.throws(() => checkRecipe({ ...recipe(), run: { argv: ['node', 'server.mjs', '--phone-key=x'], env: { PORT: '1' } } }, 'web'),
    (e: unknown) => e instanceof MachineError && e.code === 'bad-recipe');
});

test('a new phone sees the typed owner cause, and only a confirmed replaceOwner moves the computer to it, restart-safe', async () => {
  const provider = fakeProvider();
  const listed: MachineRef = { provider: 'sandbox-api', account: 'acct-test', id: 'sb-1', name: 'computer', keepCopies: true };
  const inbox = (file: string) => provider.fake.machine.files.get(`/home/user/app/.byokit/inbox/${file}`)?.bytes;
  // The machine's host process: a real Host over a durable grant store that handles each delivered
  // inbox file, phone.bin with bindPhoneKey and owner.bin with replacePhoneKey, then writes its receipt.
  const backing = grantsBacking();
  let host = await openHost(backing);
  const handled: string[] = [];
  const withHost: Provider = { ...provider, list: async () => [listed], exec: async (ref, argv, o) => {
    const r = await provider.exec(ref, argv, o);
    const file = argv[5];
    if (file === PHONE_KEY_FILE || file === OWNER_KEY_FILE) {
      const landed = inbox(file)!.slice();
      try {
        await (file === OWNER_KEY_FILE ? replacePhoneKey(host, landed) : bindPhoneKey(host, landed));
        provider.fake.machine.writeFile(`/home/user/app/.byokit/outbox/${RECEIPT_FILE}`, new TextEncoder().encode(phoneReceipt(host, landed)), 0o600);
        handled.push(`${file}:bound`);
      } catch (e) { handled.push(`${file}:${(e as MachineError).code}`); }
    }
    return r;
  } };
  const connect = async (key: Uint8Array, replaceOwner?: boolean): Promise<SetupStep[]> => {
    const store = memoryStore();
    const m = machine({ provider: withHost, store });
    const steps: SetupStep[] = [];
    for await (const s of setup({
      provider: withHost, store, recipe: recipe('web'), pick: (all) => all[0], confirmId: 'sb-1',
      pair: pairEnrol(m, recipe('web'), key), ...(replaceOwner === undefined ? {} : { replaceOwner }),
    })) steps.push(s);
    return steps;
  };
  const names = (steps: SetupStep[]) => steps.map((s) => s.step);
  const phones = () => host.devices().filter((g) => g.kind === 'phone').map((g) => g.key);

  // Phone A sets the computer up and gets its receipt.
  const a = keyPair();
  assert.deepEqual(names(await connect(a.publicKey)), ['checking-access', 'listing', 'inspecting', 'installing', 'pairing', 'ready']);
  assert.deepEqual(phones(), [b64url(a.publicKey)]);

  // The app is reinstalled on phone B (an empty store): a typed, plain cause, nothing changed on the machine.
  const b = keyPair();
  const before = [...provider.fake.machine.files.keys()].sort();
  for (const replaceOwner of [undefined, false]) {
    const refused = await connect(b.publicKey, replaceOwner);
    assert.deepEqual(refused.at(-1), { step: 'failed', at: 'inspecting', cause: 'error.ownerEnrolled', retryable: false });
    assert.deepEqual(names(refused), ['checking-access', 'listing', 'failed']);
  }
  assert.deepEqual([...provider.fake.machine.files.keys()].sort(), before);
  assert.deepEqual(handled, ['phone.bin:bound']);
  const runsBefore = provider.fake.machine.runs.length;

  // The person confirms: the same setup with replaceOwner reinstalls in place, delivers B as owner.bin,
  // and the host replaces A with B; the pairing receipt is B's.
  const moved = await connect(b.publicKey, true);
  assert.deepEqual(names(moved), ['checking-access', 'listing', 'inspecting', 'installing', 'pairing', 'ready']);
  assert.ok(provider.fake.machine.runs.length > runsBefore);
  assert.deepEqual(handled, ['phone.bin:bound', 'owner.bin:bound']);
  assert.deepEqual(phones(), [b64url(b.publicKey)]);
  const pairing = moved[4];
  assert.ok(pairing.step === 'pairing' && pairing.receipt?.device.id === host.devices()[0].id);
  assert.deepEqual(await replacePhoneKey(host, b.publicKey.slice()), { id: host.devices()[0].id, bound: false });
  await assert.rejects(bindPhoneKey(host, a.publicKey.slice()), (e: unknown) => e instanceof MachineError && e.code === 'owner-enrolled');
  host.close();
  assert.deepEqual(backing.saved().map((g) => g.key), [b64url(b.publicKey)]);

  // After a restart the durable grants still hold B only, and A's stale phone.bin is still refused.
  host = await openHost(backing);
  try {
    assert.deepEqual(phones(), [b64url(b.publicKey)]);
    assert.equal((await bindPhoneKey(host, b.publicKey.slice())).bound, false);
    await assert.rejects(bindPhoneKey(host, inbox(PHONE_KEY_FILE)!.slice()), (e: unknown) => e instanceof MachineError && e.code === 'owner-enrolled');
  } finally { host.close(); }
});
