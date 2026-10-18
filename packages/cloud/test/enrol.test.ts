// Phone-key enrol (docs/cloud-kit.md 5.12): fake provider and loopback link; no network, key or real machine is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { DeviceLink, Host, b64url, keyPair, type DeviceGrant, type Grant, type LinkStatus } from '../../pair/src/index.ts';
import { machine } from '../src/machine.ts';
import { setup, type SetupStep } from '../src/setup.ts';
import { OWNER_KEY_FILE, PHONE_KEY_FILE, RECEIPT_FILE, bindPhoneKey, deliverPhoneKey, pairEnrol, phoneReceipt, replacePhoneKey } from '../src/enrol.ts';
import { DELIVER_SHELL } from '../src/unit.ts';
import { checkRecipe } from '../src/recipe.ts';
import { MachineError } from '../src/errors.ts';
import type { ExecResult, HostRecipe, MachineRef, Provider } from '../src/types.ts';
import { fakeProvider, memoryStore } from '../src/testing/index.ts';

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

test('setup secures the address, the host answers with a receipt, and the phone links with only that receipt', async (t) => {
  const provider = fakeProvider();
  const listed: MachineRef = { provider: 'sandbox-api', account: 'acct-test', id: 'sb-1', name: 'computer', keepCopies: true };
  const store = memoryStore();
  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false });
  // The machine's private network (already joined) and its host process, which binds the delivered key with a real Host.
  const backing = grantsBacking();
  const host = await openHost(backing);
  const served = new Map<string, string>();
  let serveStatus = (): string => JSON.stringify({ TCP: Object.fromEntries([...served].map(([p, to]) => [p, { TCPForward: to }])) });
  const net = (provider: ReturnType<typeof fakeProvider>): Provider => ({ ...provider, list: async () => [listed], exec: async (ref, argv, o) => {
    if (argv[0] === 'systemctl' && argv[1] === 'is-active') return ok('');
    if (argv[0] === 'tailscale' && argv[1] === 'status') return ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'computer.tail-test.ts.net.' } }));
    if (argv[0] === 'tailscale' && argv[1] === 'serve' && argv[2] === '--bg') { served.set(argv[3].slice('--tcp='.length), argv[4].slice('tcp://'.length)); return ok(''); }
    if (argv[0] === 'tailscale' && argv[1] === 'serve' && argv[2] === 'status') return ok(serveStatus());
    const r = await provider.exec(ref, argv, o);
    if (argv[5] === PHONE_KEY_FILE) {
      const landed = provider.fake.machine.readFile(`/home/user/app/.byokit/inbox/${PHONE_KEY_FILE}`)!;
      await bindPhoneKey(host, landed);
      provider.fake.machine.writeFile(`/home/user/app/.byokit/outbox/${RECEIPT_FILE}`, new TextEncoder().encode(phoneReceipt(host, landed)), 0o600);
    }
    return r;
  } });
  const withNet = net(provider);
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const sockets: WsSocket[] = [];
  wss.on('connection', (ws) => { sockets.push(ws); host.accept(ws); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const loopback = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => { host.close(); for (const s of sockets) s.terminate(); wss.close(); server.close(); });

  const phone = keyPair();
  const m = machine({ provider: withNet, store });
  const steps: SetupStep[] = [];
  for await (const s of setup({
    provider: withNet, store, recipe: recipe('web'), pick: (all) => all[0], confirmId: 'sb-1',
    address: { hostname: 'computer', port: 7300 }, pair: pairEnrol(m, recipe('web'), phone.publicKey),
  })) steps.push(s);
  assert.deepEqual(steps.map((s) => s.step), ['checking-access', 'listing', 'inspecting', 'installing', 'securing', 'pairing', 'ready']);
  assert.deepEqual(steps[4], { step: 'securing', name: 'computer.tail-test.ts.net' });
  assert.deepEqual([...served], [['7300', '127.0.0.1:7300']]);
  const pairing = steps[5];
  assert.ok(pairing.step === 'pairing' && pairing.receipt !== undefined);
  const receipt = pairing.receipt;
  const [grant] = host.devices();
  assert.deepEqual(receipt, { host: b64url(host.keys.publicKey), device: { id: grant.id, name: 'Phone', role: 'control' }, urls: ['ws://computer.tail-test.ts.net:7300'] });
  assert.equal(grant.key, b64url(phone.publicKey));

  // The phone holds only its own secret and the receipt; the resolver stands in for the tailnet name and serve.
  const seen: LinkStatus[] = [];
  const link = new DeviceLink({ v: 1, secretKey: b64url(phone.secretKey), hostName: 'Cloud computer', ...receipt }, {
    store: { save() {}, clear() {} }, onStatus: (s) => seen.push(s),
    resolve: (url) => url.replace('ws://computer.tail-test.ts.net:7300', loopback),
  });
  t.after(() => link.stop());
  await waitStatus(seen, 'online');
  assert.equal(host.devices().find((g) => g.id === grant.id)?.online, true);

  // A private route that does not read back fails at securing, before any pairing.
  serveStatus = () => '{}';
  const store2 = memoryStore();
  const fresh = net(fakeProvider());
  const again: string[] = [];
  for await (const s of setup({
    provider: fresh, store: store2, recipe: recipe('web'), pick: (all) => all[0], confirmId: 'sb-1',
    address: { hostname: 'computer', port: 7300 }, pair: pairEnrol(machine({ provider: fresh, store: store2 }), recipe('web'), phone.publicKey),
  })) again.push(s.step === 'failed' ? `failed:${s.at}:${s.cause}:${s.retryable}` : s.step);
  assert.deepEqual(again, ['checking-access', 'listing', 'inspecting', 'installing', 'failed:securing:state.failed:true']);
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
