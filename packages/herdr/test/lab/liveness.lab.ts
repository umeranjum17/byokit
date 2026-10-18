// Real Herdr liveness journey. Run only with a named, provisioned lab session and its server PID.
// Never run in the default session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HerdrKit } from '../../dist/index.js';

const socketPath = process.env.HERDR_LAB_SOCKET;
const serverPid = Number(process.env.HERDR_LAB_PID);
if (!socketPath || socketPath.includes('/default/') || !Number.isSafeInteger(serverPid) || serverPid < 1) {
  throw new Error('liveness lab requires a named lab socket and its owned server PID');
}

const until = async (ok: () => boolean, ms: number, what: string) => {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() >= deadline) assert.fail(`not reached within ${ms}ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test('real Herdr becomes stalled while stopped and ready after it resumes', async () => {
  const kit = new HerdrKit({ mode: 'adopt', bin: '/usr/bin/herdr', socketPath, livenessTimeoutMs: 1000,
    onState: (state) => console.log(`state=${state.phase}${state.why ? `/${state.why}` : ''}`) });
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    assert.equal(kit.snapshot().connected, true);
    process.kill(serverPid, 'SIGSTOP');
    await until(() => kit.state.phase === 'stalled', 20_000, 'stalled state');
    assert.equal(kit.snapshot().connected, false);
    process.kill(serverPid, 'SIGCONT');
    await until(() => kit.state.phase === 'ready' && kit.snapshot().connected, 10_000, 'ready state');
  } finally {
    try { process.kill(serverPid, 'SIGCONT'); } catch { /* server already exited */ }
    await kit.stop();
  }
});
