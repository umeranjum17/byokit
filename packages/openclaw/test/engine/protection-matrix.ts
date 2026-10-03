// Opt-in actual matrix preparation. Importing this file executes no engine/browser/model work.
import assert from 'node:assert/strict';
import type { OpenClawKit } from '../../src/kit.ts';
import type { Bridge } from '../../src/bridge.ts';
import { fixtureBrowserHost, type BrowserHostController, type HostBroker } from '../../src/browser/host.ts';
import { fileSignInStore } from '../../src/browser/store.ts';
import type { ModelStub } from '../../src/testing/model-stub.ts';
import type { ResumeState } from '../../src/browser.ts';
import { scanCapabilities, sqliteTranscripts, boundedAwait } from './privacy-evidence.ts';

type OwnedKit = { browserHost: BrowserHostController; brokers: Map<string, HostBroker>; bridge: Bridge };
export type MatrixReceipt = { stages: { stage: string; providerBefore: number; providerAfter: number }[];
  transcripts: { stage: string; captures: ReturnType<typeof sqliteTranscripts> }[]; resumeDispatches: unknown[] };

export async function protectionMatrix(o: { kit: OpenClawKit; stateDir: string; origin: string; model: ModelStub;
  capabilities: Set<string>; receipt: MatrixReceipt; agentRequests(): number;
  restart(beforeStart?: () => void): Promise<void>; captureCapabilities(): void; privateVisited(): boolean;
  cookieObserved(member: 'ada' | 'bea'): boolean;
  retain(stage: string): ReturnType<typeof sqliteTranscripts>; emit(event: unknown): void }): Promise<void> {
  const { kit, stateDir, origin, model, capabilities, receipt } = o;
  const owned = kit as unknown as OwnedKit;
  const store = fileSignInStore(stateDir), grant = 'OWNED_MATRIX_CONTROL';
  const key = 'agent:ada:fixture:protected';
  let serial = 0;
  async function install() {
    for (const [member, broker] of owned.brokers) await broker.navigateAgent(`${origin}/${member}`);
    // Prior production host has no leases/requests on first install. stop() disposes it on each restart.
    owned.browserHost = await fixtureBrowserHost({ brokers: owned.brokers, store,
      options: { executablePath: '/unused-fixture-launch', members: ['ada', 'bea'], recovery: { attempts: 0, backoffMs: [] } },
      authorize: value => value === grant,
      siteOf: value => { assert.equal(value, origin); return '127.0.0.1'; },
      park: async (_member, session) => { await kit.abort(session); },
      resume: async input => { receipt.resumeDispatches.push(input); return 'unknown'; } });
    o.captureCapabilities();
  }
  function retain(stage: string) {
    const files = o.retain(stage);
    assert.ok(files.length && files.some(file => file.events.length), 'no durable transcripts: byte qualification unavailable');
    receipt.transcripts.push({ stage, captures: files });
    assert.equal(scanCapabilities(files, capabilities).matches.length, 0, `${stage}: durable transcript capability digest match`);
    assert.equal(scanCapabilities(model.calls, capabilities).matches.length, 0, `${stage}: full provider capability digest match`);
  }
  async function refused(stage: string, runId = `matrix-refusal-${++serial}`) {
    const before = model.calls.length, requests = o.agentRequests();
    // Keep local registration out of recovery negatives; before_agent_run must refuse in the actual engine.
    await boundedAwait(`matrix-refusal:${stage}`, () => kit.run({ member: 'ada', sessionKey: key, idempotencyKey: runId, register: false,
      message: `Source-free recovery probe ${stage}` }).catch(() => undefined), o.emit);
    assert.ok(o.agentRequests() > requests, `${stage}: must reach the owned gateway, not just a local refusal`);
    assert.equal(model.calls.length, before, `${stage}: no provider submission`);
    const outcome = { stage, providerBefore: before, providerAfter: model.calls.length };
    receipt.stages.push(outcome); o.emit({ kind: 'matrix-outcome', ...outcome });
    retain(stage);
  }
  async function unrelated(stage: string) {
    const before = model.calls.length;
    const end = await kit.run({ member: 'bea', sessionKey: 'agent:bea:fixture:matrix-replay', idempotencyKey: `public-control-${++serial}`, message: '[tool matrix_echo {}]' });
    assert.ok(end.ok); assert.ok(model.calls.length > before, `${stage}: positive unrelated-session provider control`);
    assert.ok(model.calls.slice(before).some(call => call.body.messages?.some((message: any) =>
      message.role === 'tool' && JSON.stringify(message.content).includes('PUBLIC_CAPABILITY_CONTROL'))),
      `${stage}: actual pre-provider result keeps the public positive control`);
    retain(stage);
  }
  const initial = await kit.run({ member: 'ada', sessionKey: key, message: 'PUBLIC_BOUND_SESSION_CONTROL' });
  assert.ok(initial.ok, 'create the actual bound engine session before parking it');
  await install();
  let host = owned.browserHost;
  const waiting = await host.raise({ member: 'ada', sessionKey: key, checkUrl: `${origin}/private`, reasons: ['agent-asked'] });
  await refused('waiting');
  const lease = await host.takeover(waiting.id, waiting.gen, { grant, confirmSite: waiting.site });
  capabilities.add(lease.nonce); capabilities.add('PRIVATE_MATRIX_COOKIE'); capabilities.add('PRIVATE_MATRIX_PAGE');
  capabilities.add(`${origin}/private`);
  const target = (host as unknown as { leases: Map<string, { target: string }> }).leases.get(waiting.id)?.target;
  assert.ok(target, 'actual private target must exist'); capabilities.add(target);
  const privateDeadline = Date.now() + 5000;
  while (!o.privateVisited()) {
    assert.ok(Date.now() < privateDeadline, 'actual private fixture document/cookie response must have been visited');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await refused('held-private'); await unrelated('held-private');
  const parked = await host.notNow(waiting.id, waiting.gen, { grant });
  assert.equal(parked.state, 'parked');
  await owned.brokers.get('bea')!.navigateAgent(`${origin}/bea`);
  const cookieDeadline = Date.now() + 5000;
  while (!o.cookieObserved('ada')) {
    assert.ok(Date.now() < cookieDeadline, 'positive cookie control: Ada public reload sent the owned HttpOnly cookie');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(o.cookieObserved('bea'), false, 'member profiles do not share the actual private-cookie canary');
  assert.throws(() => host.confirmOrigin(lease, origin), /stale/);
  await refused('parked'); await unrelated('parked');
  const beforeRestart = model.calls.length;
  await o.restart(); await install(); host = owned.browserHost;
  assert.equal(model.calls.length, beforeRestart, 'owned restart/host restore never redispatches');
  assert.equal(host.signIns().find(row => row.id === parked.id)?.state, 'parked');
  await refused('restored-parked'); await unrelated('restored-parked');
  const reopened = await host.reopen(parked.id, host.signIns().find(row => row.id === parked.id)!.gen, { grant });
  const recoveryBroker = host.brokerBinding('ada')!.broker;
  await host.browserGone('ada', recoveryBroker); // Exact expected-broker ownership, never an unrelated exit.
  await refused('browser-gone');
  retain('browser-gone');
  // Stop disposes the old controller before the store's single writer replaces an owned fixture record.
  for (const state of ['pending', 'accepted', 'submitted', 'indeterminate', 'failed'] as ResumeState['state'][]) {
    const data = store.read(), row = data.requests.find(row => row.id === reopened.id)!;
    const oldKey = `signin:${row.id}:resume:1:owned-old-request-${state}`;
    row.state = 'settled'; row.settled = { state: 'verified', at: Date.now(), resume: { key: oldKey, attempt: 1, state } };
    const before = model.calls.length;
    const releaseOld = owned.bridge.register({ sessionKey: key, member: 'ada' }, undefined, oldKey);
    try { await o.restart(() => store.write(data)); await install(); } finally { releaseOld(); }
    host = owned.browserHost;
    assert.equal(model.calls.length, before, `restore ${state} has zero automatic submissions`);
    const restored = host.signIns().find(candidate => candidate.id === row.id)!;
    assert.equal(restored.settled!.resume!.state, state === 'failed' ? 'failed' : 'indeterminate');
    await refused(`restored-${state}`, oldKey);
    await unrelated(`restored-${state}`);
  }
  assert.equal(receipt.resumeDispatches.length, 0, 'no automatic resume dispatch during any restoration');
}
