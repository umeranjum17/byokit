// Built @byokit/pi and the real pinned Pi against the loopback stand-in model; no account, no provider, no credential.
// The wall is real bubblewrap but belongs to this capture: the kit ships the seam, never a wall.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiKit, PiError } from '@byokit/pi';
import { ended, fakeModel, next, scene, stopped } from '../../../../packages/pi/test/fake-model.ts';

const evidence = process.env.DONE_DONE_EVIDENCE_ROOT;
assert.ok(evidence, 'run through done-done');
const require = createRequire(import.meta.url);
assert.match(require.resolve('@byokit/pi'), /packages\/pi\/dist\/index\.js$/);
assert.ok(existsSync('/usr/bin/bwrap'), 'this journey needs bubblewrap at /usr/bin/bwrap');

const log = [];
const note = (text) => { log.push(text); console.log(text); };
const root = mkdtempSync(join(tmpdir(), 'byk-pi-launch-'));
const model = await fakeModel();
const crew = scene(root, model.url);
const secret = join(root, 'outside-the-wall.txt');
writeFileSync(secret, 'CANARY');
const spec = crew.bot('walled');
const home = join(crew.stateDir, 'pi', 'walled');
const extension = join(spec.folder, 'record.ts');
writeFileSync(extension, `import { existsSync, writeFileSync } from 'node:fs';
export default function record() {
  writeFileSync(process.env.SECRET + '.written', 'x');
  writeFileSync(process.env.PI_CODING_AGENT_DIR + '/seen.json', JSON.stringify({ argv: process.argv, sees: existsSync(process.env.SECRET) }));
}
`);
const base = { ...spec, extensions: [extension], env: { ...spec.env, SECRET: secret } };
const seen = () => JSON.parse(readFileSync(join(home, 'seen.json'), 'utf8'));
const ask = async (bot, text) => {
  const done = next(bot, ended);
  await bot.prompt(text);
  return (await done).end;
};
const wall = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', root, '--bind', spec.folder, spec.folder, '--bind', home, home, '--unshare-pid', '--die-with-parent', '--chdir', spec.folder, '--'];
const kit = createPiKit({ stateDir: crew.stateDir });
try {
  const plain = kit.bot(base);
  const bareEnd = await ask(plain, 'answer: no wall');
  const bare = seen();
  await plain.stop();
  assert.deepEqual(bareEnd, { ok: true, text: 'no wall' });
  assert.equal(bare.sees, true);
  const written = existsSync(`${secret}.written`);
  assert.equal(written, true);
  rmSync(`${secret}.written`);
  note(`no launch: ${JSON.stringify(bareEnd)}, Pi sees the outside file: ${bare.sees}, its write reached the real disk: ${written}, argv ${JSON.stringify(bare.argv)}`);

  const given = [];
  const walled = kit.bot({ ...base, launch: (pi) => { given.push(pi); return { command: '/usr/bin/bwrap', args: [...wall, pi.command, ...pi.args] }; } });
  const wallEnd = await ask(walled, 'answer: behind the wall');
  const inside = seen();
  const comm = readFileSync(`/proc/${walled.pid}/comm`, 'utf8').trim();
  assert.deepEqual(wallEnd, { ok: true, text: 'behind the wall' });
  assert.deepEqual([given[0].command, ...given[0].args], bare.argv);
  assert.deepEqual(inside.argv, bare.argv);
  assert.equal(inside.sees, false);
  const leaked = existsSync(`${secret}.written`);
  assert.equal(leaked, false);
  assert.equal(comm, 'bwrap');
  note(`launch: ${JSON.stringify(wallEnd)}, process ${comm}, launch got the same argv as no launch: true, Pi sees the outside file: ${inside.sees}, its write reached the real disk: ${leaked}`);

  const down = next(walled, stopped);
  process.kill(walled.pid, 'SIGKILL');
  const crash = await down;
  const backEnd = await ask(walled, 'answer: back behind it');
  assert.equal(seen().sees, false);
  assert.equal(given.length, 2);
  note(`crash: ${crash.reason}, next message ${JSON.stringify(backEnd)}, launch ran ${given.length} times, Pi sees the outside file: ${seen().sees}`);
  const from = performance.now();
  await walled.stop();
  assert.equal(walled.pid, undefined);
  note(`stop: the walled process is gone in ${Math.round(performance.now() - from)} ms`);

  const asked = model.seen.length;
  const broken = kit.bot({ ...base, launch: () => { throw new Error('the wall is not ready'); } });
  const refusal = await broken.prompt('answer: must never run').then(() => 'accepted', (error) => error);
  assert.ok(refusal instanceof PiError && refusal.code === 'bad-launch');
  assert.equal(broken.pid, undefined);
  note(`throwing launch: ${refusal.code}: ${refusal.message}, process: ${broken.pid}`);

  const gone = kit.bot({ ...base, launch: () => ({ command: join(root, 'no-such-wall'), args: [] }) });
  const missing = await gone.prompt('answer: must never run').then(() => 'accepted', (error) => error);
  assert.ok(missing instanceof PiError && missing.code === 'pi-exited');
  assert.equal(gone.pid, undefined);
  assert.equal(model.seen.length, asked);
  note(`missing wall: ${missing.code}: ${missing.message.replace(root, '<scratch>')}, process: ${gone.pid}`);
  note(`the model was asked nothing by either refused start: ${model.seen.length === asked}`);
} finally {
  await kit.close();
  await model.close();
  rmSync(root, { recursive: true, force: true });
}
writeFileSync(join(evidence, 'pi-launch.log'), `${log.join('\n')}\n`);
writeFileSync(join(evidence, 'steps.json'), JSON.stringify({
  target: { version: `@byokit/pi ${JSON.parse(readFileSync('packages/pi/package.json', 'utf8')).version}` },
  start: 'A built checkout, a bot with its own folder and Pi home, a file outside them, and a loopback stand-in model',
  steps: ['Run a bot with no launch and read the argv Pi got', 'Run the same bot with a launch that puts Pi in a bubblewrap sandbox', 'Kill the walled process and send another message', 'Stop the bot', 'Start a bot whose launch throws, then one whose command is missing'],
  result: 'Pi answered from inside the wall with the same argv and could not see or write the outside file, came back inside it after a crash, and a throwing launch or a missing wall started nothing',
}, null, 2));
