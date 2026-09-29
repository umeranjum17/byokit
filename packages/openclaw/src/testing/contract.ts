// The contract suite (4.5, 5.11): the same assertions run against the fake in npm test and against the real pinned
// engine in the engine job. Every case drives only the kit's public surface, so a pass on the fake and a pass on the
// engine mean the same thing. O11 wires the calls; the cases are not run before then.
//
// `make` must return a started kit with the tool `note` registered and a host whose gate, for every tool (engine
// builtins included), asks for `{ mode: 'ask', ... }` input, denies `{ mode: 'deny', ... }` input and allows the rest,
// and whose calls answer `note: <input.text>`. An optional model is a started model stub the kit was pointed at with `useModelStub`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from '../constants.ts';
import { GATEWAY_CAPS } from '../transport.ts';
import type { OpenClawKit } from '../kit.ts';
import type { RunEvent, SignInView } from '../types.ts';
import { releaseStub, stubHolding, type ModelStub } from './model-stub.ts';

export type ContractFixture = { kit: OpenClawKit; model?: ModelStub; peer?: { request(method: string, params?: unknown): Promise<unknown> } };

// The generated method table arrives with O2; until then kit.call's typed surface accepts no method names, so the
// suite drives pass-through through this string-typed view of the same runtime path.
const call = (kit: OpenClawKit, method: string, params?: unknown): Promise<any> =>
  (kit as unknown as { call(m: string, p?: unknown): Promise<any> }).call(method, params);

const REQUIRED_METHODS = [
  'agent', 'agent.wait', 'agents.create', 'agents.list', 'chat.abort', 'config.get', 'config.patch',
  'exec.approval.request', 'exec.approval.resolve', 'health', 'models.authStatus', 'openclaw.setup.auth.start',
  'plugin.approval.resolve', 'question.resolve', 'wizard.cancel', 'wizard.next',
];
// Driven by the kit but not advertised in hello (O11 probe, e.g. sessions.steer): routable, just not listed.
// The engine job's generated.test.ts audits the full generated table against hello instead of asserting it here.
const REQUIRED_EVENTS = [
  'agent',
  'exec.approval.requested', 'exec.approval.resolved',
  'plugin.approval.requested', 'plugin.approval.resolved',
  'question.requested', 'question.resolved',
];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(there: () => boolean, ms = 5_000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (there()) return;
    await wait(50);
  }
  throw new Error('the expected state never arrived');
}

