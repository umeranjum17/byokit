// The frozen public surface (docs/capability-kits.md 7.3). Signature changes are spec changes.

export type OverlayState = 'on' | 'off' | 'stuck' | 'needs-permission' | 'unsupported';
export type HostKind = 'window' | 'accessibility';
export type Edge = 'left' | 'right';
export type AppRules = { paused: boolean; on: string[]; off: string[]; defaults: string[] };   // Android package names
export type ForegroundNotice = { channel: string; title: string; text: string; icon: string }; // icon: app drawable name
export type StartOptions = {
  host: HostKind;
  mood: string;                        // resting drawable name, /^[a-z][a-z0-9_]{0,63}$/, app-supplied
  notice?: ForegroundNotice;           // required for host 'window' (the foreground service's notification)
  rules?: AppRules;                    // host 'accessibility' only (needs the foreground app); 'window' + rules rejects
  panel?: string;                      // registered React component opened on tap; absent: tap only emits
  hideWhilePanelOpen?: boolean;        // default true
  spots?: 'global' | 'per-app';        // remembered rest spot; 'per-app' needs host 'accessibility'; default 'global'
};
export type OverlayEvent =
  | { type: 'tap' }
  | { type: 'longPress' }
  | { type: 'moved'; edge: Edge; y: number }        // y: 0–1 of the usable height
  | { type: 'state'; state: OverlayState }
  | { type: 'panel'; open: boolean };
export type OverlayEventType = OverlayEvent['type'];
// State transitions (native side, reported by state() and the `state` event):
// - 'off' before the first start() and after stop().
// - start() with host 'window' and no SYSTEM_ALERT_WINDOW grant, or host 'accessibility' before
//   ByokitAccessibility.attach, resolves 'needs-permission' and shows nothing.
// - A successful start() resolves 'on'.
// - While on, 'stuck' when the bubble's view goes away without stop(): OverlayService destroyed or killed ('window'),
//   or ByokitAccessibility.detach ('accessibility'). start() again is the way back to 'on'.
// - 'unsupported' only from createOverlay(null) (no native module: iOS, web, Node).
export type TapEntry = { app: string; at: number; action: string };   // no text field, by design (D-O)
export interface Overlay {
  state(): Promise<OverlayState>;
  openPermission(): Promise<void>;     // window: the "display over other apps" screen; accessibility: accessibility settings
  start(o: StartOptions): Promise<OverlayState>;
  stop(): Promise<void>;
  say(text: string, mood?: string, ms?: number): void;   // pill next to the bubble; ms default 2500; still under reduced motion
  setMood(mood: string): void;
  setRules(rules: AppRules): void;
  openPanel(props?: Record<string, string>): Promise<void>;
  closePanel(): Promise<void>;
  on<T extends OverlayEventType>(type: T, fn: (e: Extract<OverlayEvent, { type: T }>) => void): () => void;   // listener set
  logTap(entry: { app: string; action: string }): Promise<void>;
  taps(o?: { since?: number }): Promise<TapEntry[]>;
  clearTaps(): Promise<void>;
}
export interface NativeOverlay {                         // what the Kotlin module exposes (7.5); internal seam
  state(): Promise<OverlayState>;
  openPermission(): Promise<void>;
  start(o: StartOptions): Promise<OverlayState>;
  stop(): Promise<void>;
  say(text: string, mood: string | null, ms: number): void;
  setMood(mood: string): void;
  setRules(rules: AppRules): void;
  openPanel(props: Record<string, string>): Promise<void>;
  closePanel(): Promise<void>;
  logTap(app: string, action: string): Promise<void>;
  taps(since: number): Promise<TapEntry[]>;
  clearTaps(): Promise<void>;
  addListener(event: 'overlay', fn: (e: OverlayEvent) => void): { remove(): void };
}
