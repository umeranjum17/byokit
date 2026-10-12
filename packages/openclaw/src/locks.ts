// Per-agent read/write locks (5.15, O14): runs hold shared from `ready` to end so one account's runs may
// overlap; removal, moves and sealing take exclusive so no kit read is in flight. `live` reports a held lock.
type Waiter = { mode: 'shared' | 'exclusive'; grant: () => void };
type Slot = { readers: number; writer: boolean; queue: Waiter[] };

export function createLocks(): {
  shared<T>(agentId: string, work: () => Promise<T>): Promise<T>;
  exclusive<T>(agentIds: string[], work: () => Promise<T>): Promise<T>;
  live(agentId: string): boolean;
} {
  const slots = new Map<string, Slot>();
  const slot = (id: string): Slot => {
    let s = slots.get(id);
    if (!s) { s = { readers: 0, writer: false, queue: [] }; slots.set(id, s); }
    return s;
  };
  // FIFO: an exclusive waiter blocks later shared waiters until the readers ahead of it drain.
  const pump = (s: Slot): void => {
    if (s.writer) return;
    const head = s.queue[0];
    if (!head) return;
    if (head.mode === 'exclusive') {
      if (s.readers === 0) { s.queue.shift(); s.writer = true; head.grant(); }
      return;
    }
    while (s.queue[0]?.mode === 'shared') { const w = s.queue.shift()!; s.readers++; w.grant(); }
  };
  const acquire = (id: string, mode: 'shared' | 'exclusive'): Promise<void> => {
    const s = slot(id);
    if (mode === 'shared' && !s.writer && s.queue.every((w) => w.mode === 'shared')) {
      s.readers++;
      return Promise.resolve();
    }
    if (mode === 'exclusive' && !s.writer && s.readers === 0 && s.queue.length === 0) {
      s.writer = true;
      return Promise.resolve();
    }
    return new Promise<void>((grant) => {
      s.queue.push(mode === 'exclusive' ? { mode, grant: () => { s.writer = true; grant(); } } : { mode, grant });
      pump(s);
    });
  };
  const release = (id: string, mode: 'shared' | 'exclusive'): void => {
    const s = slot(id);
    if (mode === 'shared') s.readers = Math.max(0, s.readers - 1);
    else s.writer = false;
    pump(s);
    if (s.readers === 0 && !s.writer && s.queue.length === 0) slots.delete(id);
  };
  return {
    async shared<T>(agentId: string, work: () => Promise<T>): Promise<T> {
      await acquire(agentId, 'shared');
      try { return await work(); }
      finally { release(agentId, 'shared'); }
    },
    async exclusive<T>(agentIds: string[], work: () => Promise<T>): Promise<T> {
      // Sorted so two exclusive takes over overlapping sets cannot deadlock each other.
      const ids = [...new Set(agentIds)].sort();
      for (const id of ids) await acquire(id, 'exclusive');
      try { return await work(); }
      finally { for (const id of [...ids].reverse()) release(id, 'exclusive'); }
    },
    live(agentId: string): boolean {
      const s = slots.get(agentId);
      return !!s && (s.readers > 0 || s.writer);
    },
  };
}
