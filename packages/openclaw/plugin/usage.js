// Gateway-only accounting. Reads requested UTC months, never transcript content or credentials.
import { readFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const count = v => Number.isSafeInteger(v) && v >= 0;
export const USAGE_SYMBOL = Symbol.for('byokit.engine-usage.v1');
export function readEngineStarted(dir, live, params, read = readFileSync) {
  const { agentId, startMs, endMs } = params ?? {};
  if (typeof agentId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(agentId) || !count(startMs) || !count(endMs) || startMs > endMs ||
    endMs > 8.64e15) throw new Error('Invalid usage window');
  const result = { state: 'unavailable', agentId, startMs, endMs, facts: [], unreadableLines: 0, complete: false };
  if (!dir || !live || typeof live.bootId !== 'string' || !object(live.months) || !object(live.inFlight)) return result;
  const lines = (path, absentOK) => {
    try {
      const text = read(path, 'utf8');
      const rows = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { const row = JSON.parse(line); if (!object(row)) throw new Error(); rows.push(row); }
        catch { result.unreadableLines++; }
      }
      // A torn final write is not a valid durable line, even when its JSON happens to parse.
      if (text && !text.endsWith('\n')) result.unreadableLines++;
      return rows;
    } catch (error) { if (!absentOK || error.code !== 'ENOENT') result.unreadableLines++; return []; }
  };
  const boots = new Map();
  for (const row of lines(join(dir, 'boots.jsonl'), false)) {
    if (typeof row.bootId !== 'string' || (row.startedAt === undefined && row.stoppedAt === undefined && row.spawned !== false) ||
      (row.startedAt !== undefined && !count(row.startedAt)) || (row.stoppedAt !== undefined && (!count(row.stoppedAt) || !object(row.months))) ||
      (row.spawned === false && !count(row.failedAt))) {
      result.unreadableLines++; continue;
    }
    const boot = boots.get(row.bootId) ?? {};
    if (row.startedAt !== undefined) { if (boot.startedAt !== undefined && boot.startedAt !== row.startedAt) result.unreadableLines++; boot.startedAt = row.startedAt; }
    if (row.stoppedAt !== undefined) { if (boot.stoppedAt !== undefined) result.unreadableLines++; boot.stoppedAt = row.stoppedAt; boot.months = row.months; }
    if (row.spawned === false) { boot.stoppedAt = row.failedAt; boot.months = {}; }
    boots.set(row.bootId, boot);
  }
  const starts = [...boots.values()].map(b => b.startedAt).filter(count).sort((a, b) => a - b);
  if (!starts.length) return result;
  result.coverageSince = starts[0]; result.liveBootId = live.bootId; result.state = 'available';
  let complete = startMs >= starts[0] && count(boots.get(live.bootId)?.startedAt);
  const sequences = new Map(), seen = new Map(), sequenceFacts = new Map();
  const months = [];
  const cursor = new Date(startMs); cursor.setUTCDate(1); cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= endMs) {
    const month = cursor.toISOString().slice(0, 7); months.push(month);
    for (const row of lines(join(dir, `engine-started-${month}.jsonl`), true)) {
      if (row.v !== 1 || !['started', 'ended'].includes(row.phase) || typeof row.bootId !== 'string' || !count(row.seq) || row.seq < 1 ||
        !count(row.at) || row.at > 8.64e15 || !count(row.startedAt) || row.startedAt > row.at || new Date(row.at).toISOString().slice(0, 7) !== month ||
        typeof row.chargeId !== 'string' || typeof row.agentId !== 'string' || row.kind !== 'workshop-review' ||
        typeof row.provider !== 'string' || typeof row.model !== 'string' || !boots.has(row.bootId)) { result.unreadableLines++; continue; }
      const key = `${row.bootId}\0${month}`, seq = sequences.get(key) ?? new Set(); seq.add(row.seq); sequences.set(key, seq);
      const phase = `${row.chargeId}\0${row.phase}`;
      const sequenceKey = `${key}\0${row.seq}`;
      if (sequenceFacts.has(sequenceKey) && sequenceFacts.get(sequenceKey) !== phase) result.unreadableLines++;
      sequenceFacts.set(sequenceKey, phase);
      const safe = { v: 1, phase: row.phase, bootId: row.bootId, seq: row.seq, at: row.at, startedAt: row.startedAt,
        chargeId: row.chargeId, agentId: row.agentId, kind: row.kind, provider: row.provider, model: row.model };
      if (typeof row.authProfileId === 'string') safe.authProfileId = row.authProfileId;
      if (['nothing', 'proposed', 'applied', 'failed'].includes(row.outcome)) safe.outcome = row.outcome;
      else if (row.phase === 'ended') { result.unreadableLines++; continue; }
      if (object(row.usage)) {
        safe.usage = {};
        for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoningTokens', 'total'])
          if (typeof row.usage[field] === 'number' && Number.isFinite(row.usage[field]) && row.usage[field] >= 0) safe.usage[field] = row.usage[field];
      }
      if (object(row.origin) && typeof row.origin.sessionKey === 'string') safe.origin = { sessionKey: row.origin.sessionKey,
        ...(typeof row.origin.runId === 'string' ? { runId: row.origin.runId } : {}) };
      if (seen.has(phase) && JSON.stringify(seen.get(phase)) !== JSON.stringify(safe)) result.unreadableLines++;
      seen.set(phase, safe);
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  for (const fact of seen.values()) {
    const start = fact.phase === 'ended' ? seen.get(`${fact.chargeId}\0started`) : undefined;
    if (start && ['agentId', 'bootId', 'kind', 'provider', 'model', 'authProfileId', 'startedAt'].some(k => start[k] !== fact[k]))
      result.unreadableLines++;
  }
  for (const [id, boot] of boots) {
    if (!count(boot.startedAt) || (boot.stoppedAt !== undefined && boot.stoppedAt < boot.startedAt)) { complete = false; continue; }
    if (boot.startedAt > endMs || (boot.stoppedAt !== undefined && boot.stoppedAt < startMs)) continue;
    const counters = id === live.bootId ? live.months : boot.months;
    if (!object(counters) || (id !== live.bootId && boot.stoppedAt === undefined)) { complete = false; continue; }
    for (const month of months) {
      const counter = counters[month];
      const seq = sequences.get(`${id}\0${month}`) ?? new Set();
      if (counter === undefined) { if (seq.size) complete = false; continue; }
      if (!object(counter) || !count(counter.lastSeq) || !count(counter.failed) || counter.failed !== 0 || seq.size !== counter.lastSeq ||
        [...seq].some(n => n < 1 || n > counter.lastSeq)) complete = false;
    }
  }
  for (const fact of Object.values(live.inFlight)) if (!object(fact) || !count(fact.startedAt) || fact.startedAt <= endMs) complete = false;
  result.facts = [...seen.values()].filter(f => f.agentId === agentId);
  result.live = { bootId: live.bootId, months: Object.fromEntries(months.filter(m => object(live.months[m])).map(m =>
    [m, { lastSeq: live.months[m].lastSeq, failed: live.months[m].failed }])),
    inFlight: Object.fromEntries(Object.entries(live.inFlight).filter(([, f]) => object(f) && count(f.startedAt)).map(([id, f]) => [id, { startedAt: f.startedAt }])) };
  result.complete = complete && result.unreadableLines === 0;
  return result;
}
export function registerUsage(api) {
  const dir = process.env.BYOKIT_ENGINE_USAGE_LEDGER, bootId = process.env.BYOKIT_ENGINE_BOOT;
  if (dir && bootId) {
    const live = globalThis[USAGE_SYMBOL] ??= { bootId, months: {}, inFlight: {} };
    let clean = false;
    api.on('gateway_stop', () => { clean = true; });
    // Snapshot at process exit: no async review can append after these counters. SIGKILL cannot forge a clean stop.
    process.once('exit', code => {
      if (!clean || code !== 0 || Object.keys(live.inFlight).length) return;
      let fd;
      try {
        fd = openSync(join(dir, 'boots.jsonl'), 'a', 0o600);
        const line = Buffer.from(JSON.stringify({ bootId, stoppedAt: Date.now(), months: live.months }) + '\n');
        if (writeSync(fd, line) !== line.length) return;
        fsyncSync(fd);
      } catch { /* No stop proof: permanently incomplete, never fail a review or shutdown. */ }
      finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* no further writes at exit */ } } }
    });
  }
  api.registerGatewayMethod('byokit.usage.engineStarted', ({ params, respond }) => {
    try { respond(true, readEngineStarted(process.env.BYOKIT_ENGINE_USAGE_LEDGER, globalThis[USAGE_SYMBOL], params)); }
    catch { respond(false, undefined, { code: 'INVALID_REQUEST', message: 'Invalid usage window' }); }
  }, { scope: 'operator.read' });
}
