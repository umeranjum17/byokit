/** Full default-display pixels, including system bars. No dp conversion or image scaling. */
export type ScreenSpace = {
  width: number;
  height: number;
  density: number;
  densityDpi: number;
  rotation: 0 | 1 | 2 | 3;
  displayId: number;
  origin: 'top-left';
  unit: 'physical-pixels';
};
export type ScreenFrameResult =
  | { status: 'captured'; uri: string; mimeType: 'image/png'; width: number; height: number; space: ScreenSpace }
  | { status: 'cancelled' | 'busy' | 'unsupported' }
  | { status: 'failed'; reason: 'timeout' | 'display-changed' | 'capture-failed' };
export interface ScreenFrame {
  /** Asks the platform for consent every time. Only one request can be in flight. */
  frame(): Promise<ScreenFrameResult>;
  /** Deletes the kit's cached still; rejects while a capture is in flight. */
  clear(): Promise<void>;
}
export type NativeScreenFrame = ScreenFrame;

/** Native-free seam for Node/web tests and hosts without this Android module. */
export function createScreenFrame(native: NativeScreenFrame | null): ScreenFrame {
  return native ? {
    frame: () => native.frame(),
    clear: () => native.clear(),
  } : {
    frame: async () => ({ status: 'unsupported' }),
    clear: async () => {},
  };
}
export const screenFrame = createScreenFrame(null);
