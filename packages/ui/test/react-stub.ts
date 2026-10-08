// Minimal stand-in for the 'react' module, aliased in place of the real one by useSignIn.test.ts so hook unit
// tests can mount one hook synchronously: just enough useState/useEffect for a single renderHook() at a time.
type Setter<S> = (v: S | ((prev: S) => S)) => void;
type Effect = { fn: () => void | (() => void); deps: unknown[] | undefined; cleanup: unknown; prev: unknown[] | undefined };

type Ctx = { fn: () => unknown; result: unknown; states: unknown[]; effects: Effect[]; si: number; ei: number };
let ctx: Ctx | undefined;

const same = (a: unknown[] | undefined, b: unknown[] | undefined): boolean =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function flush(): void {
  if (!ctx) return;
  for (const e of ctx.effects) {
    if (e.prev === undefined || !same(e.prev, e.deps)) {
      // Commit first: a setState inside fn re-renders, and this effect must not refire on that inner pass.
      e.prev = e.deps;
      if (typeof e.cleanup === 'function') (e.cleanup as () => void)();
      e.cleanup = e.fn();
    }
  }
}

function rerender(): void {
  if (!ctx) return;
  ctx.si = 0;
  ctx.ei = 0;
  ctx.result = ctx.fn();
  flush();
}

export function useState<S>(init: S | (() => S)): [S, Setter<S>] {
  if (!ctx) throw new Error('useState called outside renderHook()');
  const c = ctx;
  const i = c.si++;
  if (i >= c.states.length) c.states.push(typeof init === 'function' ? (init as () => S)() : init);
  const set: Setter<S> = (v) => {
    const prev = c.states[i] as S;
    c.states[i] = typeof v === 'function' ? (v as (prev: S) => S)(prev) : v;
    rerender();
  };
  return [c.states[i] as S, set];
}

export function useEffect(fn: () => void | (() => void), deps?: unknown[]): void {
  if (!ctx) throw new Error('useEffect called outside renderHook()');
  const i = ctx.ei++;
  if (i >= ctx.effects.length) ctx.effects.push({ fn, deps, cleanup: undefined, prev: undefined });
  else {
    ctx.effects[i].fn = fn;
    ctx.effects[i].deps = deps;
  }
}

/** Mount `fn` as a hook: effects flush synchronously, setState re-renders synchronously. */
export function renderHook<T>(fn: () => T): { result: () => T; unmount: () => void } {
  ctx = { fn: fn as () => unknown, result: undefined, states: [], effects: [], si: 0, ei: 0 };
  rerender();
  const c = ctx;
  return {
    result: () => c.result as T,
    unmount: () => {
      for (const e of c.effects) if (typeof e.cleanup === 'function') (e.cleanup as () => void)();
      if (ctx === c) ctx = undefined;
    },
  };
}
