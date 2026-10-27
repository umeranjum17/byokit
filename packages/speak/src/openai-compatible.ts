import type { SpeechCredentials, SpeechProvider } from './provider.ts';

/** Reference adapter for compatible /v1/audio/voices and /v1/audio/speech endpoints. */
export function openAICompatibleSpeech(fetcher: typeof fetch = fetch): SpeechProvider {
  let credentials: SpeechCredentials | null = null;
  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    if (!credentials) throw new Error('speak: connect this provider first');
    let response: Response;
    try {
      response = await fetcher(`${credentials.baseUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${credentials.apiKey}`, ...init.headers },
      });
    } catch (cause) {
      throw new Error('speak: could not reach the speech provider', { cause });
    }
    if (!response.ok) throw new Error(`speak: speech provider returned HTTP ${response.status}`);
    return response;
  };
  return {
    id: 'openai-compatible',
    async connect(input) {
      if (!input.apiKey.trim()) throw new Error('speak: API key is required');
      let url: URL;
      try { url = new URL(input.baseUrl); } catch { throw new Error('speak: base URL must be an HTTP(S) URL'); }
      if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        throw new Error('speak: base URL must use HTTPS (HTTP is allowed for localhost)');
      }
      if (!input.model.trim()) throw new Error('speak: model is required');
      credentials = { ...input, baseUrl: url.toString().replace(/\/$/, '') };
    },
    async listVoices() {
      const response = await request('/v1/audio/voices');
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null || !('data' in body) || !Array.isArray(body.data)) {
        throw new Error('speak: provider returned an invalid voice list');
      }
      return body.data.map((row: unknown) => {
        if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string') {
          throw new Error('speak: provider returned an invalid voice list');
        }
        return { id: row.id, name: 'name' in row && typeof row.name === 'string' ? row.name : row.id,
          lang: 'language' in row && typeof row.language === 'string' ? row.language : '' };
      });
    },
    async speak(text, voiceId) {
      if (!text.trim() || !voiceId) throw new Error('speak: text and selected voice are required');
      const response = await request('/v1/audio/speech', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: credentials!.model, input: text, voice: voiceId, response_format: 'mp3' }),
      });
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
