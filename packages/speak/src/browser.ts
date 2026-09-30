// The web engine over the platform's own speechSynthesis: no network, no keys. Pure except for the injected
// synthesiser, so tests pass a fake.
import type { Voice } from './types.ts';
import type { SpeakEngine } from './speak.ts';

export interface BrowserSynthesis {
  speak(u: BrowserUtterance): void;
  cancel(): void;
  getVoices(): { voiceURI: string; name: string; lang: string }[];
}

export interface BrowserUtterance {
  text: string;
  voice: { voiceURI: string; name: string; lang: string } | null;
  rate: number;
  pitch: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((reason: unknown) => void) | null;
}

function describe(reason: unknown): string {
  if (typeof reason === 'string' && reason) return reason;
  const error = (reason as { error?: unknown } | null)?.error;
  if (typeof error === 'string' && error) return error;
  return 'the platform could not speak the text';
}

export function browserEngine(
  synth: BrowserSynthesis,
  makeUtterance: () => BrowserUtterance,
  pickVoice: (voices: { voiceURI: string; name: string; lang: string }[], id: string | null) => { voiceURI: string; name: string; lang: string } | null = (voices, id) =>
    id === null ? null : (voices.find((v) => v.voiceURI === id || v.name === id) ?? null),
): SpeakEngine {
  return {
    voices: async () =>
      synth.getVoices().map((v): Voice => ({ id: v.voiceURI || v.name, name: v.name, lang: v.lang })),
    speak(id, text, o, emit) {
      void id;
      const u = makeUtterance();
      u.text = text;
      u.voice = pickVoice(synth.getVoices(), o.voice);
      u.rate = o.rate;
      u.pitch = o.pitch;
      u.onstart = () => emit('start');
      u.onend = () => emit('end');
      u.onerror = (reason) => emit('error', describe(reason));
      synth.speak(u);
    },
    cancel: () => synth.cancel(),
    stopAll: () => synth.cancel(),
  };
}
