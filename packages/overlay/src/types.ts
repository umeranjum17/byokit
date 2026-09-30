import type { ScreenSpace } from './screen-frame.ts';

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
  label?: string;                      // TalkBack label for the bubble; absent: none, as before
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
export type PointHereOptions = {
  x: number;                          // ring centre in full-display physical pixels
  y: number;
  label: string;                      // drawn beside the ring and announced for TalkBack
  space?: ScreenSpace;                // pass the captured space to reject stale display geometry
  ms?: number;                        // auto-dismiss; default 2500, range 1–60000
};
export type PointHereResult = 'shown' | 'needs-permission' | 'not-running' | 'display-changed' | 'unsupported';
export interface Overlay {
  state(): Promise<OverlayState>;
  openPermission(): Promise<void>;     // window: the "display over other apps" screen; accessibility: accessibility settings
  start(o: StartOptions): Promise<OverlayState>;
  stop(): Promise<void>;
  pointHere(o: PointHereOptions): Promise<PointHereResult>;
  dismissPoint(): Promise<void>;
  say(text: string, mood?: string, ms?: number, o?: { announce?: boolean }): void;   // pill next to the bubble; ms default 2500; still under reduced motion; announce reads the pill for TalkBack
  setMood(mood: string): void;
  setLabel(label: string | null): void;   // TalkBack label for the bubble; null clears it
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
  pointHere(o: PointHereOptions & { ms: number }): Promise<PointHereResult>;
  dismissPoint(): Promise<void>;
  say(text: string, mood: string | null, ms: number, announce: boolean): void;
  setMood(mood: string): void;
  setLabel(label: string | null): void;
  setRules(rules: AppRules): void;
  openPanel(props: Record<string, string>): Promise<void>;
  closePanel(): Promise<void>;
  logTap(app: string, action: string): Promise<void>;
  taps(since: number): Promise<TapEntry[]>;
  clearTaps(): Promise<void>;
  addListener(event: 'overlay', fn: (e: OverlayEvent) => void): { remove(): void };
}
