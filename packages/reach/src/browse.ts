// mDNS browse for React Native phones: start and stop discovery of `_<type>._<protocol>` services, with each
// service's addresses, port and TXT records, and an error lifecycle. The native side comes from the app's
// react-native-zeroconf (optional peer dependency): `rn.ts` is the entry that constructs it, and tests pass a
// fake as `zeroconf`, so nothing here imports the native module.

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
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  removeDeviceListeners(): void;
};

export type BrowseHandle = {
  /** Stops discovery and detaches every listener. Idempotent. */
  stop(): void;
  /** Listens for one event; ignored after `stop()`. */
  on<K extends BrowseEventName>(event: K, listener: (payload: BrowseEvents[K]) => void): void;
};

type RawService = { name?: unknown; host?: unknown; addresses?: unknown; port?: unknown; txt?: unknown };

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

/**
 * Start discovering `_<type>._<protocol>` services, e.g. `browse({ type: 'muxr' })`. Most apps import this from
 * `@byokit/reach` under React Native, which supplies the native module; pass `zeroconf` to supply your own.
 */
export function browse(o: BrowseOptions & { zeroconf: ZeroconfLike }): BrowseHandle {
  const { type, protocol = 'tcp', domain = 'local.', zeroconf: zc } = o;
  let stopped = false;
  const known = new Set<string>();
  const listeners: { [K in BrowseEventName]: Set<(payload: BrowseEvents[K]) => void> } = {
    found: new Set(), updated: new Set(), lost: new Set(), error: new Set(),
  };
  const fire = <K extends BrowseEventName>(event: K, payload: BrowseEvents[K]): void => {
    for (const listener of listeners[event]) (listener as (p: BrowseEvents[K]) => void)(payload);
  };
  const onResolved = (raw: unknown): void => {
    const service = normalize((typeof raw === 'object' && raw !== null ? raw : {}) as RawService);
    if (stopped || service === undefined) return;
    const again = known.has(service.name);
    known.add(service.name);
    fire(again ? 'updated' : 'found', service);
  };
  const onRemoved = (raw: unknown): void => {
    const name = asString(raw);
    if (stopped || name === undefined) return;
    known.delete(name);
    fire('lost', name);
  };
  const onError = (cause: unknown): void => {
    if (stopped) return;
    const message = cause instanceof Error ? cause.message
      : asString((cause as { message?: unknown } | null)?.message) ?? String(cause);
    fire('error', cause instanceof Error ? cause : new Error(message));
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const [event, listener] of [['resolved', onResolved], ['remove', onRemoved], ['error', onError]] as const) {
      try { zc.removeListener(event, listener); } catch { /* teardown is best effort */ }
    }
    try { zc.stop(); } catch { /* teardown is best effort */ }
    try { zc.removeDeviceListeners(); } catch { /* teardown is best effort */ }
    for (const set of Object.values(listeners)) set.clear();
  };
  const on: BrowseHandle['on'] = (event, listener) => {
    if (!stopped) listeners[event].add(listener);
  };
  zc.on('resolved', onResolved);
  zc.on('remove', onRemoved);
  zc.on('error', onError);
  try { zc.scan(type, protocol, domain); }
  // Deferred so listeners attached right after browse() still see a scan that failed to start.
  catch (cause) { queueMicrotask(() => onError(cause)); }
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
