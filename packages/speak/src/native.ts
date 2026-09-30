// The React Native adapter over the 'ByokitSpeak' native module (Android TextToSpeech, iOS
// AVSpeechSynthesizer): one native listener routed to utterances by id. Pure except for the injected module.
import type { NativeSpeak, NativeSpeakEvent, Voice } from './types.ts';
import type { SpeakEngine } from './speak.ts';

export function nativeEngine(native: NativeSpeak): SpeakEngine {
  const routes = new Map<number, (type: 'start' | 'end' | 'error', message?: string) => void>();
  let subscribed = false;
  const onNative = (e: NativeSpeakEvent): void => {
    const emit = routes.get(e.id);
    if (!emit) return;
    if (e.type === 'end' || e.type === 'error') routes.delete(e.id);
    emit(e.type, e.message);
  };
  const subscribe = (): void => {
    if (!subscribed) {
      native.addListener('speak', onNative);
      subscribed = true;
    }
  };
  return {
    voices: (): Promise<Voice[]> => native.voices(),
    speak(id, text, o, emit) {
      subscribe();
      routes.set(id, emit);
      try {
        native.speak(id, text, o.voice, o.rate, o.pitch);
      } catch {
        routes.delete(id);
        throw new Error('speak: the native module rejected the utterance');
      }
    },
    cancel(id) {
      routes.delete(id);
      native.cancel(id);
    },
    stopAll() {
      routes.clear();
      native.stopAll();
    },
  };
}
