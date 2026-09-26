// Ambient types for the app-provided react-native-zeroconf peer (optional, never installed in this repo's
// workspace). Only the surface the browse API uses; keep in step with `ZeroconfLike` in browse.ts.
declare module 'react-native-zeroconf' {
  export default class Zeroconf {
    scan(type?: string, protocol?: string, domain?: string): void;
    stop(): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    removeListener(event: string, listener: (...args: unknown[]) => void): void;
    removeDeviceListeners(): void;
  }
}
