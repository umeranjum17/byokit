// Measured probes plus explicit operator observations for phone/account interactions.
import { machine } from '../../packages/cloud/src/machine.ts';
import { memoryStore } from '../../packages/cloud/src/testing/fake-provider.ts';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import type { Check, Observation, ProofHooks, Session } from './proof.ts';

export type ProbeOptions = {
  apiRoot: string;
  key: () => Promise<string>;
  // SSH VM's app-owned HTTPS relay URL. The SSH adapter cannot supply one.
  vmRelayUrl: string;
  // Public address observed by the provider/VM console, not a guessed private hostname -I address.
  publicAddress(session: Session): Promise<string>;
  // App operator completes a phone pairing and real engine sign-in on the lab machine.
  ask(prompt: string): Promise<string>;
  // These app probes are remote argv, run against the dedicated lab machines only.
  // Output is one JSON observation. In particular the peak probe must exercise real app work.
  commands: Partial<Record<Check, readonly string[]>>;
};
const timed = { timeoutMs: 120_000 };
async function socket(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('WebSocket handshake timed out')); }, 15_000);
    ws.once('open', () => { clearTimeout(timer); ws.close(); resolve(); });
    ws.once('error', error => { clearTimeout(timer); ws.terminate(); reject(error); });
  });
}
function relayUrl(s: Session, options: ProbeOptions): URL {
  const url = new URL(s.url ?? options.vmRelayUrl);
  assert.ok(!url.username && !url.password && !url.search && !url.hash, 'relay URL must not carry a credential');
  assert.ok(url.protocol === 'https:' || url.protocol === 'wss:', 'live relay requires TLS');
  return url;
}
async function observation(s: Session, argv: readonly string[]): Promise<Observation> {
  const r = await s.provider.exec(s.ref, argv, timed);
  assert.equal(r.code, 0); assert.equal(r.timedOut, false);
  const result = JSON.parse(r.stdout) as Observation;
  assert.ok(['pass', 'fail', 'observed', 'unavailable'].includes(result.status));
  assert.equal(typeof result.detail, 'string');
  return result;
}
export function probes(o: ProbeOptions): ProofHooks {
  return {
    address: o.publicAddress,
    observe: async (check, s) => {
      if (o.commands[check]) return observation(s, o.commands[check]!);
      if (['websocket', 'relay-resume', 'route-rehost'].includes(check)) {
        const url = relayUrl(s, o); url.protocol = 'wss:'; url.pathname = '/relay/v1/host';
        await socket(url.href);
        return { status: 'pass', detail: 'relay WebSocket upgraded through the configured TLS ingress' };
      }
      if (check === 'plan-fields') {
        if (!s.provider.plan) return { status: 'unavailable', detail: 'SSH VM has no provider plan API' };
        const plan = await s.provider.plan();
        return { status: 'observed', detail: `inTrial=${plan.inTrial}; canStayOn=${plan.canStayOn}; trialEndsAt=${plan.trialEndsAt}; checkout present=${plan.checkoutUrl !== null}` };
      }
      if (check === 'raw-port') {
        const address = await o.publicAddress(s);
        const url = new URL(`http://${address.includes(':') ? `[${address}]` : address}:${s.app.exposure.port}/health`);
        let reachable = false;
        try { await fetch(url, { signal: AbortSignal.timeout(10_000) }); reachable = true; } catch { /* unreachable is the measurement */ }
        return { status: 'observed', detail: `raw public relay port reachable without proxy: ${reachable}; trustProxy remains off` };
      }
      if (['phone-pairing', 'device-code', 'signin-resume', 'claimed-key'].includes(check)) {
        const prompts: Partial<Record<Check, string>> = {
          'phone-pairing': 'Pair your lab phone through this machine\'s provider TLS relay URL. Verify an encrypted request succeeds. Type yes only after it succeeds:',
          'device-code': 'Sign the lab engine in from this machine using its device-code flow; finish the code on your device and send a request. Type yes only after the datacenter sign-in succeeds:',
          'signin-resume': 'After resume, send a request with the same engine sign-in without signing in again. Type yes only after it succeeds:',
          'claimed-key': 'Separately test a key obtained from the provider app sign-in (not the pasted admin key): create, install, host, then remove a throwaway sandbox. Type yes if all succeeded, or no if the scopes were insufficient:',
        };
        if (check === 'claimed-key' && s.provider.id === 'ssh-vm') return { status: 'unavailable', detail: 'SSH VM does not use provider app sign-in' };
        const yes = (await o.ask(`${s.provider.id}: ${prompts[check]}`)).trim() === 'yes';
        return { status: check === 'claimed-key' ? 'observed' : yes ? 'pass' : 'fail', detail: `operator completed ${check}: ${yes}` };
      }
      if (check === 'disk-12gb' || check === 'peak-memory-disk') {
        if (check === 'peak-memory-disk') assert.equal((await o.ask(`${s.provider.id}: Run a representative real app workload on the smallest size. Type yes after it finishes:`)).trim(), 'yes');
        const df = await s.provider.exec(s.ref, ['df', '--output=size,used,avail', '-B1', s.app.host.workDir], timed);
        assert.equal(df.code, 0);
        const [total, used, free] = df.stdout.trim().split('\n').at(-1)!.trim().split(/\s+/).map(Number);
        assert.ok([total, used, free].every(Number.isFinite));
        const memory = await s.provider.exec(s.ref, ['systemctl', 'show', `byokit-${s.app.host.name}.service`, '--property=MemoryPeak', '--value'], { ...timed, root: true });
        const peak = Number(memory.stdout.trim());
        if (check === 'peak-memory-disk') assert.ok(memory.code === 0 && peak > 0, 'MemoryPeak must be available; supply an app workload probe otherwise');
        const enough = free >= 2 * 1024 ** 3 && used <= 12 * 1024 ** 3;
        return { status: check === 'disk-12gb' ? enough ? 'pass' : 'fail' : 'observed', detail: `disk total=${total} used=${used} free=${free} bytes; unit peak=${peak} bytes; recommended size=${enough ? 'small' : 'default'}` };
      }
      if (check === 'forwarded-for') {
        if (!s.provider.url) return { status: 'unavailable', detail: 'VM has no provider proxy; supply its own ingress observation' };
        const source = "import{createServer}from'node:http';createServer((q,r)=>r.end(JSON.stringify({xff:q.headers['x-forwarded-for']??null}))).listen(7321,'0.0.0.0')";
        const recipe = { ...s.app.host, name: 'm6-http', installRoot: [], install: [['node', '-e', `require('node:fs').writeFileSync('.m6-http.mjs',${JSON.stringify(source)})`]], run: { argv: ['node', `${s.app.host.workDir}/.m6-http.mjs`], env: {} } };
        const m = machine({ provider: s.provider, store: memoryStore({ ref: { ...s.ref, name: recipe.name }, providerKey: '' }) });
        try {
          await m.install(recipe);
          const url = await m.url(7321);
          assert.ok(url);
          const response = await fetch(url, { headers: { 'X-Forwarded-For': '198.51.100.42' }, signal: AbortSignal.timeout(15_000) });
          assert.ok(response.ok);
          const data = await response.json() as { xff: string | null };
          return { status: 'observed', detail: `proxy removed forged X-Forwarded-For: ${data.xff === null || !data.xff.includes('198.51.100.42')}; trustProxy remains off` };
        } finally {
          await s.provider.exec(s.ref, ['systemctl', 'disable', '--now', 'byokit-m6-http.service'], { ...timed, root: true });
        }
      }
      if (check === 'trial-cap') {
        if (s.provider.id === 'ssh-vm') return { status: 'unavailable', detail: 'SSH VM has no trial TTL API' };
        const answer = (await o.ask('On the new trial account, observe its actual auto-stop cap (seconds), or type paid if already outside the trial:')).trim();
        return /^\d+$/.test(answer) ? { status: 'observed', detail: `operator measured trial auto-stop cap=${Number(answer)} seconds` } : { status: 'unavailable', detail: 'trial cap not measured on a new trial account' };
      }
      if (check === 'self-id') {
        const result = await s.provider.exec(s.ref, ['hostname'], timed);
        assert.equal(result.code, 0);
        const match = result.stdout.trim() === s.ref.id;
        if (match) return { status: 'observed', detail: 'selfId argv=["hostname"]; hostname equals provider machine id' };
        const answer = (await o.ask('The hostname is not the provider machine id. Enter a verified metadata argv as JSON, or none after checking the provider metadata documentation:')).trim();
        if (answer === 'none') return { status: 'observed', detail: 'operator found no usable selfId route/file; M8 copy detection remains unavailable' };
        const argv = JSON.parse(answer) as string[];
        assert.ok(Array.isArray(argv) && argv.every(x => typeof x === 'string') && argv.length > 0);
        const found = await s.provider.exec(s.ref, argv, timed);
        assert.equal(found.code, 0); assert.equal(found.stdout.trim(), s.ref.id);
        return { status: 'observed', detail: `selfId argv=${JSON.stringify(argv)}` };
      }
      if (check === 'clean-stop') {
        // m.sleep() stops the unit itself. Testing the provider's OS shutdown requires a
        // SECOND cycle via provider.sleep(), without the kit's proactive unit stop.
        if (s.provider.sleep && s.provider.wake) {
          const path = `${s.app.host.workDir}/.byokit/m6-stop-events`;
          const before = await s.provider.exec(s.ref, ['cat', path], timed);
          assert.equal(before.code, 0, 'prior kit sleep must have recorded a SIGTERM');
          await s.provider.sleep(s.ref); await s.provider.wake(s.ref);
          const after = await s.provider.exec(s.ref, ['cat', path], timed);
          assert.equal(after.code, 0);
          const seen = after.stdout.startsWith(before.stdout) && after.stdout.slice(before.stdout.length).includes('SIGTERM');
          return { status: seen ? 'pass' : 'fail', detail: `provider-only cycle appended a new durable SIGTERM event: ${seen}` };
        }
        const answer = await o.ask('Check the dedicated VM boot-specific journal: did its console power cycle deliver SIGTERM to the app unit? Type yes only with that evidence:');
        return { status: answer.trim() === 'yes' ? 'pass' : 'fail', detail: 'VM clean-stop evidence checked in its boot-specific journal by operator' };
      }
      // Domain-specific doctor/workload/metadata probes cannot be fabricated by the generic kit.
      return { status: 'unavailable', detail: `app must provide the ${check} remote probe before this run can qualify` };
    },
    cycleVm: async s => {
      const answer = await o.ask('Power-cycle only this disposable VM in its own console, wait for SSH to return, then type yes:');
      assert.equal(answer.trim(), 'yes');
      const result = await s.provider.status(s.ref);
      assert.equal(result, 'on');
    },
    noEnvScrub: async (provider, ref) => {
      const path = '/home/user/.m6-scrub-canary';
      const bytes = new TextEncoder().encode(crypto.randomUUID());
      await provider.write(ref, path, bytes, 0o600);
      await provider.sleep!(ref);
      const resume = async (ttlSeconds: number | null) => fetch(`${o.apiRoot.replace(/\/$/, '')}/sandboxes/${encodeURIComponent(ref.id)}/resume`, {
        method: 'POST', headers: { Authorization: `Bearer ${await o.key()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttlSeconds, noEnv: true }), signal: AbortSignal.timeout(30_000),
      });
      let response = await resume(null);
      if (response.status === 422) {
        const body = await response.clone().json() as { error?: string };
        if (body.error === 'trial_auto_stop_required') response = await resume(7200);
      }
      if (response.status === 400 || response.status === 422) return { status: 'observed', detail: `redundant noEnv rejected with HTTP ${response.status}; no conversion performed` };
      assert.ok(response.ok);
      await provider.wake!(ref);
      const result = await provider.exec(ref, ['cat', path], timed);
      const kept = result.code === 0 && result.stdout === new TextDecoder().decode(bytes);
      return { status: 'observed', detail: `redundant noEnv accepted; home canary survives: ${kept}; this probe contains no model credentials` };
    },
  };
}
