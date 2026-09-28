// Every documented export exists on its entry (5.3, 7.1, 7.2), the frozen constants carry the pins (D4, D6), and
// the stubs refuse to run. Type names are exercised at compile time; value names at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as kit from '../src/index.ts';
import * as device from '../src/device.ts';
import * as link from '../src/link.ts';
import * as testing from '../src/testing/index.ts';
import { ENGINE_VERSION, OPERATOR_SCOPES, PROTOCOL_VERSION } from '../src/constants.ts';
import type {
  Approval,
  CallOptions,
  Decision,
  GatewayEventName,
  GatewayMethod,
  GatewayTransport,
  GateResult,
  Hello,
  KitState,
  Member,
  Route,
  RunEnd,
  RunEvent,
  RunSpec,
  SignInView,
  ToolHost,
  ToolSpec,
} from '../src/index.ts';
import type { RetainedLogin } from '../src/kit.ts';

test('the `.` entry exports the kit, the pins and the operator scopes (5.3, D4, D6)', () => {
  assert.equal(typeof kit.OpenClawKit, 'function');
  assert.equal(ENGINE_VERSION, '2026.8.1');
  assert.equal(PROTOCOL_VERSION, 4);
  assert.deepEqual([...OPERATOR_SCOPES], [
    'operator.read', 'operator.write', 'operator.admin', 'operator.approvals', 'operator.questions', 'operator.pairing', 'operator.talk',
  ]);
});

test('the documented type names compile from the `.` entry (5.2, 5.3)', () => {
  const options: kit.KitOptions = { stateDir: '.', tools: [], host: undefined, onState: () => {}, log: () => {} };
  const retained: RetainedLogin = { path: '/x' };
  const state: KitState = { phase: 'stopped', why: 'install', retryAt: 0 };
  const hello: Hello = { protocol: 4, server: { version: ENGINE_VERSION }, methods: [], events: [] };
  const member: Member = 'me';
  const tool: ToolSpec = { name: 'note', description: '', parameters: {} };
  const host: ToolHost = { gate: async () => ({ allow: true }) as GateResult, call: async () => '' };
  const spec: RunSpec = { sessionKey: 'agent:me:main', member, message: 'hi' };
  const event: RunEvent = { type: 'text', text: 'hi' };
  const end: RunEnd = { ok: true, text: 'hi' };
  const view: SignInView = { state: 'waiting', via: 'code', code: 'C' };
  const approval: Approval = { id: 'a', source: 'gate', member, summary: 's', at: 0, expires: 0 };
  const decision: Decision = { allow: true };
  const route: Route = { choice: 'c', provider: 'p', billing: 'subscription', via: 'code', prerequisite: null, offer: true, reason: 'r', source: 's' };
  const transport: GatewayTransport = { start: async () => hello, request: async () => null, onEvent: () => () => {}, onClose: () => () => {}, stop: async () => {} };
  const call: CallOptions = { timeoutMs: 1 };
  // The generated pass-through names exist (O2 filled the tables, per 4.6).
  const anyMethod = 'health' as GatewayMethod;
  const anyEvent = 'agent' as GatewayEventName;
  assert.ok([options, retained, state, hello, member, tool, host, spec, event, end, view, approval, decision, route, transport, call, anyMethod, anyEvent]);
});

test('the `./device` entry exports the device client and the portable notice opener (7.2, 7.3)', () => {
  assert.equal(typeof device.openclawDevice, 'function');
  assert.equal(typeof device.openNotice, 'function');
});

test('the `./link` entry exports the host adapter and serve (7.1)', () => {
  assert.equal(typeof link.openclawLink, 'function');
  assert.equal(typeof link.serve, 'function');
});

test('the `./testing` entry exports the fake, the contract suite and the model stub (5.11)', () => {
  assert.equal(typeof testing.fakeGateway, 'function');
  assert.equal(typeof testing.openclawContract, 'function');
  assert.equal(typeof testing.startModelStub, 'function');
  assert.equal(typeof testing.useModelStub, 'function');
});

test('every stub refuses to run instead of pretending', () => {
  assert.throws(() => new kit.OpenClawKit({ stateDir: '.' }), /not built: O4/);
  assert.throws(() => device.openclawDevice({} as never), /not built: O9/);
  assert.throws(() => link.openclawLink(null as never, { memberOf: () => undefined }), /not built: O9/);
  assert.throws(() => testing.fakeGateway(), /not built: O7/);
});
