// The built package on a phone, over scripted protocol replies. No writing-engine implementation is bundled.
import { Compose, ComposeError, checkLines, type Engine, type EngineRequest, type EngineVerbs } from '@byokit/write';

export async function portableFixture() {
  const rules = { never: ['delve'], noDashes: false, statementEndings: false, note: '' };
  const replies: { [V in keyof EngineVerbs]: EngineVerbs[V]['result'] } = {
    hello: { protocol: 1, version: '0.0.0-fixture' },
    'voice.parse': { rules, skipped: 0 },
    'voice.guide': { line: 'No em dashes.' },
    platforms: [{ id: 'x', label: 'X', kind: 'feed', limit: 280 }],
    brief: { lines: ['One post for X.'] },
    check: [{ fits: true, length: 22, limit: 280, voice: ['says “delve” from your never-say list'],
      stock: [], added: ['42'], dropped: ['41'], layoutKept: true, words: 'Sounds natural' }],
    split: { posts: ['1/1 Hello there.'] },
  };
  const requests: EngineRequest[] = [];
  const engine: Engine = { handle: async request => {
    requests.push(JSON.parse(JSON.stringify(request)) as EngineRequest);
    return JSON.parse(JSON.stringify(replies[request.verb])) as unknown;
  } };
  const writer = new Compose({ engine });
  const hello = await writer.hello();
  const parsed = await writer.voice.parse('## Never say\n- delve\n');
  const guide = await writer.voice.guide({ ...parsed.rules, noDashes: true });
  const platforms = await writer.platforms();
  const lines = await writer.brief({ kind: 'post', platform: 'x', rules: parsed.rules });
  const [checked] = await writer.check({ drafts: ['We delve into 42 tasks.'], platform: 'x', rules: parsed.rules,
    original: 'We had 41 tasks.' });
  const posts = await writer.split({ text: 'Hello there.', platform: 'x' });
  let invalid = '';
  try { await writer.check({ drafts: [], platform: 'x' }); }
  catch (e) { if (e instanceof ComposeError) invalid = e.code; else throw e; }
  return { hello, guide, platforms: platforms.length, lines, checked, posts, invalid,
    checkLines: checkLines(checked!, platforms[0]!, { original: true }), requests, verbs: requests.map(r => r.verb) };
}

