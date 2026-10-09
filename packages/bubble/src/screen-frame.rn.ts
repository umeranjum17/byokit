import { requireOptionalNativeModule } from 'expo-modules-core';
import { createScreenFrame, type NativeScreenFrame } from './screen-frame.ts';
export { createScreenFrame } from './screen-frame.ts';
export type { ScreenSpace, ScreenFrameResult, ScreenFrame, NativeScreenFrame } from './screen-frame.ts';
export const screenFrame = createScreenFrame(requireOptionalNativeModule<NativeScreenFrame>('ByokitScreenFrame'));
