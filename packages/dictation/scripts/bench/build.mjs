#!/usr/bin/env node
// Build the report's matching whisper.rn engine, with explicit source/output paths.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' }, portable: { type: 'boolean' } } });
if (!values.source || !values.output || !isAbsolute(values.source) || !isAbsolute(values.output)) throw new Error('Pass absolute --source (whisper.rn package directory) and --output paths');
const source = values.source, out = values.output, here = dirname(fileURLToPath(import.meta.url));
if (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version !== '0.7.2') throw new Error('This benchmark requires whisper.rn 0.7.2');
const cpu = arch() === 'arm64' ? 'arm' : arch() === 'x64' ? 'x86' : null;
if (!cpu) throw new Error('Benchmark build supports x64 and arm64');
const cpp = join(source, 'cpp');
const names = ['ggml.c', 'ggml.cpp', 'ggml-alloc.c', 'ggml-backend.cpp', 'ggml-backend-meta.cpp', 'ggml-backend-reg.cpp', 'ggml-backend-dl.cpp',
  'ggml-cpu/amx/amx.cpp', 'ggml-cpu/amx/mmq.cpp', 'ggml-cpu/ggml-cpu.c', 'ggml-cpu/ggml-cpu.cpp', 'ggml-cpu/quants.c', 'ggml-cpu/traits.cpp',
  'ggml-cpu/repack.cpp', 'ggml-cpu/unary-ops.cpp', 'ggml-cpu/binary-ops.cpp', 'ggml-cpu/vec.cpp', 'ggml-cpu/ops.cpp', 'ggml-opt.cpp',
  'ggml-threading.cpp', 'ggml-quants.c', 'gguf.cpp', 'whisper.cpp', `ggml-cpu/arch/${cpu}/quants.c`, `ggml-cpu/arch/${cpu}/repack.cpp`];
const files = [...names.map(n => join(cpp, n)), join(here, 'whisperBench.cpp')];
const flags = ['-O3', '-DNDEBUG', values.portable && cpu === 'x86' ? '-march=x86-64-v3' : '-march=native', '-D_GNU_SOURCE',
  '-DWSP_GGML_USE_CPU', '-DWSP_GGML_USE_CPU_REPACK', '-pthread', `-I${cpp}`, `-I${cpp}/ggml-cpu`];
const hash = createHash('sha256').update(JSON.stringify({ cpu, flags: flags.slice(0, -2) }));
for (const f of files) hash.update(readFileSync(f));
const key = hash.digest('hex'), binary = join(out, 'whisperBench'), stamp = join(out, 'build.sha256');
if (existsSync(binary) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === key) { console.log(binary); process.exit(0); }
mkdirSync(out, { recursive: true });
const objects = files.map((file, index) => {
  const object = join(out, `${index}-${basename(file)}.o`);
  const c = file.endsWith('.c');
  execFileSync(c ? 'cc' : 'c++', [c ? '-std=c11' : '-std=c++17', ...flags, '-c', file, '-o', object], { stdio: 'inherit' });
  return object;
});
execFileSync('c++', ['-pthread', ...objects, '-o', binary], { stdio: 'inherit' });
writeFileSync(stamp, key + '\n'); console.log(binary);
