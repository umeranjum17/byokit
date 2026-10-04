/** Active default network transports, not peer or reachability evidence. */
export type PhoneNetwork = { onWifi: boolean; cellular: boolean; vpnActive: 'yes' | 'no' | 'unknown' };
export type PhoneNetworkModule = { phoneNetwork(): Promise<PhoneNetwork> };
export type PhoneNetworkOptions = { nativeModule?: PhoneNetworkModule | null };

/** Missing/failed native readers cannot prove a VPN is off. */
export async function phoneNetwork(o: PhoneNetworkOptions = {}): Promise<PhoneNetwork> {
  const unavailable: PhoneNetwork = { onWifi: false, cellular: false, vpnActive: 'unknown' };
  try {
    const value = await o.nativeModule?.phoneNetwork();
    if (!value || typeof value.onWifi !== 'boolean' || typeof value.cellular !== 'boolean') return unavailable;
    return { onWifi: value.onWifi, cellular: value.cellular,
      vpnActive: value.vpnActive === 'yes' || value.vpnActive === 'no' ? value.vpnActive : 'unknown' };
  } catch { return unavailable; }
}
