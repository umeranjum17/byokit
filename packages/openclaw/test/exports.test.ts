// Every documented export exists on its entry (5.3, 7.1, 7.2) and the frozen constants carry the pins (D4, D6).
// Type names are exercised at compile time; value names at runtime.
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
  GatewayMethods,
  GatewayTransport,
  GateResult,
  Hello,
  JsonValue,
  KitState,
  Member,
  Route,
  RouteFacts,
  RouteView,
  RunEnd,
  RunEvent,
  RunSpec,
  SignInView,
  ToolHost,
  ToolSpec,
} from '../src/index.ts';
import { OpenClawKit, type RetainedLogin } from '../src/kit.ts';
import type { OpenClawDevice, DeviceEndFrame } from '../src/device.ts';
import type { OpenClawLinkHost, OpenClawLinkOptions, OpenClawServeHandle, OpenClawServeOptions } from '../src/link.ts';
import type { FakeGateway, FakeHandler, FakeParams, StubCall, StubRequest } from '../src/testing/index.ts';
// The restated account types and words are checked on the *built* published entry, the way a consumer app sees them
// (5.15, D3): a type-only import resolves `./dist/index.d.ts`, and `words` loads `./dist/index.js`.
import { words as builtWords } from '@byokit/openclaw';
import type { Account, AccountPick, Considered, MoveResult, RunSelection } from '@byokit/openclaw';

test('the `.` entry exports the kit, the pins and the operator scopes (5.3, D4, D6)', () => {
  assert.equal(typeof kit.OpenClawKit, 'function');
  assert.equal(ENGINE_VERSION, '2026.8.35');
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
  const route: Route = { choice: 'c', provider: 'p', plugin: 'p', billing: 'subscription', via: 'code', prerequisite: null, offer: true, reason: 'r', source: 's', revision: '2026.8.1', checked: '2026-09-30', label: 'Subscription', keyEntry: false, keyErrors: null };
  const transport: GatewayTransport = { start: async () => hello, request: async () => null, onEvent: () => () => {}, onClose: () => () => {}, stop: async () => {} };
  const call: CallOptions = { timeoutMs: 1 };
  // The generated pass-through names exist (O2 filled the tables, per 4.6).
  const anyMethod = 'health' as GatewayMethod;
  const anyEvent = 'agent' as GatewayEventName;
  assert.ok([options, retained, state, hello, member, tool, host, spec, event, end, view, approval, decision, route, transport, call, anyMethod, anyEvent]);
});

test('the built `.` entry restates the §5.15 account types and returns its account words (5.15, D3)', () => {
  // Type-level: these compile only when the built entry publishes the restated shapes, including the kit-only
  // 'bound'/'paid' members that @byokit/accounts never returns.
  const considered: Considered = { id: 'openai', left: 'unknown', age: 'unknown', confidence: 'unknown', reason: 'state' };
  const selection: RunSelection = { account: 'auto', needs: ['openai/gpt-5.1'], provider: 'openai' };
  const account: Account = { id: 'openai', provider: 'openai', route: 'openai:browser', name: 'Work', label: 'ChatGPT', billing: 'subscription', state: 'ready', addedAt: 0 };
  const chosen: AccountPick = { ok: true, account, model: 'gpt-5.1', how: 'chosen', why: 'chosen', reason: 'You chose it.', considered: [considered] };
  const refused: AccountPick = { ok: false, code: 'paid', reason: builtWords('account.paid', { name: 'Work' }), considered: [considered] };
  const move: MoveResult = { ok: false, code: 'busy', message: 'A run is live.', live: 'agent:me:main' };
  assert.ok([considered, selection, account, chosen, refused, move]);
  // Words journey through the built export: the §5.15 sentences are on the published surface.
  assert.equal(builtWords('account.bound', { name: 'Work' }), 'This conversation uses Work. Move it to switch accounts.');
  assert.equal(builtWords('account.paid', { name: 'Work' }), 'This conversation uses Work, which is billed per use. Choose Work to keep going.');
});

test('the `./device` entry exports the device client and the portable notice opener (7.2, 7.3)', () => {
  assert.equal(typeof device.openclawDevice, 'function');
  assert.equal(typeof device.openNotice, 'function');
});

test('every type the entries hand a caller is nameable from its own entry, and none carries `any`', () => {
  // A caller annotates what an entry returns instead of inferring it or casting it.
  const facts: RouteFacts = { platform: 'rn', host: false };
  const view: RouteView = new kit.OpenClawKit({ stateDir: '.' }).routes()[0]!;
  const json: JsonValue = { ok: [1, 'two', null] };
  const params: GatewayMethods['agents.create']['params'] = { name: 'ana', workspace: '/w' };
  const end: DeviceEndFrame<{ ok: boolean }> = { type: 'end', end: { ok: true, text: 'hi', data: { ok: true } } };
  const client: OpenClawDevice = device.openclawDevice({} as never);
  const linkOptions: OpenClawLinkOptions = { memberOf: () => undefined };
  const linkHost: OpenClawLinkHost | undefined = undefined;
  const serveOptions: OpenClawServeOptions | undefined = undefined;
  const serveHandle: OpenClawServeHandle | undefined = undefined;
  // The fake's script is typed per method, and its recorded call is a typed request, never `any`.
  const scripted: FakeHandler<'agents.list'> = () => ({ defaultId: 'main' });
  const fakeParams: FakeParams<'agents.create'> = { name: 'ana', workspace: '/w' };
  const body: StubRequest = { model: 'test', messages: [{ role: 'user', content: 'hi' }] };
  const recorded: StubCall = { authorization: 'Bearer x', path: '/v1/chat/completions', body };
  const fake: FakeGateway | undefined = undefined;
  // The kit's own generic wrapper writes once, over the published tables.
  const forward = async <M extends GatewayMethod>(k: OpenClawKit, method: M, p: kit.GatewayParams<M>): Promise<kit.GatewayResult<M>> => k.call(method, p);
  void [view, json, params, end, client, linkOptions, linkHost, serveOptions, serveHandle, scripted, fakeParams, recorded, fake, forward];
});

test('`.` and `./device` both export the kit\'s words (5.14)', () => {
  for (const entry of [kit, device]) {
    assert.equal(entry.words('approval.ask', { helper: 'Your helper', summary: 'save a note' }), 'Your helper wants to save a note. Allow it?');
    assert.equal(entry.stateWords({ phase: 'ready' }), 'Ready.');
    assert.deepEqual(entry.toAccountView(null, true), { ready: true, signIn: null });
  }
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

test('the O4 facade constructs without side effects; O9 link and device are built', () => {
  const facade = new kit.OpenClawKit({ stateDir: '.' });
  assert.deepEqual(facade.state, { phase: 'stopped' });
  // O9 built the factories: the device client builds off any link, and the host adapter off any kit.
  assert.equal(typeof device.openclawDevice({} as never).state, 'function');
  assert.equal(typeof link.openclawLink(facade, { memberOf: () => undefined }).handle, 'function');
});
