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
  /** Stops this handle; other discovery continues. Idempotent. */
  stop(): void;
  /** Listens for one event; ignored after `stop()`. */
  on<K extends BrowseEventName>(event: K, listener: (payload: BrowseEvents[K]) => void): void;
};

type RawService = { name?: unknown; fullName?: unknown; host?: unknown; addresses?: unknown; port?: unknown; txt?: unknown };
type Session = { key: string; options: Required<BrowseOptions>; handles: Set<(event: 'resolved' | 'remove' | 'error', value: unknown) => void> };
type Browser = { sessions: Session[]; active?: Session; timer?: ReturnType<typeof setInterval> };
const browsers = new WeakMap<ZeroconfLike, Browser>();
const SLICE_MS = 1000;

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
  const state: Browser = { sessions: [] };
  browsers.set(zc, state);
  const deliver = (event: 'resolved' | 'remove' | 'error', value: unknown): void => {
    const active = state.active;
    if (!active) return;
    if (event === 'resolved' && typeof value === 'object' && value !== null) {
      const fullName = asString((value as RawService).fullName);
      if (fullName && !fullName.toLowerCase().endsWith(`._${active.options.type}._${active.options.protocol}.${active.options.domain}`.toLowerCase())) return;
    }
    for (const handle of [...active.handles]) handle(event, value);
  };
  zc.on('resolved', (value) => deliver('resolved', value));
  zc.on('remove', (value) => deliver('remove', value));
  zc.on('error', (value) => deliver('error', value));
  return state;
}

function activate(zc: ZeroconfLike, state: Browser, next?: Session): void {
  if (state.active === next) return;
  if (state.active) zc.stop();
  state.active = next;
  if (!next) return;
  try { zc.scan(next.options.type, next.options.protocol, next.options.domain); }
  catch (cause) { queueMicrotask(() => { for (const handle of [...next.handles]) handle('error', cause); }); }
}

function schedule(zc: ZeroconfLike, state: Browser): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
  if (state.sessions.length < 2) return;
  state.timer = setInterval(() => {
    const index = state.sessions.indexOf(state.active!);
    activate(zc, state, state.sessions[(index + 1) % state.sessions.length]);
  }, SLICE_MS);
}

export function browse(o: BrowseOptions & { zeroconf: ZeroconfLike }): BrowseHandle {
  const { zeroconf: zc } = o;
  const options = { type: o.type, protocol: o.protocol ?? 'tcp', domain: o.domain ?? 'local.' };
  const state = browser(zc);
  const key = JSON.stringify([options.type, options.protocol, options.domain]);
  let session = state.sessions.find((item) => item.key === key);
  const first = !session;
  if (!session) {
    session = { key, options, handles: new Set() };
    state.sessions.push(session);
  }
  let stopped = false;
  const known = new Set<string>();
  const listeners: { [K in BrowseEventName]: Set<(payload: BrowseEvents[K]) => void> } = {
    found: new Set(), updated: new Set(), lost: new Set(), error: new Set(),
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
  session.handles.add(receive);
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    session.handles.delete(receive);
    for (const set of Object.values(listeners)) set.clear();
    if (!session.handles.size) {
      const index = state.sessions.indexOf(session);
      state.sessions.splice(index, 1);
      if (state.active === session) activate(zc, state, state.sessions[index] ?? state.sessions[0]);
      schedule(zc, state);
    }
  };
  const on: BrowseHandle['on'] = (event, listener) => {
    if (!stopped) listeners[event].add(listener);
  };
  if (first) {
    activate(zc, state, session);
    schedule(zc, state);
  }
  return { stop, on };
}

/**
 * Collect resolved services for `ms` milliseconds, then stop. Later resolves of a known name replace the earlier
 * entry in first-seen order. Rejects (and stops) if the scan errors.
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
    handle.on('error', (error) => { clearTimeout(timer); handle.stop(); reject(error); });
    timer = setTimeout(() => { handle.stop(); resolve([...services.values()]); }, o.ms);
  });
}
