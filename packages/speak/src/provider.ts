import type { Voice } from './types.ts';

export type SpeechCredentials = { apiKey: string; baseUrl: string; model: string };
export type SpeechProvider = {
  readonly id: string;
  connect(credentials: SpeechCredentials): Promise<void>;
  listVoices(): Promise<Voice[]>;
  speak(text: string, voiceId: string): Promise<Uint8Array>;
};
export type SpeechChoice = { provider: string; voice: string };
export type SpeechChoiceStore = {
  load(): Promise<SpeechChoice | null>;
  save(choice: SpeechChoice): Promise<void>;
};

/** Explicitly selected provider voice; the host owns secure credential storage and playback. */
export function createProviderSpeech(providers: SpeechProvider[], store: SpeechChoiceStore) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  let connected = new Set<string>();
  return {
    async connect(providerId: string, credentials: SpeechCredentials): Promise<void> {
      const provider = byId.get(providerId);
      if (!provider) throw new Error(`speak: unknown provider "${providerId}"`);
      await provider.connect(credentials);
      connected.add(providerId);
    },
    async voices(providerId: string): Promise<Voice[]> {
      const provider = byId.get(providerId);
      if (!provider) throw new Error(`speak: unknown provider "${providerId}"`);
      if (!connected.has(providerId)) throw new Error('speak: connect the provider before listing voices');
      return provider.listVoices();
    },
    async select(choice: SpeechChoice): Promise<void> {
      const provider = byId.get(choice.provider);
      if (!provider) throw new Error(`speak: unknown provider "${choice.provider}"`);
      if (!connected.has(choice.provider)) throw new Error('speak: connect the provider before selecting a voice');
      if (!(await provider.listVoices()).some((voice) => voice.id === choice.voice)) {
        throw new Error('speak: selected voice is not offered by the provider');
      }
      await store.save(choice);
    },
    async choice(): Promise<SpeechChoice | null> {
      const choice = await store.load();
      if (choice && !byId.has(choice.provider)) throw new Error(`speak: saved provider "${choice.provider}" is unavailable`);
      return choice;
    },
    async speak(text: string): Promise<Uint8Array> {
      if (typeof text !== 'string' || !text.trim()) throw new TypeError('speak: text must not be empty');
      const choice = await store.load();
      if (!choice) throw new Error('speak: choose a provider and voice first');
      const provider = byId.get(choice.provider);
      if (!provider) throw new Error(`speak: saved provider "${choice.provider}" is unavailable`);
      if (!connected.has(choice.provider)) throw new Error('speak: connect the selected provider first');
      return provider.speak(text, choice.voice);
    },
  };
}
