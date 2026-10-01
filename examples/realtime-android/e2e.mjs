import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [serial, directory = '.proof', mode] = process.argv.slice(2);
assert.match(serial ?? '', /^emulator-\d+$/, 'An explicit emulator serial is required; phones are forbidden.');
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000 });
assert.equal(adb('shell', 'getprop', 'ro.kernel.qemu').trim(), '1', 'This check runs only on an emulator.');
const out = resolve(directory);
mkdirSync(out, { recursive: true });
const pkg = 'io.github.umeranjum17.byokit.realtimeproof';
const save = (name, data) => writeFileSync(resolve(out, name), data);
let pid;
const logs = () => adb('logcat', '-d', `--pid=${pid}`);
const waitFor = async (test, name) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (test()) return; await delay(200); }
  throw new Error(`Timed out waiting for ${name}.`);
};
const phase = async value => {
  await waitFor(() => {
    const log = logs();
    assert.ok(!log.includes('BYOKIT_RT_PROOF failed'), 'The local peer failed.');
    return log.includes(`BYOKIT_RT_PROOF ${value}`);
  }, value);
};
const state = name => {
  const appops = adb('shell', 'cmd', 'appops', 'get', pkg, 'RECORD_AUDIO');
  const audio = adb('shell', 'dumpsys', 'audio');
  const log = logs();
  save(`${name}-appops.txt`, appops); save(`${name}-audio.txt`, audio); save(`${name}-native.log`, log);
  if (['warm-0', 'attached-1', 'released-1'].includes(name)) {
    save(`${name}.png`, execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 15000 }));
  }
  // Only current configurations, not the historical rec start/stop event log.
  const recording = audio.split(/RecordActivityMonitor dump time:/)[1]?.split('Events log:')[0];
  assert.notEqual(recording, undefined, 'dumpsys audio recording section is missing.');
  const active = recording.includes(pkg);
  const running = /\(running\)/.test(appops);
  console.log(`${name}: RECORD_AUDIO running=${running}, active recording=${active}`);
  return { running, active, log };
};
const check = (name, expected) => {
  const observed = state(name);
  assert.equal(observed.running, expected, `${name}: RECORD_AUDIO`);
  assert.equal(observed.active, expected, `${name}: active recording`);
  return observed;
};
const tap = text => {
  adb('shell', 'uiautomator', 'dump', '/sdcard/byokit-realtime-proof.xml');
  const xml = adb('shell', 'cat', '/sdcard/byokit-realtime-proof.xml');
  const node = xml.match(new RegExp(`<node[^>]*text="${text}"[^>]*/?>`, 'i'))?.[0];
  assert.ok(node, `Missing ${text} button.`);
  const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  assert.ok(bounds, 'Missing button bounds.');
  const [, x1, y1, x2, y2] = bounds.map(Number);
  adb('shell', 'input', 'tap', String(Math.floor((x1 + x2) / 2)), String(Math.floor((y1 + y2) / 2)));
};
try {
  adb('shell', 'am', 'force-stop', pkg);
  adb('shell', 'pm', 'grant', pkg, 'android.permission.RECORD_AUDIO');
  adb('shell', 'am', 'start', '-n', `${pkg}/.MainActivity`);
  await waitFor(() => {
    try { pid = adb('shell', 'pidof', pkg).trim(); }
    catch (error) { if (error.status === 1) return false; throw error; }
    return /^\d+$/.test(pid);
  }, 'app process');
  await phase('warm');
  const baseline = mode === '--expect-warm-recording';
  // Observe the entire warm interval; a closed indicator at its end alone
  // would miss recording which started and stopped before the snapshot.
  for (let i = 0; i < 10; i++) {
    const warm = check(`warm-${i}`, baseline);
    if (!baseline) assert.ok(!/WebRtcAudioRecordExternal: startRecording/.test(warm.log), 'Native recording started before attach.');
    await delay(500);
  }
  if (baseline) { console.log('Reproduced: trackless warm peer records before attach.'); }
  else {
    for (let cycle = 1; cycle <= 2; cycle++) {
      tap('Attach microphone'); await phase('attached');
      await waitFor(() => /\(running\)/.test(adb('shell', 'cmd', 'appops', 'get', pkg, 'RECORD_AUDIO')), 'recording to start');
      const attached = check(`attached-${cycle}`, true);
      assert.equal((attached.log.match(/WebRtcAudioRecordExternal: startRecording/g) ?? []).length, cycle);
      tap('Release microphone'); await phase('released');
      await waitFor(() => !/\(running\)/.test(adb('shell', 'cmd', 'appops', 'get', pkg, 'RECORD_AUDIO')), 'recording to stop');
      check(`released-${cycle}`, false);
    }
    assert.equal((logs().match(/rn-webrtc:pc:DEBUG \d+ createOffer \+/g) ?? []).length, 1, 'Attach/release must keep the original call without a re-offer.');
    console.log('PASS: warm capture closed; attach records; release closes; reattach works on the same call.');
  }
} finally {
  if (pid) save('native.log', logs());
  adb('shell', 'am', 'force-stop', pkg);
}
