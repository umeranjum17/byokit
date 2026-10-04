import { demoView, providers, tokenText, before } from '../usage-demo.ts';
import { planLabel } from '@byokit/usage/view';
import type { Provider } from '@byokit/usage';
const nav = document.querySelector('nav')!;
const root = document.querySelector('#view')!;
function show(provider: Provider) {
  for (const button of Array.from(nav.querySelectorAll('button'))) button.setAttribute('aria-selected', String(button.dataset.provider === provider));
  root.replaceChildren();
  const append = (tag: string, text: string, className = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; root.append(node); return node;
  };
  if (new URLSearchParams(location.search).has('before')) {
    const old = before(); append('h2', old.label); append('p', old.room, 'room');
    append('section', `Today: ${old.today}`); append('section', old.activity); append('h3', 'Who used this plan'); append('p', old.people);
    append('p', 'Before: reproduced independent selectors on the sample ledger.', 'note'); return;
  }
  const view = demoView(provider);
  append('h2', view.label); append('p', view.roomText, 'room'); append('p', view.quotaText, 'note');
  if ('resetsAt' in view.room && view.room.resetsAt) append('p', 'Refills October 2 · weekly allowance', 'muted');
  const row = (label: string, value: string) => {
    const node = append('section', '', 'row'); const name = document.createElement('span'); name.textContent = label;
    const count = document.createElement('span'); count.textContent = value; count.className = 'number'; node.append(name, count);
  };
  row('Today · recorded', tokenText(view.today));
  append('h3', 'Activity'); append('p', view.activity.text, 'muted'); row('30 days · recorded', tokenText(view.activity));
  append('h3', 'Who used this plan · 30 days');
  for (const person of view.people) row(person.member === 'umer' ? 'Umer' : 'Another person', tokenText(person));
  append('h3', 'Models · recorded');
  for (const model of view.models) row(model.label, tokenText(model));
}
for (const provider of providers) {
  const button = document.createElement('button'); button.textContent = planLabel(provider); button.dataset.provider = provider;
  button.onclick = () => show(provider); nav.append(button);
}
show('codex');
