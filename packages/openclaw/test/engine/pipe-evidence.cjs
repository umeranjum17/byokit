// Fixture-only preload: retain original pipe chunks BEFORE broker parsing, without changing routing.
const fs = require('node:fs');
const cp = require('node:child_process');
const log = process.env.BYOKIT_BROWSER_PIPE_RECEIPT;
let sequence = 0;
const tracked = new Map();
const identity = pid => {
  try { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return { pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
function record(event) {
  const fd = fs.openSync(log, 'a', 0o600);
  try { fs.writeSync(fd, JSON.stringify({ sequence: ++sequence, at: Date.now(), observer: process.pid, ...event }) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
const spawn = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function (options) {
  const result = spawn.call(this, options);
  if (!log || !this.pid) return result;
  const owned = identity(this.pid);
  tracked.set(owned.pid, owned);
  record({ kind: 'spawn', ...owned, executable: options.file, args: options.args });
  this.once('exit', (code, signal) => record({ kind: 'exit', ...owned, code, signal }));
  const input = this.stdio[3], output = this.stdio[4];
  if (input && output && options.args.includes('--remote-debugging-pipe')) {
    const chunk = (direction, bytes) => record({ kind: 'native-pipe-chunk', ...owned, direction,
      bytes: bytes.length, base64: bytes.toString('base64') });
    output.prependListener('data', bytes => chunk('native-to-broker', Buffer.from(bytes)));
    const write = input.write;
    input.write = function (bytes, ...args) {
      chunk('broker-to-native', Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
      return write.call(this, bytes, ...args);
    };
  }
  return result;
};
// Targeted owned-child traversal only; never enumerate unrelated processes.
if (log) {
  const timer = setInterval(() => {
    for (const [pid, owned] of tracked) {
      const current = identity(pid);
      if (!current || current.start !== owned.start) { tracked.delete(pid); record({ kind: 'owned-absent', ...owned }); continue; }
      let children;
      try { children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const child of children) if (!tracked.has(child)) {
        const descendant = identity(child);
        if (descendant) { tracked.set(child, descendant); record({ kind: 'owned-descendant', parent: pid, ...descendant }); }
      }
    }
  }, 10);
  timer.unref();
  const write = process.stderr.write;
  process.stderr.write = function (bytes, ...args) {
    if (String(bytes).includes('pw:protocol')) record({ kind: 'playwright-client-protocol', text: String(bytes) });
    return write.call(this, bytes, ...args);
  };
}
const kill = cp.ChildProcess.prototype.kill;
cp.ChildProcess.prototype.kill = function (signal) {
  if (!log || !this.pid) return kill.call(this, signal);
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const owned = rows.find(row => row.kind === 'spawn' && row.pid === this.pid), current = identity(this.pid);
  record({ kind: 'shutdown', expected: owned, current, signal: signal ?? 'SIGTERM' });
  if (current && (!owned || current.start !== owned.start)) throw new Error('owned child identity changed; refusing shutdown');
  return current ? kill.call(this, signal) : false;
};
