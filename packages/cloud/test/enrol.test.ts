// Phone-key enrol (docs/cloud-kit.md 5.12): fake provider and loopback link; no network, key or real machine is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { DeviceLink, Host, b64url, keyPair, type DeviceGrant, type Grant, type LinkStatus } from '../../pair/src/index.ts';
import { machine } from '../src/machine.ts';
import { setup } from '../src/setup.ts';
import { OWNER_KEY_FILE, PHONE_KEY_FILE, bindPhoneKey, deliverPhoneKey, pairEnrol, replacePhoneKey } from '../src/enrol.ts';
import { DELIVER_SHELL } from '../src/unit.ts';
import { checkRecipe } from '../src/recipe.ts';
import { MachineError } from '../src/errors.ts';
import type { HostRecipe, MachineRef } from '../src/types.ts';
import type { SetupStep } from '../src/setup.ts';
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

test('setup emits pairing for the delivered phone key and the recipe guard still refuses key-like names', async () => {
  const provider = fakeProvider();
  const listed: MachineRef = { provider: 'sandbox-api', account: 'acct-test', id: 'sb-1', name: 'computer', keepCopies: true };
  const store = memoryStore();
  const withList = { ...provider, list: async () => [listed] };
  const phone = keyPair();
  const m = machine({ provider: withList, store });
  const steps: string[] = [];
  for await (const s of setup({
    provider: withList, store, recipe: recipe('web'),
    pick: (all) => all[0], confirmId: 'sb-1', pair: pairEnrol(m, recipe('web'), phone.publicKey),
  })) steps.push(s.step === 'failed' ? `failed:${s.at}` : s.step);
  assert.deepEqual(steps, ['checking-access', 'listing', 'inspecting', 'installing', 'pairing', 'ready']);
  const landed = provider.fake.machine.files.get(`/home/user/app/.byokit/inbox/${PHONE_KEY_FILE}`);
  assert.deepEqual(landed?.bytes, phone.publicKey);

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
  const withList = { ...provider, list: async () => [listed] };
  const inbox = (file: string) => provider.fake.machine.files.get(`/home/user/app/.byokit/inbox/${file}`)?.bytes;
  const connect = async (key: Uint8Array, replaceOwner?: boolean): Promise<SetupStep[]> => {
    const store = memoryStore();
    const m = machine({ provider: withList, store });
    const steps: SetupStep[] = [];
    for await (const s of setup({
      provider: withList, store, recipe: recipe('web'), pick: (all) => all[0], confirmId: 'sb-1',
      pair: pairEnrol(m, recipe('web'), key), ...(replaceOwner === undefined ? {} : { replaceOwner }),
    })) steps.push(s);
    return steps;
  };
  const names = (steps: SetupStep[]) => steps.map((s) => s.step);

  // Phone A sets the computer up; the host binds its delivered key.
  const backing = grantsBacking();
  const a = keyPair();
  assert.deepEqual(names(await connect(a.publicKey)), ['checking-access', 'listing', 'inspecting', 'installing', 'pairing', 'ready']);
  let host = await openHost(backing);
  try {
    assert.equal((await bindPhoneKey(host, inbox(PHONE_KEY_FILE)!.slice())).bound, true);
  } finally { host.close(); }

  // The app is reinstalled on phone B (an empty store): a typed, plain cause, nothing changed on the machine.
  const b = keyPair();
  const before = [...provider.fake.machine.files.keys()].sort();
  for (const replaceOwner of [undefined, false]) {
    const refused = await connect(b.publicKey, replaceOwner);
    assert.deepEqual(refused.at(-1), { step: 'failed', at: 'inspecting', cause: 'error.ownerEnrolled', retryable: false });
    assert.deepEqual(names(refused), ['checking-access', 'listing', 'failed']);
  }
  assert.deepEqual([...provider.fake.machine.files.keys()].sort(), before);
  assert.equal(inbox(OWNER_KEY_FILE), undefined);
  const unitsBefore = provider.fake.machine.runs.length;

  // The person confirms: the same setup with replaceOwner reinstalls in place and delivers B as the new owner.
  assert.deepEqual(names(await connect(b.publicKey, true)), ['checking-access', 'listing', 'inspecting', 'installing', 'pairing', 'ready']);
  assert.ok(provider.fake.machine.runs.length > unitsBefore);
  assert.deepEqual(inbox(OWNER_KEY_FILE), b.publicKey);
  assert.deepEqual(inbox(PHONE_KEY_FILE), a.publicKey);

  // The host handles each inbox file: the stale phone.bin is refused, owner.bin replaces A with B.
  host = await openHost(backing);
  try {
    await assert.rejects(bindPhoneKey(host, b.publicKey.slice()), (e: unknown) => e instanceof MachineError && e.code === 'owner-enrolled');
    const swapped = await replacePhoneKey(host, inbox(OWNER_KEY_FILE)!.slice());
    assert.equal(swapped.bound, true);
    assert.deepEqual(host.devices().map((g) => [g.key, g.kind]), [[b64url(b.publicKey), 'phone']]);
    assert.deepEqual(await replacePhoneKey(host, b.publicKey.slice()), { id: swapped.id, bound: false });
    await assert.rejects(bindPhoneKey(host, a.publicKey.slice()), (e: unknown) => e instanceof MachineError && e.code === 'owner-enrolled');
  } finally { host.close(); }
  assert.deepEqual(backing.saved().map((g) => g.key), [b64url(b.publicKey)]);

  // After a restart the durable grants still hold B only, and A's stale delivery is still refused.
  const rebooted = await openHost(backing);
  try {
    assert.deepEqual(rebooted.devices().map((g) => g.key), [b64url(b.publicKey)]);
    assert.equal((await bindPhoneKey(rebooted, b.publicKey.slice())).bound, false);
    await assert.rejects(bindPhoneKey(rebooted, inbox(PHONE_KEY_FILE)!.slice()), (e: unknown) => e instanceof MachineError && e.code === 'owner-enrolled');
  } finally { rebooted.close(); }
});
