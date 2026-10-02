// Task-owned child of cloud-node.ts; no ambient account discovery, stdout or credential files written.
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { CloudAccount } from './cloud.ts';
import type { Api, ApiStreamOptions, Model, TranscriptContext } from '@earendil-works/pi-ai';

let next = 0;
const replies = new Map<number, (value: unknown) => void>();
const callback = (name: string, value: unknown) => new Promise<unknown>((resolve) => {
  const id = ++next;
  replies.set(id, resolve);
  process.send?.({ callback: name, id, value });
});
process.on('message', async (m: any) => {
  if (m.reply) { replies.get(m.reply)?.(m.value); replies.delete(m.reply); return; }
  try {
    const a = m.account as CloudAccount;
    const model = m.model as Model<Api>;
    const p = builtinProviders().find((p) => p.id === a.upstream);
    if (!p || model.provider !== p.id) throw new Error();
    const options: ApiStreamOptions<Api> = { ...m.options,
      ...(m.payload ? { onPayload: (payload: unknown) => callback('payload', payload) } : {}),
      ...(m.response ? { onResponse: async (response: unknown) => { await callback('response', response); } } : {}),
    };
    for await (const event of p.stream(model, m.context as TranscriptContext, options)) {
      // Upstream exceptions may echo settings/credentials. Only the parent emits safe error words.
      if (event.type === 'error') process.send?.({ failed: true, aborted: event.reason === 'aborted' });
      else process.send?.({ event });
    }
  } catch { process.send?.({ failed: true }); }
});
