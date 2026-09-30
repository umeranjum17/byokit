export { routeOf, probe } from './observe.ts';
import { nativeAddresses as readAddresses, observe as observeWith, type NativeAddressesModule, type NativeAddressesOptions, type ObserveOptions } from './observe.ts';
import { phoneNetwork as readNetwork, type PhoneNetworkModule, type PhoneNetworkOptions } from './phone-network.ts';
export type { PhoneNetwork, PhoneNetworkModule, PhoneNetworkOptions } from './phone-network.ts';
export type { NativeAddress, NativeAddressesModule, NativeAddressesOptions, RouteKind, PriorEvidence, ProbeState, ProbeObservation, ProbeOptions, Observation, ObserveOptions } from './observe.ts';


type NativeReach = NativeAddressesModule & PhoneNetworkModule;
// Load only when called. A bare React Native app can inject its own reader instead of installing Expo modules.
async function nativeReach(): Promise<NativeReach | null> {
  try {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    return requireOptionalNativeModule<NativeReach>('ByokitReach');
  } catch { return null; }
}

/** This phone's native IPv4 interfaces and actual prefixes (Android/iOS); injectable for tests and bare RN. */
export async function nativeAddresses(o: NativeAddressesOptions = {}) {
  return readAddresses({ nativeModule: o.nativeModule === undefined ? await nativeReach() : o.nativeModule });
}
/** Current network transport snapshot; Android reads NetworkCapabilities, iOS cannot prove VPN state. */
export async function phoneNetwork(o: PhoneNetworkOptions = {}) {
  return readNetwork({ nativeModule: o.nativeModule === undefined ? await nativeReach() : o.nativeModule });
}
/** Observe with this phone's native address reader unless the caller supplies a module or snapshot. */
export async function observe(o: ObserveOptions) {
  return observeWith({ ...o, nativeModule: o.nativeModule === undefined && o.addresses === undefined ? await nativeReach() : o.nativeModule });
}
