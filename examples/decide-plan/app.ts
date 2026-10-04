import { cases, handback, plans, types, type Plan } from './questions.ts';
import type { Result } from './server.ts';
import type { SignIn, Status } from '../../packages/accounts/src/portable.ts';

type State = { plans: Record<Plan, Status & { signIn: SignIn | null }>; results: Result[]; medianMs: number | null; busy: boolean };
const $ = (id: string) => document.getElementById(id)!;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; };
let selected: Plan = 'chatgpt';
let state: State | undefined;
let running = false;
let current: Result | undefined;
const handoffs = new Map<string, string>();
const button = (text: string, action: () => void, className = '') => { const b = node('button', text, className); b.type = 'button'; b.onclick = action; return b; };
async function post(path: string, fields: object = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: selected, ...fields }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}
function showError(error: unknown) { $('error').textContent = error instanceof Error ? error.message : 'Try again.'; }
async function refresh() {
  try { const response = await fetch('/state'); if (!response.ok) throw new Error('The app is unavailable. Reopen it on this computer.'); state = await response.json(); renderPlans(); renderSummary(); renderMessages(); } catch (error) { showError(error); }
}
function renderPlans() {
  if (!state) return;
  $('plans').replaceChildren();
  for (const provider of Object.keys(plans) as Plan[]) {
    const plan = state.plans[provider];
    const card = node('div', '', 'plan');
    const label = node('label'); const radio = node('input'); radio.type = 'radio'; radio.name = 'plan'; radio.checked = selected === provider; radio.disabled = running;
    radio.onchange = () => { selected = provider; current = undefined; $('current').replaceChildren(node('h2', 'Choose a message'), node('p', 'Your answer will use this plan.')); renderPlans(); renderMessages(); };
    label.append(radio, plans[provider].billing); card.append(label, node('p', plan.state === 'ready' ? `Connected as Umer in this app` : plan.words));
    const flow = plan.signIn;
    if (flow?.state === 'waiting') {
      if (flow.code) { card.append(node('strong', flow.code, 'code')); card.append(button('Copy code', () => { void navigator.clipboard.writeText(flow.code!).catch(showError); })); }
      if (flow.url) { const link = node('a', `Open ${plans[provider].name}`, 'primary'); link.href = flow.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link); }
      if (provider === 'claude') {
        card.append(node('p', 'After signing in, paste the code from Claude here.'));
        const input = node('input'); input.type = 'text'; input.autocomplete = 'off'; input.setAttribute('aria-label', 'Code from Claude');
        const paste = button('Finish sign-in', () => { const code = input.value; input.value = ''; void post('/paste', { provider, code }).then(refresh).catch(showError); }, 'primary');
        // Keep the paste field stable while polling.
        input.value = pasteDraft; input.oninput = () => { pasteDraft = input.value; };
        card.append(input, paste);
      }
      if (flow.expiresAt) card.append(node('p', `Code expires at ${new Date(flow.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`));
      card.append(button('Cancel', () => { void post('/cancel', { provider }).then(refresh).catch(showError); }, 'secondary'));
    } else if (plan.state !== 'ready') card.append(button(`Sign in with ${plans[provider].name}`, () => { void post('/login', { provider }).then(refresh).catch(showError); }));
    $('plans').append(card);
  }
  $('billing').replaceChildren(node('span', plans[selected].billing, 'billing'));
}
let pasteDraft = '';
function renderMessages() {
  $('messages').replaceChildren();
  for (const item of cases) { const b = button(item.title, () => { void run(item.id); }, current?.caseId === item.id ? 'selected' : ''); b.disabled = running || state?.plans[selected].state !== 'ready'; $('messages').append(b); }
  ($('run-all') as HTMLButtonElement).disabled = running || state?.plans[selected].state !== 'ready';
}
function renderResult(row: Result) {
  current = row;
  const target = $('current'); target.replaceChildren(node('h2', row.title), node('blockquote', row.text));
  target.append(node('div', row.outcome === 'unavailable' ? 'The plan could not answer' : row.answerLabel, 'answer-label'));
  const type = types[row.question.kind];
  target.append(node('p', row.abstained ? 'No automatic answer was used.' : `${type}: ${String(row.answer)}`, 'typed'));
  const metrics = node('div', '', 'metrics');
  for (const [value, description] of [[row.confidence === null ? '—' : `${Math.round(row.confidence * 100)}%`, row.confidence === null ? 'No confidence estimate' : 'Self-reported confidence'], [`${Math.round(row.floor * 100)}%`, 'Required confidence'], [`${(row.latencyMs / 1000).toFixed(2)} s`, 'Time to answer']]) {
    const metric = node('div', '', 'metric'); metric.append(node('strong', value), node('span', description)); metrics.append(metric);
  }
  target.append(metrics);
  if (row.rationale) target.append(node('p', row.rationale, 'explanation'));
  if (row.abstained) {
    const handoff = node('div', '', 'handoff'); handoff.append(node('h3', row.ask));
    const key = `${row.provider}:${row.caseId}`;
    const answers = handback(row.question);
    const received = node('p', handoffs.has(key) ? `Your answer: ${handoffs.get(key)}. You made this decision.` : row.outcome === 'unavailable' ? 'Your plan could not answer. You can answer instead.' : 'Your plan was unsure. You can answer instead.');
    for (const answer of answers) handoff.append(button(answer, () => { handoffs.set(key, answer); received.textContent = `Your answer: ${answer}. You made this decision.`; }));
    handoff.append(received); target.append(handoff);
  }
  renderMessages();
}
function renderSummary() {
  if (!state) return;
  const rows = state.results.filter(row => row.provider === selected);
  const latencies = rows.map(row => row.latencyMs).sort((a,b) => a-b);
  const middle = Math.floor(latencies.length / 2);
  const ms = latencies.length ? latencies.length % 2 ? latencies[middle] : (latencies[middle-1] + latencies[middle])/2 : null;
  $('summary').textContent = rows.length ? `${rows.length} live calls on ${plans[selected].billing.toLowerCase()}. Median time: ${(ms! / 1000).toFixed(2)} s.` : '';
  $('history').replaceChildren();
  for (const row of [...rows].reverse()) $('history').append(button(`${row.title}: ${row.answerLabel}`, () => renderResult(row)));
}
async function run(caseId: string) {
  if (running) return;
  running = true; $('error').textContent = ''; renderMessages(); renderPlans();
  $('current').replaceChildren(node('h2', 'Asking your plan…'), node('p', 'The answer will appear here.'));
  try { const row: Result = await post('/decide', { caseId }); renderResult(row); } catch(error) { showError(error); }
  finally { running = false; await refresh(); }
}
$('run-all').onclick = async () => { for (const item of cases) { await run(item.id); if ($('error').textContent) break; } };
await refresh();
// Pause DOM replacement while typing the paste code or using a control.
setInterval(() => { if (!running && !document.querySelector('#plans :focus')) void refresh(); }, 2500);
