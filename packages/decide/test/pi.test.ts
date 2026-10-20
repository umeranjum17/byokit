import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { pi } from '../src/pi.ts';

const schema = { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string' } } } as const;

// A stand-in for the installed pi: it records its argv and the prompt on stdin, then streams the JSON-mode events of one answer.
const fakePiSource = `#!${process.execPath}
import { writeFileSync } from 'node:fs';
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(process.env.FAKE_PI_LOG + '/invocation.json', JSON.stringify({ args: process.argv.slice(2), stdin }));
const events = [
  { type: 'session', version: 3, id: 'fake', timestamp: '2026-10-19T00:00:00.000Z', cwd: process.cwd() },
  { type: 'agent_start' },
  { type: 'message_end', message: { role: 'user', content: stdin, timestamp: 1 } },
  { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ name: 'Umer' }) }], stopReason: 'stop', usage: { input: 11, output: 3, cacheRead: 0, cacheWrite: 0 } } },
  { type: 'agent_end', messages: [], willRetry: false },
  { type: 'agent_settled' },
];
for (const event of events) console.log(JSON.stringify(event));
`;

test('the installed pi on PATH answers with the chosen model passed as --model, JSON events and no tools or session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'byokit-decide-pi-'));
  const bins = join(root, 'bins');
  const logDir = join(root, 'log');
  const previous = { PATH: process.env.PATH, FAKE_PI_LOG: process.env.FAKE_PI_LOG };
  try {
    await mkdir(bins);
    await mkdir(logDir);
    const bin = join(bins, 'pi');
    await writeFile(bin, fakePiSource, { mode: 0o700 });
    process.env.PATH = `${bins}${delimiter}${process.env.PATH ?? ''}`;
    process.env.FAKE_PI_LOG = logDir;
    const generated = await pi({ bin, model: 'deepseek/deepseek-flash', timeoutMs: 5000 }).generate({ prompt: 'Who?', schema });
    assert.deepEqual(generated.data, { name: 'Umer' });
    assert.deepEqual(generated.usage, { input_tokens: 11, output_tokens: 3 });
    const log = JSON.parse(await readFile(join(logDir, 'invocation.json'), 'utf8'));
    assert.deepEqual(log.args.slice(0, 2), ['--mode', 'json']);
    assert.equal(log.args[log.args.indexOf('--model') + 1], 'deepseek/deepseek-flash');
    for (const flag of ['--no-session', '--no-tools', '--no-extensions', '--system-prompt']) assert.ok(log.args.includes(flag), flag);
    assert.equal(log.stdin, 'Who?');
  } finally {
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(root, { recursive: true, force: true });
  }
});

test('pi refuses to start without a chosen model, so the installed pi never falls back to its own default', async () => {
  for (const model of [undefined, '', '  ']) {
    assert.throws(() => pi({ bin: '/usr/bin/pi', model, timeoutMs: 5000 } as never), /^Error: Choose a model for pi first: /);
  }
});
