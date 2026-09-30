#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { runWer } from './wer.ts';

try {
  const { values } = parseArgs({ options: { binary: { type: 'string' }, model: { type: 'string' }, manifest: { type: 'string' },
    profile: { type: 'string', multiple: true }, output: { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('byokit-dictation-wer --binary /path/to/whisper-cli --model /path/to/ggml-base.en-q5_1.bin [--manifest /path/to/manifest.json] [--profile default] [--output report.json] [--timeout-ms 120000]');
  } else {
    if (!values.binary || !values.model) throw new Error('--binary and --model are required; nothing is discovered or downloaded');
    const report = await runWer({ binary: values.binary, model: values.model,
      manifest: values.manifest ?? fileURLToPath(new URL('../fixtures/wer/manifest.json', import.meta.url)), profiles: values.profile,
      timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']) });
    const json = JSON.stringify(report, null, 2) + '\n';
    if (values.output) await writeFile(values.output, json);
    process.stdout.write(json);
  }
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
