// The contract suite (docs/capability-kits.md 5.5, 3.4): the same cases run against the fake recorder in `npm test`
// (BK-C2) and a real recorder on the owner's machine or in a lab (BK-C3). Cases needing `fake` skip without it.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { PROTOCOL, PROTOCOL_FLOOR } from '../constants.ts';
import { CaptureError } from '../errors.ts';
import type { Capture } from '../capture.ts';
import type { Source } from '../types.ts';
import type { FakeRecorder } from './fake-recorder.ts';

export type CaptureContractBench = { capture: Capture; source: Source; root: string; fake?: FakeRecorder };
export type CaptureContractTestFn = (
  name: string,
  fn: (t: { skip(message?: string): void }) => void | Promise<void>,
) => void | Promise<void>;
export type CaptureContractOptions = {
  /** The runner's `test` (node:test's by default). */
  test?: CaptureContractTestFn;
};

const BASE_ENV_KEYS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'PATH',
  'LANG',
];
const DISPLAY_ENV_KEYS = [
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'HYPRLAND_INSTANCE_SIGNATURE',
  'XAUTHORITY',
  'DISPLAY',
];

async function collectRecord(capture: Capture, o: Parameters<Capture['record']>[0]) {
  const events: Array<{ event: string; take?: string; seconds?: number; warnings?: string[] }> = [];
  // `consent-pending` comes first on a `screen` source and is not part of what the cases compare.
  for await (const e of capture.record(o)) if (e.event !== 'consent-pending') events.push(e as { event: string });
  return events;
}

