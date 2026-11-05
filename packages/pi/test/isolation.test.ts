// The person's own Pi stays out of every bot, and Pi's shapes stay behind transport.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPiKit, PiError } from '../src/index.ts';
import { scratchDir } from '../../test-support.ts';
import { ended, fakeModel, next, scene } from './fake-model.ts';

const treeHash = (dir: string): string => {
  const hash = createHash('sha256');
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      hash.update(full);
      if (entry.isDirectory()) walk(full); else hash.update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
};

test('the person\'s own Pi folder is never used: same hash after, nothing of it reaches a bot, no secret is inherited', async (t) => {
  // scripts/test.sh runs every test in a throwaway HOME, so this is a stand-in person: the real ~/.pi is hashed by that script.
  const person = join(homedir(), '.pi');
  mkdirSync(join(person, 'agent', 'extensions'), { recursive: true });
  mkdirSync(join(person, 'agent', 'skills', 'canary'), { recursive: true });
  mkdirSync(join(person, 'agent', 'sessions'), { recursive: true });
  writeFileSync(join(person, 'agent', 'auth.json'), '{"canary":{"type":"api_key","key":"CANARY-KEY"}}');
  writeFileSync(join(person, 'agent', 'AGENTS.md'), 'CANARY person context');
  writeFileSync(join(person, 'agent', 'settings.json'), '{"defaultModel":"canary-model"}');
  writeFileSync(join(person, 'agent', 'models.json'), '{"providers":{"canary":{"baseUrl":"http://127.0.0.1:9/v1","api":"openai-completions","apiKey":"CANARY-KEY","models":[{"id":"canary-model"}]}}}');
  writeFileSync(join(person, 'agent', 'extensions', 'canary.ts'), 'throw new Error("CANARY extension loaded");');
  writeFileSync(join(person, 'agent', 'skills', 'canary', 'SKILL.md'), '---\nname: canary\ndescription: CANARY skill\n---\nCANARY');
  const before = treeHash(person);
  process.env.OPENAI_API_KEY = 'CANARY-KEY';
  process.env.PI_CODING_AGENT_SESSION_DIR = join(person, 'agent', 'sessions');
  t.after(() => { delete process.env.OPENAI_API_KEY; delete process.env.PI_CODING_AGENT_SESSION_DIR; });

  const model = await fakeModel();
  t.after(() => model.close());
  const crew = scene(scratchDir('pi-isolation'), model.url);
  const kit = createPiKit({ stateDir: crew.stateDir });
  t.after(() => kit.close());
  const specs = ['first', 'second'].map((id) => ({ ...crew.bot(id), extensions: [join(import.meta.dirname, 'fixtures', 'extension.ts')] }));
  for (const spec of specs) {
    const bot = kit.bot(spec);
    const done = next(bot, ended);
    await bot.prompt('answer: all good');
    assert.deepEqual((await done).end, { ok: true, text: 'all good' });
    const env = JSON.parse(readFileSync(join(crew.stateDir, 'pi', spec.id, 'seen-env.json'), 'utf8')) as Record<string, string>;
    assert.equal(env.PI_CODING_AGENT_DIR, join(crew.stateDir, 'pi', spec.id));
    assert.equal(env.HOME, env.PI_CODING_AGENT_DIR);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.PI_CODING_AGENT_SESSION_DIR, undefined);
    assert.equal(env.PI_OFFLINE, '1');
  }
  await kit.close();

  assert.equal(treeHash(person), before);
  assert.ok(model.seen.length >= 2);
  for (const call of model.seen) assert.doesNotMatch(JSON.stringify(call), /CANARY/);
  assert.equal(readdirSync(join(person, 'agent', 'sessions')).length, 0);
});

test('the kit refuses the person\'s Pi folder and unsafe names before anything runs', () => {
  const coded = (code: string) => (error: PiError) => error.code === code;
  const person = join(homedir(), '.pi', 'agent');
  assert.throws(() => createPiKit({ stateDir: person }), coded('person-pi'));
  assert.throws(() => createPiKit({ stateDir: 'relative' }), coded('bad-state-dir'));
  const kit = createPiKit({ stateDir: '/app/state' });
  assert.throws(() => kit.bot({ id: 'a', folder: person, session: 's' }), coded('person-pi'));
  assert.throws(() => kit.bot({ id: '../a', folder: '/app/a', session: 's' }), coded('bad-id'));
  assert.throws(() => kit.bot({ id: 'a', folder: '/app/a', session: '../s' }), coded('bad-session'));
  assert.throws(() => kit.bot({ id: 'a', folder: 'bots/a', session: 's' }), coded('bad-folder'));
  assert.throws(() => kit.bot({ id: 'a', folder: '/app/a', session: 's', extensions: ['pi-thing'] }), coded('bad-extension'));
});

test('only transport.ts knows Pi: no other source names its package, launch or records', () => {
  const src = join(import.meta.dirname, '..', 'src');
  const others = readdirSync(src).filter((name) => name !== 'transport.ts');
  assert.deepEqual(others.sort(), ['index.ts', 'kit.ts', 'types.ts']);
  for (const name of others) assert.doesNotMatch(readFileSync(join(src, name), 'utf8'), /earendil|child_process|PI_[A-Z]|agent_settled|message_update|streamingBehavior/, name);
});
