// A bot's own extension: it offers a tool only this bot has, records the environment and argv Pi really got, and opens a
// dialog nobody is there to answer, which must not stop the run.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Pi = {
  registerTool(tool: object): void;
  on(event: 'before_agent_start', handler: (event: unknown, ctx: { ui: { confirm(title: string, message: string): Promise<boolean> } }) => Promise<void>): void;
};

export default function extension(pi: Pi) {
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, 'seen-env.json'), JSON.stringify(process.env));
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, 'seen-argv.json'), JSON.stringify(process.argv));
  pi.registerTool({ name: 'only_this_bot', label: 'Only this bot', description: 'A tool one bot has.', parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'done' }], details: {} }) });
  pi.on('before_agent_start', async (_event, ctx) => { await ctx.ui.confirm('Anyone there?', 'Nobody can answer this.'); });
}