export function captureContract(
  make: () => Promise<CaptureContractBench>,
  options?: CaptureContractOptions | CaptureContractTestFn,
): void {
  const runTest: CaptureContractTestFn =
    typeof options === 'function' ? options : (options?.test ?? (nodeTest as unknown as CaptureContractTestFn));

  async function bench<T>(run: (b: CaptureContractBench) => Promise<T>): Promise<T> {
    const b = await make();
    try {
      return await run(b);
    } finally {
      await b.capture.stop().catch(() => {});
    }
  }

  function needFake(t: { skip(message?: string): void }, b: CaptureContractBench): asserts b is CaptureContractBench & { fake: FakeRecorder } {
    if (!b.fake) t.skip('needs the fake recorder');
  }

  runTest('contract: hello has the 6.3 shape, a protocol in range and none in events', async () => {
    await bench(async ({ capture }) => {
      const hello = await capture.hello();
      assert.ok(Number.isInteger(hello.protocol));
      assert.ok(hello.protocol >= PROTOCOL_FLOOR && hello.protocol <= PROTOCOL);
      assert.match(hello.recorder.name, /^[a-z0-9][a-z0-9._-]{0,63}$/);
      assert.ok(hello.recorder.version.length >= 1 && hello.recorder.version.length <= 64);
      assert.ok(hello.sources.length > 0);
      for (const s of hello.sources) assert.ok(['screen', 'x11', 'android'].includes(s));
      assert.equal(new Set(hello.sources).size, hello.sources.length);
      assert.equal(hello.android, hello.sources.includes('android'));
      assert.ok(hello.events.includes('none'));
      for (const e of hello.events) assert.ok(['own', 'none'].includes(e));
      assert.equal(typeof hello.planner.available, 'boolean');
      assert.equal(typeof hello.planner.needsKey, 'boolean');
    });
  });

  runTest('contract: record yields recording then done with the take under root', async () => {
    await bench(async ({ capture, source, root }) => {
      const events = await collectRecord(capture, { source, root, maxSeconds: 2 });
      assert.equal(events.length, 2);
      assert.equal(events[0]?.event, 'recording');
      assert.equal(events[1]?.event, 'done');
      const recordingTake = (events[0] as { take: string }).take;
      const doneTake = (events[1] as { take: string }).take;
      assert.equal(doneTake, recordingTake);
      assert.equal(dirname(doneTake), root);
      assert.ok((events[1] as { seconds: number }).seconds <= 3);
      assert.ok(existsSync(doneTake));
    });
  });

  runTest('contract: aborting after recording still yields done within 15s', async () => {
    await bench(async ({ capture, source, root }) => {
      const controller = new AbortController();
      const seen: Array<{ event: string; take?: string }> = [];
      const deadline = Date.now() + 15_000;
      let recordingTake: string | undefined;
      for await (const e of capture.record({ source, root, maxSeconds: 600, signal: controller.signal })) {
        seen.push(e as { event: string });
        if ((e as { event: string }).event === 'recording') {
          recordingTake = (e as { take: string }).take;
          controller.abort();
        }
      }
      assert.ok(recordingTake !== undefined);
      assert.equal(seen[seen.length - 1]?.event, 'done');
      assert.ok(Date.now() < deadline);
      assert.ok(existsSync(recordingTake));
    });
  });

  runTest('contract: a second record while one runs rejects already-recording', async () => {
    await bench(async ({ capture, source, root }) => {
      const controller = new AbortController();
      const first = capture.record({ source, root, maxSeconds: 60, signal: controller.signal });
      let head = await first.next();
      while ((head.value as { event: string } | undefined)?.event === 'consent-pending') head = await first.next();
      assert.equal((head.value as { event: string } | undefined)?.event, 'recording');
      const second = capture.record({ source, root, maxSeconds: 2 });
      await assert.rejects(second.next(), (error: unknown) => {
        assert.ok(error instanceof CaptureError);
        assert.equal((error as CaptureError).code, 'already-recording');
        return true;
      });
      controller.abort();
      for await (const _ of first) void _;
    });
  });

  runTest("contract: stop with nothing recording resolves 'not-recording'", async () => {
    await bench(async ({ capture }) => {
      assert.equal(await capture.stop(), 'not-recording');
    });
  });

  runTest('contract: plan-only make estimates without writing a video', async () => {
    await bench(async ({ capture, source, root }) => {
      const events = await collectRecord(capture, { source, root, maxSeconds: 2 });
      const take = (events[1] as { take: string }).take;
      const result = await capture.make({ take, planOnly: true });
      assert.equal(result.out, null);
      assert.equal(result.planner.failed, false);
      assert.equal(existsSync(join(take, 'out')), false);
    });
  });

  runTest('contract: make writes an mp4 inside the take with zero spend and no key', async () => {
    await bench(async ({ capture, source, root }) => {
      const events = await collectRecord(capture, { source, root, maxSeconds: 2 });
      const take = (events[1] as { take: string }).take;
      const result = await capture.make({ take });
      assert.ok(typeof result.out === 'string' && result.out !== null);
      assert.ok((result.out as string).endsWith('.mp4'));
      assert.ok((result.out as string).startsWith(take + '/'));
      assert.ok(existsSync(result.out as string));
      assert.equal(result.planner.inputTokens, 0);
      assert.equal(result.planner.usd, 0);
    });
  });

  runTest('contract: make with edits does not record again', async () => {
    await bench(async ({ capture, source, root }) => {
      const events = await collectRecord(capture, { source, root, maxSeconds: 2 });
      const take = (events[1] as { take: string }).take;
      const before = readdirSync(root).sort();
      const result = await capture.make({ take, title: 'T', captions: [{ t: 0, text: 'Hi' }] });
      assert.ok(typeof result.out === 'string');
      assert.deepEqual(readdirSync(root).sort(), before);
    });
  });

  runTest('contract: make on a missing take rejects take-input', async () => {
    await bench(async ({ capture, root }) => {
      await assert.rejects(capture.make({ take: join(root, 'nope') }), (error: unknown) => {
        assert.ok(error instanceof CaptureError);
        assert.equal((error as CaptureError).code, 'take-input');
        return true;
      });
    });
  });

  runTest('*fake*: consent no rejects consent-cancelled and keeps nothing', async (t) => {
    const b = await make();
    try {
      needFake(t, b);
      b.fake.script({ consent: 'no' });
      const before = readdirSync(b.root);
      await assert.rejects(
        collectRecord(b.capture, { source: 'screen', root: b.root, maxSeconds: 2 }),
        (error: unknown) => {
          assert.ok(error instanceof CaptureError);
          assert.equal((error as CaptureError).code, 'consent-cancelled');
          return true;
        },
      );
      assert.deepEqual(readdirSync(b.root), before);
    } finally {
      await b.capture.stop().catch(() => {});
    }
  });

  runTest('*fake*: out-of-range hellos are needs-update with the right side', async (t) => {
    const oldBench = await make();
    try {
      needFake(t, oldBench);
      oldBench.fake.script({ hello: { protocol: 0 } });
      await assert.rejects(oldBench.capture.hello(), (error: unknown) => {
        assert.ok(error instanceof CaptureError);
        assert.equal((error as CaptureError).code, 'needs-update');
        assert.equal((error as CaptureError).why, 'recorder');
        return true;
      });
    } finally {
      await oldBench.capture.stop().catch(() => {});
    }
    const newBench = await make();
    try {
      needFake(t, newBench);
      newBench.fake.script({ hello: { protocol: 2 } });
      await assert.rejects(newBench.capture.hello(), (error: unknown) => {
        assert.ok(error instanceof CaptureError);
        assert.equal((error as CaptureError).code, 'needs-update');
        assert.equal((error as CaptureError).why, 'app');
        return true;
      });
    } finally {
      await newBench.capture.stop().catch(() => {});
    }
  });

  runTest('*fake*: the planner key reaches the recorder on fd 3 only', async (t) => {
    await bench(async (b) => {
      needFake(t, b);
      const events = await collectRecord(b.capture, { source: b.source, root: b.root, maxSeconds: 2 });
      const take = (events[1] as { take: string }).take;
      const key = 'planner-key-fd3-only';
      await b.capture.make({ take, plannerKey: key, maxTokens: 100_000 });
      const makes = b.fake.invocations().filter((inv) => inv.argv.includes('make'));
      assert.ok(makes.length > 0);
      const last = makes[makes.length - 1];
      assert.equal(last?.key, key);
      assert.ok(!(last?.argv.join(' ') ?? '').includes(key));
      for (const value of Object.values(last?.env ?? {})) assert.ok(!value.includes(key));
    });
  });

  runTest("*fake*: the env is exactly 5.4's for each verb and source", async (t) => {
    await bench(async (b) => {
      needFake(t, b);
      await b.capture.hello();
      const events = await collectRecord(b.capture, { source: b.source, root: b.root, maxSeconds: 2 });
      const take = (events[1] as { take: string }).take;
      await b.capture.stop().catch(() => {});
      await b.capture.make({ take, planOnly: true });
      const kind = b.source.includes(':') ? b.source.slice(0, b.source.indexOf(':')) : b.source;
      for (const inv of b.fake.invocations()) {
        const env = inv.env;
        for (const k of BASE_ENV_KEYS) assert.ok(typeof env[k] === 'string', k);
        assert.equal(env['PATH'], '/usr/bin:/bin');
        assert.equal(env['LANG'], 'C.UTF-8');
        assert.equal(env['HOME']?.endsWith('capture/home') ?? false, true);
        assert.equal(env['XDG_CONFIG_HOME'], env['HOME'] + '/.config');
        assert.equal(env['XDG_STATE_HOME'], env['HOME'] + '/.local/state');
        assert.equal(env['XDG_CACHE_HOME'], env['HOME'] + '/.cache');
        assert.equal(env['XDG_DATA_HOME'], env['HOME'] + '/.local/share');
        for (const k of Object.keys(env)) {
          assert.ok([...BASE_ENV_KEYS, ...DISPLAY_ENV_KEYS].includes(k), `unexpected env ${k}`);
        }
        const verb = inv.argv[1];
        if (verb === 'hello' || verb === 'stop' || verb === 'make') {
          for (const k of DISPLAY_ENV_KEYS) assert.equal(env[k], undefined, `${verb} leaks ${k}`);
        }
        if (verb === 'record') {
          if (kind === 'screen') {
            assert.equal(env['DISPLAY'], undefined);
            assert.equal(env['XAUTHORITY'], undefined);
          } else if (kind === 'x11') {
            assert.ok(typeof env['DISPLAY'] === 'string' && env['DISPLAY'].length > 0);
            assert.equal(env['WAYLAND_DISPLAY'], undefined);
            assert.equal(env['HYPRLAND_INSTANCE_SIGNATURE'], undefined);
            assert.equal(env['DBUS_SESSION_BUS_ADDRESS'], undefined);
          } else {
            assert.equal(env['DISPLAY'], undefined);
            assert.equal(env['WAYLAND_DISPLAY'], undefined);
            assert.equal(env['XAUTHORITY'], undefined);
          }
        }
      }
      void basename(take);
    });
  });

  runTest('*fake*: corrupt, flood and hang map to protocol, too-much-output and timeout', async (t) => {
    const corruptBench = await make();
    try {
      needFake(t, corruptBench);
      corruptBench.fake.script({ corrupt: 'hello' });
      await assert.rejects(corruptBench.capture.hello(), (error: unknown) => {
        assert.ok(error instanceof CaptureError);
        assert.equal((error as CaptureError).code, 'protocol');
        return true;
      });
    } finally {
      await corruptBench.capture.stop().catch(() => {});
    }
    await bench(async (b) => {
      needFake(t, b);
      const events = await collectRecord(b.capture, { source: b.source, root: b.root, maxSeconds: 2 });
      const take = (events[1] as { take: string }).take;
      b.fake.script({ flood: 'stdout' });
      await assert.rejects(b.capture.make({ take }), (error: unknown) => {
        assert.ok(error instanceof CaptureError);
        assert.equal((error as CaptureError).code, 'too-much-output');
        return true;
      });
    });
    const hangBench = await make();
    try {
      needFake(t, hangBench);
      hangBench.fake.script({ hang: 'hello' });
      await assert.rejects(hangBench.capture.hello(), (error: unknown) => {
        assert.ok(error instanceof CaptureError);
        assert.equal((error as CaptureError).code, 'timeout');
        return true;
      });
    } finally {
      await hangBench.capture.stop().catch(() => {});
    }
  });

  runTest('*fake*: a cap below the estimate rejects preflight-refused with planned and cap', async (t) => {
    await bench(async (b) => {
      needFake(t, b);
      const events = await collectRecord(b.capture, { source: b.source, root: b.root, maxSeconds: 2 });
      const take = (events[1] as { take: string }).take;
      await assert.rejects(
        b.capture.make({ take, plannerKey: 'k', maxTokens: 1 }),
        (error: unknown) => {
          assert.ok(error instanceof CaptureError);
          assert.equal((error as CaptureError).code, 'preflight-refused');
          const detail = (error as CaptureError).detail ?? {};
          assert.equal(typeof detail['planned'], 'number');
          assert.equal(typeof detail['cap'], 'number');
          return true;
        },
      );
    });
  });
}
