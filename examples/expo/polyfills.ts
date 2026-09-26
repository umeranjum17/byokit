// @byokit/link and @byokit/seal need crypto.getRandomValues, which React Native doesn't have; expo-crypto supplies it.
// Its own module, imported first, so it is in place before anything else loads.
import { getRandomValues } from 'expo-crypto';

(globalThis as any).crypto ??= {};
(globalThis as any).crypto.getRandomValues ??= getRandomValues;
