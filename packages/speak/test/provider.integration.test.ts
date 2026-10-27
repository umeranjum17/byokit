import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProviderSpeech, openAICompatibleSpeech } from '../src/index.ts';

test('provider speech connects, lists, persists and speaks only the explicitly selected voice', async () => {
  const requests: { path: string; body: string }[] = [];
  let authorizationMatches = true;
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      authorizationMatches &&= req.headers.authorization === 'Bearer synthetic-provider-key';
      requests.push({ path: req.url ?? '', body });
      if (req.url === '/v1/audio/voices') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'voice-a', name: 'Voice A', language: 'en-US' }] }));
      } else if (req.url === '/v1/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.end(Buffer.from([1, 2, 3]));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    let saved: { provider: string; voice: string } | null = null;
    const speech = createProviderSpeech([openAICompatibleSpeech()], {
      load: async () => saved,
      save: async (choice) => { saved = choice; },
    });
    await assert.rejects(speech.speak('hello'), /choose a provider and voice first/);
    await speech.connect('openai-compatible', {
      apiKey: 'synthetic-provider-key', baseUrl: `http://127.0.0.1:${address.port}`, model: 'test-tts',
    });
    assert.deepEqual(await speech.voices('openai-compatible'), [{ id: 'voice-a', name: 'Voice A', lang: 'en-US' }]);
    await speech.select({ provider: 'openai-compatible', voice: 'voice-a' });
    assert.deepEqual(await speech.choice(), { provider: 'openai-compatible', voice: 'voice-a' });
    assert.deepEqual([...await speech.speak('Hi Umer')], [1, 2, 3]);
    assert.deepEqual(requests.map(({ path }) => path), ['/v1/audio/voices', '/v1/audio/voices', '/v1/audio/speech']);
    assert.equal(authorizationMatches, true);
    assert.deepEqual(JSON.parse(requests[2].body), {
      model: 'test-tts', input: 'Hi Umer', voice: 'voice-a', response_format: 'mp3',
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
