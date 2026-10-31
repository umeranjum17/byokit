// Starts the real binary through the kit against the fake upstream, sends one chat request, prints the client's HTTP status.
import { startEndpoint } from '../../../src/index.ts';

const [stateDir, binaryPath] = process.argv.slice(2) as [string, string];
const endpoint = await startEndpoint({ stateDir, binaryPath, port: 18317, retry: 1, baseUrl: 'http://127.0.0.1:18911/v1', models: ['fake-model'], credential: { provider: 'openai', key: 'fixture-upstream-key-1' } });
try {
  const response = await fetch(`${endpoint.url}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${endpoint.clientKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: 'ping' }] }),
  });
  console.log(response.status);
} finally { await endpoint.stop(); }
