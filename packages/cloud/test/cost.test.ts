// M1 acceptance: the four 10.2 always-on figures via estimate, the plan-floor case, a stale
// checked appending cost.checked, and a projected usage cost with a floor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balanceCost, enteredCost, estimate, usageCost } from '../src/cost.ts';
import type { Price, Usage } from '../src/types.ts';

// Dated today so the rows never go stale under the 90-day checked rule.
const CHECKED = new Date().toISOString().slice(0, 10);

const sandboxSmall: Price = {
  size: 'small', perHour: 0.018, planFloorPerMonth: 20, asleepPerHour: 0,
  currency: 'USD', basis: 'incl. IPv4, excl. VAT', source: 'http://sandbox.test/prices', checked: CHECKED,
};
const sandboxDefault: Price = {
  size: 'default', perHour: 0.036, planFloorPerMonth: 20, asleepPerHour: 0,
  currency: 'USD', basis: 'incl. IPv4, excl. VAT', source: 'http://sandbox.test/prices', checked: CHECKED,
};
const budgetVm: Price = {
  size: 'vm-small', perMonthCap: 5.99, asleepPerHour: 5.99 / 730,
  currency: 'EUR', basis: 'list', source: 'http://sandbox.test/prices', checked: CHECKED,
};
const mainstreamVm: Price = {
  size: 'vm-main', perMonthCap: 24, asleepPerHour: 24 / 730,
  currency: 'USD', basis: 'list', source: 'http://sandbox.test/prices', checked: CHECKED,
};

test('the four 10.2 always-on figures via estimate', () => {
  const a = estimate(sandboxSmall, { label: 'L' });
  assert.deepEqual([a.perMonth, a.floor, a.currency, a.basis], [20, 20, 'USD', 'list']);
  const b = estimate(sandboxDefault, { label: 'L' });
  assert.ok(Math.abs(b.perMonth - 26.28) < 1e-9, `${b.perMonth}`);
  assert.deepEqual([b.floor, b.currency, b.basis], [20, 'USD', 'list']);
  const c = estimate(budgetVm, { label: 'L' });
  assert.deepEqual([c.perMonth, c.floor, c.currency, c.basis], [5.99, null, 'EUR', 'list']);
  const d = estimate(mainstreamVm, { label: 'L' });
  assert.deepEqual([d.perMonth, d.floor, d.currency, d.basis], [24, null, 'USD', 'list']);
  assert.equal(a.words, 'About $20.00 a month, billed by L to your own account. {app} doesn\'t charge for this.');
  assert.equal(c.words, '€5.99 a month, the price you told us L charges you.');
});

test('the plan floor holds when the machine sleeps', () => {
  // Asleep 16 h a day: 8 h a day of time is $4.32, still the $20 floor.
  const a = estimate(sandboxSmall, { label: 'L', hoursOn: 240 });
  assert.deepEqual([a.perMonth, a.floor], [20, 20]);
  const b = estimate(sandboxDefault, { label: 'L', hoursOn: 240 });
  assert.deepEqual([b.perMonth, b.floor], [20, 20]);
});

test('a stale checked appends cost.checked', () => {
  const stale: Price = { ...sandboxSmall, checked: '2020-01-01' };
  const c = estimate(stale, { label: 'L' });
  assert.ok(c.words.endsWith(' Price last checked 2020-01-01.'), c.words);
  const fresh = estimate(sandboxSmall, { label: 'L' });
  assert.doesNotMatch(fresh.words, /Price last checked/);
});

test('a projected usage cost with a floor', () => {
  const u: Usage = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-05T04:00:00.000Z', hours: 100, amount: 1, currency: 'USD' };
  const c = usageCost(u, [sandboxSmall], { label: 'L', today: '2026-09-05' });
  // $1 over 100 h projects to $7.30, raised to the $20 floor.
  assert.deepEqual([c.perMonth, c.floor, c.currency, c.basis, c.checked], [20, 20, 'USD', 'usage', '2026-09-05']);
  assert.ok(c.words.includes('L') && c.words.includes('$20.00'), c.words);
  const over: Usage = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z', hours: 24, amount: 1, currency: 'USD' };
  const d = usageCost(over, [sandboxSmall], { label: 'L', today: '2026-09-02' });
  assert.ok(Math.abs(d.perMonth - (1 / 24) * 730) < 1e-9, `${d.perMonth}`);
});

test('balance and entered costs', () => {
  const b = balanceCost([sandboxSmall], { label: 'L', today: '2026-09-05' });
  assert.deepEqual([b.perMonth, b.floor, b.basis, b.checked], [20, 20, 'usage', '2026-09-05']);
  assert.equal(b.words, 'Your L balance ran out. Your cloud computer stops in a day unless you add funds.');
  const e = enteredCost(10, [], { label: 'L', today: '2026-09-05' });
  assert.deepEqual([e?.perMonth, e?.basis, e?.currency], [10, 'entered', 'USD']);
  assert.equal(enteredCost(undefined, [], { label: 'L', today: '2026-09-05' }), null);
});
