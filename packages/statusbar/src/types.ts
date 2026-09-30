// The frozen public surface (docs/capability-kits.md 12.3). Signature changes are spec changes.

export type StatusState = 'on' | 'off' | 'needs-permission' | 'unsupported';
export type StatusAction = { id: string; label: string };   // id /^[a-z][a-z0-9_]{0,31}$/, label non-empty
export type ShowOptions = {
  title: string;          // private, non-empty: promotion needs a content title
  text: string;           // private
  chip: string;           // status-bar chip, at most 7 characters (code points); counts and fixed words only
  publicText: string;     // lock screen and screen share; counts and fixed words only
  promote: boolean;       // ask for the chip; false posts a plain ongoing notification
  actions?: StatusAction[];   // at most 3, unique ids; each needs the phone unlocked
  timeoutMs: number;      // integer ≥ 1000: the notification clears itself this long after the last post
  icon?: string;          // small icon, an app drawable name /^[a-z][a-z0-9_]{0,63}$/; default the app's icon
};
export type StatusEvent = { type: 'action'; id: string } | { type: 'dismissed' };
export type StatusEventType = StatusEvent['type'];
// States (native side, reported by state()):
// - 'unsupported': no native module (iOS, web, Node), or Android below API 36. show() posts nothing there.
// - 'needs-permission': notifications are off for the app, or its channel is blocked.
// - 'off': the person switched promotion off for the app, or set the kit's channel to Minimum. show() still posts,
//   as a plain ongoing notification.
// - 'on': a promote: true post can show as a chip.
export interface Status {
  show(o: ShowOptions): void;          // throws Error('status: <what>') on bad options, before any native call
  clear(): void;                       // the job ended: cancels the notification and forgets a dismissal
  on<T extends StatusEventType>(type: T, fn: (e: Extract<StatusEvent, { type: T }>) => void): () => void;   // listener set
  state(): Promise<StatusState>;
  openSettings(): Promise<void>;       // the promotion setting, else the app's notification settings
}
export interface NativeStatus {        // what the Kotlin module exposes (12.5); internal seam
  show(o: ShowOptions & { channel: string }): void;   // channel: the channel's visible name, from words
  clear(): void;
  state(): Promise<StatusState>;
  openSettings(): Promise<void>;
  addListener(event: 'status', fn: (e: StatusEvent) => void): { remove(): void };
}
