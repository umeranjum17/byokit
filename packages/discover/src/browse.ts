/** A service seen on the LAN. `txt` keeps only string values. */
export type BrowseService = {
  /** The advertised name, e.g. `devbox`. */
  name: string;
  /** The advertised hostname, e.g. `devbox.local.`; empty when the platform gave none. */
  host: string;
  addresses: string[];
  /** `0` when the platform gave no usable port. */
  port: number;
  txt: Record<string, string>;
};

export type BrowseEvents = {
  /** First time a name resolves. */
  found: BrowseService;
  /** A known name resolved again, with fresh fields. */
  updated: BrowseService;
  /** The service left the network; the payload is its name. */
  lost: string;
  error: Error;
  stopped: { reason: 'preempted' };
};

export type BrowseEventName = keyof BrowseEvents;

export type BrowseOptions = { type: string; protocol?: string; domain?: string };

/** The part of react-native-zeroconf the browse API uses; tests pass a fake. */
export type ZeroconfLike = {
  scan(type?: string, protocol?: string, domain?: string): void;
  stop(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
};

export type BrowseHandle = {
  /** Stops this handle. Idempotent. */
  stop(): void;
  /** Listens for one event; ignored after `stop()`. */
  on<K extends BrowseEventName>(event: K, listener: (payload: BrowseEvents[K]) => void): void;
};

type RawService = { name?: unknown; fullName?: unknown; host?: unknown; addresses?: unknown; port?: unknown; txt?: unknown };
type Active = {
  receive(event: 'resolved' | 'remove' | 'error', value: unknown): void;
  stop(reason?: 'preempted'): void;
  options: Required<BrowseOptions>;
};
type Browser = { active?: Active; ignoreNativeErrorsUntil?: number };
const browsers = new WeakMap<ZeroconfLike, Browser>();

const asString = (v: unknown) => (typeof v === 'string' ? v : undefined);

const txtStrings = (txt: unknown): Record<string, string> =>
  txt !== null && typeof txt === 'object'
    ? Object.fromEntries(Object.entries(txt).filter(([, v]) => typeof v === 'string'))
    : {};

/** Keeps only the fields the platform actually delivered; a resolve without a name is not a service. */
function normalize(raw: RawService): BrowseService | undefined {
  const name = asString(raw.name);
  if (name === undefined) return undefined;
  return {
    name,
    host: asString(raw.host) ?? '',
    addresses: Array.isArray(raw.addresses) ? raw.addresses.filter((a): a is string => typeof a === 'string') : [],
    port: typeof raw.port === 'number' ? raw.port : 0,
    txt: txtStrings(raw.txt),
  };
}

function browser(zc: ZeroconfLike): Browser {
  const existing = browsers.get(zc);
  if (existing) return existing;
  const state: Browser = {};
  browsers.set(zc, state);
  const deliver = (event: 'resolved' | 'remove' | 'error', value: unknown): void => {
    const active = state.active;
    if (!active) return;
    if (event === 'resolved') {
      const fullName = asString((value as RawService | null)?.fullName);
      if (!fullName?.toLowerCase().endsWith(`_${active.options.type}._${active.options.protocol}.`.toLowerCase())) return;
    }
    if (event === 'error' && Date.now() < (state.ignoreNativeErrorsUntil ?? 0)) return;
    active.receive(event, value);
  };
  zc.on('resolved', (value) => deliver('resolved', value));
  zc.on('remove', (value) => deliver('remove', value));
  zc.on('error', (value) => deliver('error', value));
  return state;
}

export function browse(o: BrowseOptions & { zeroconf: ZeroconfLike }): BrowseHandle {
  const { zeroconf: zc } = o;
  const options = { type: o.type, protocol: o.protocol ?? 'tcp', domain: o.domain ?? 'local.' };
  const state = browser(zc);
  let stopped = false;
  const known = new Set<string>();
  const listeners: { [K in BrowseEventName]: Set<(payload: BrowseEvents[K]) => void> } = {
    found: new Set(), updated: new Set(), lost: new Set(), error: new Set(), stopped: new Set(),
  };
  const fire = <K extends BrowseEventName>(event: K, payload: BrowseEvents[K]): void => {
    for (const listener of listeners[event]) (listener as (p: BrowseEvents[K]) => void)(payload);
  };
  const receive = (event: 'resolved' | 'remove' | 'error', raw: unknown): void => {
    if (stopped) return;
    if (event === 'resolved') {
      const service = normalize((typeof raw === 'object' && raw !== null ? raw : {}) as RawService);
      if (!service) return;
      const again = known.has(service.name);
      known.add(service.name);
      fire(again ? 'updated' : 'found', service);
    } else if (event === 'remove') {
      const name = asString(raw);
      if (name === undefined || !known.delete(name)) return;
      fire('lost', name);
    } else {
      const message = raw instanceof Error ? raw.message
        : asString((raw as { message?: unknown } | null)?.message) ?? String(raw);
      fire('error', raw instanceof Error ? raw : new Error(message));
    }
  };
  const active: Active = {
    options,
    receive,
    stop(reason) {
      if (stopped) return;
      stopped = true;
      if (state.active === active) {
        state.active = undefined;
        try { zc.stop(); } catch {}
      }
      if (reason) fire('stopped', { reason });
      for (const set of Object.values(listeners)) set.clear();
      known.clear();
    },
  };
  const preempted = !!state.active;
  while (state.active) state.active.stop('preempted');
  // ponytail: native errors have no scan id; suppress for 1s after preemption, then attribution is best effort.
  if (preempted) state.ignoreNativeErrorsUntil = Date.now() + 1000;
  state.active = active;
  try { zc.scan(options.type, options.protocol, options.domain); }
  catch (cause) { queueMicrotask(() => receive('error', cause)); }
  const on: BrowseHandle['on'] = (event, listener) => {
    if (!stopped) listeners[event].add(listener);
  };
  return { stop: () => active.stop(), on };
}

/**
 * Collect resolved services for `ms` milliseconds, then stop. Later resolves of a known name replace the earlier
 * entry in first-seen order. Rejects on error (and stops) or preemption.
 */
export function scan(o: BrowseOptions & { ms: number; zeroconf: ZeroconfLike }): Promise<BrowseService[]> {
  if (!(o.ms > 0)) return Promise.reject(new Error('ms must be positive'));
  const handle = browse(o);
  const services = new Map<string, BrowseService>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise((resolve, reject) => {
    const collect = (service: BrowseService): void => { services.set(service.name, service); };
    handle.on('found', collect);
    handle.on('updated', collect);
    handle.on('lost', (name) => { services.delete(name); });
    handle.on('error', (error) => { clearTimeout(timer); handle.stop(); reject(error); });
    handle.on('stopped', () => { clearTimeout(timer); reject(new Error('scan preempted')); });
    timer = setTimeout(() => { handle.stop(); resolve([...services.values()]); }, o.ms);
  });
}