export function openclawContract(make: () => Promise<ContractFixture>, o?: { skipDeviceCode?: string }): void {
  test('contract: hello carries the protocol and every method and event the kit drives', async () => {
    const { kit } = await make();
    try {
      const hello = kit.hello;
      assert.ok(hello, 'the kit has no hello');
      assert.equal(hello.protocol, PROTOCOL_VERSION);
      // The connection must be an approval client or native approvals never arrive (B7).
      assert.ok((GATEWAY_CAPS as readonly string[]).includes('approvals'), 'operator caps lack approvals');
      for (const method of REQUIRED_METHODS) assert.ok(hello.methods.includes(method), `hello is missing ${method}`);
      for (const event of REQUIRED_EVENTS) assert.ok(hello.events.includes(event), `hello is missing ${event}`);
    } finally {
      await kit.stop();
    }
  });

  test('contract: members are created, cached and validated', async () => {
    const { kit } = await make();
    try {
      const first = await kit.ensureMember('m1');
      assert.equal(first.agentId, 'm1');
      const again = await kit.ensureMember('m1');
      assert.equal(again.agentId, 'm1');
      await assert.rejects(kit.ensureMember('M1'));
    } finally {
      await kit.stop();
    }
  });

  test('contract: a member cannot run in another member\'s session', async () => {
    const { kit } = await make();
    try {
      await kit.ensureMember('m1');
      await assert.rejects(kit.run({ member: 'm1', sessionKey: 'agent:m2:other:1', message: 'hello' }));
    } finally {
      await kit.stop();
    }
  });

  // The device-code happy path needs a person at the device URL (the fake auto-completes it, 5.11).
  // Unattended runs (the engine job) skip it with the reason and prove sign-in live instead (O11 lab).
  const deviceCodeName = `contract: device-code sign-in shows a code and finishes signed in${o?.skipDeviceCode ? ` (skipped: ${o.skipDeviceCode})` : ''}`;
  test(deviceCodeName, { ...(o?.skipDeviceCode ? { skip: true } : {}) }, async () => {
    const { kit } = await make();
    try {
      await kit.ensureMember('m1');
      const views: SignInView[] = [];
      const signIn = kit.signIn('m1', { authChoice: 'openai-device-code', via: 'code' }, (v) => views.push(v));
      const done = await signIn.done;
      assert.equal(done.state, 'done');
      assert.ok(views.some((v) => v.state === 'waiting' && v.code), 'no device code was shown');
      assert.equal(await kit.signedIn('m1', 'openai'), true);
    } finally {
      await kit.stop();
    }
  });

  test('contract: a person-cancelled sign-in fails cleanly', async () => {
    const { kit } = await make();
    try {
      await kit.ensureMember('m1');
      const signIn = kit.signIn('m1', { authChoice: 'openai-device-code', via: 'code' }, () => {});
      signIn.cancel();
      const done = await signIn.done;
      assert.equal(done.state, 'failed');
    } finally {
      await kit.stop();
    }
  });

  test('contract: a run streams text and ends ok', async () => {
    const { kit } = await make();
    try {
      await kit.ensureMember('m1');
      const events: RunEvent[] = [];
      const end = await kit.run({ member: 'm1', sessionKey: 'agent:m1:contract:1', message: 'hello contract' }, (e) => events.push(e));
      assert.ok(end.ok, JSON.stringify(end));
      if (end.ok) assert.ok(end.text.length > 0, 'the run ended without text');
      assert.ok(events.some((e) => e.type === 'text'), 'no text event arrived');
    } finally {
      await kit.stop();
    }
  });

  test('contract: a gated tool ask parks, approves and runs', async () => {
    const { kit } = await make();
    try {
      await kit.ensureMember('m1');
      const events: RunEvent[] = [];
      const pending = kit.run({ member: 'm1', sessionKey: 'agent:m1:contract:2', message: '[tool note {"mode":"ask","text":"hi"}]' }, (e) => events.push(e));
      // A real turn reaches the gate only after a model round trip; the fake answers at once.
      await until(() => kit.approvals('m1').length > 0, 120_000);
      const approval = kit.approvals('m1')[0];
      assert.equal(approval.source, 'gate');
      assert.equal(approval.tool, 'note');
      await kit.decide(approval.id, { allow: true });
      const end = await pending;
      assert.ok(end.ok, JSON.stringify(end));
      assert.ok(events.some((e) => e.type === 'tool' && e.name === 'note' && e.phase === 'start'));
      assert.ok(events.some((e) => e.type === 'tool' && e.name === 'note' && e.phase === 'end'));
    } finally {
      releaseStub();
      await kit.stop();
    }
  });

  test('contract: a denied tool is blocked without an approval', async () => {
    const { kit } = await make();
    try {
      await kit.ensureMember('m1');
      const end = await kit.run({ member: 'm1', sessionKey: 'agent:m1:contract:3', message: '[tool note {"mode":"deny","text":"x"}]' });
      assert.ok(end.ok, JSON.stringify(end));
      assert.equal(kit.approvals().length, 0);
    } finally {
      await kit.stop();
    }
  });

  test('contract: an engine builtin reaches the app gate and a denial blocks it', async () => {
    const { kit } = await make();
    try {
      await kit.ensureMember('m1');
      const pending = kit.run({ member: 'm1', sessionKey: 'agent:m1:contract:5',
        message: '[tool web_fetch {"mode":"ask","url":"https://example.invalid/"}]' });
      await until(() => kit.approvals('m1').length > 0);
      const approval = kit.approvals('m1')[0];
      assert.equal(approval.source, 'gate');
      assert.equal(approval.tool, 'web_fetch');
      await kit.decide(approval.id, { allow: false, reason: 'no fetching' });
      const end = await pending;
      assert.ok(end.ok, JSON.stringify(end));
      assert.equal(kit.approvals().length, 0);
    } finally {
      releaseStub();
      await kit.stop();
    }
  });

  test('contract: abort ends a run aborted', async () => {
    const { kit, model } = await make();
    try {
      await kit.ensureMember('m1');
      const key = 'agent:m1:contract:4';
      if (model) {
        // With the model stub the turn holds (`ask permission`), so the abort cannot race the run's end.
        const pending = kit.run({ member: 'm1', sessionKey: key, message: 'ask permission to continue' });
        await until(() => stubHolding(), 120_000);
        const aborted = kit.abort(key).finally(() => releaseStub());
        assert.deepEqual(await pending, { ok: false, aborted: true });
        await aborted;
      } else {
        const pending = kit.run({ member: 'm1', sessionKey: key, message: 'hello' }, (e) => {
          if (e.type === 'text') void kit.abort(key);
        });
        assert.deepEqual(await pending, { ok: false, aborted: true });
      }
    } finally {
      releaseStub();
      await kit.stop();
    }
  });

  test('contract: a native exec approval round-trips', async () => {
    const { kit, peer } = await make();
    try {
      // Raised by another party (a second connection): the engine broadcasts requested events to the
      // kit's approval-capable connection, never back to the requester (O11). On the fake both hear it.
      const raise = peer ? peer.request.bind(peer) : call.bind(null, kit);
      // The real engine holds the request open until the approval resolves, so it stays in flight.
      const pending = raise('exec.approval.request', { id: 'contract-exec-1', command: 'echo contract',
        ask: 'contract approval', agentId: 'm1', sessionKey: 'agent:m1:contract:9' });
      await until(() => kit.approvals().some((a) => a.id === 'contract-exec-1'), 120_000);
      assert.equal(kit.approvals()[0].source, 'exec');
      assert.equal(kit.approvals('m1')[0].id, 'contract-exec-1');
      await kit.decide('contract-exec-1', { allow: true });
      assert.equal((await pending as { id: string }).id, 'contract-exec-1');
      await until(() => kit.approvals().length === 0);
    } finally {
      await kit.stop();
    }
  });

  test('contract: call passes health through', async () => {
    const { kit } = await make();
    try {
      const health = await call(kit, 'health');
      assert.ok(health && typeof health === 'object', 'health did not answer');
    } finally {
      await kit.stop();
    }
  });

  test('contract: patchConfig keeps the memory invariants', async () => {
    const { kit } = await make();
    try {
      await kit.patchConfig({ memory: { search: { provider: 'openai', fallback: 'openai' } } });
      const config = await call(kit, 'config.get');
      assert.equal(config.config.memory.search.provider, 'none');
      assert.equal(config.config.memory.search.fallback, 'none');
      await kit.patchConfig({ agents: { entries: { m1: { memory: { search: { provider: 'openai' } } } } } });
      const after = await call(kit, 'config.get');
      assert.equal(after.config.agents.entries.m1.memory.search.provider, 'none');
    } finally {
      await kit.stop();
    }
  });
}
