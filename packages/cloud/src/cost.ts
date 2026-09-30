// Cost rules (docs/cloud-kit.md 10.1), pure. Every cost sentence says the amount is the
// person's own bill from `{label}`, not from the app; `{app}` stays visible for the app to fill.
import { words } from './words.ts';
import { MachineError } from './errors.ts';
import type { Cost, Price, Usage } from './types.ts';

const HOURS_PER_MONTH = 730;

/** `new Intl.NumberFormat('en', { style: 'currency', currency }).format(perMonth)`. */
export function formatAmount(perMonth: number, currency: 'USD' | 'EUR'): string {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(perMonth);
}

/** YYYY-MM-DD of a Date (UTC). */
export function dateOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The first instant of the current UTC month, for `usage(ref, since)`. */
export function monthStartIso(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
}

const sandboxWords = (amount: string, label: string): string =>
  words('cost.sandbox', { amount, label });
const vmWords = (amount: string, label: string): string =>
  words('cost.vm', { amount, label });

/**
 * Append `cost.checked` when `checked` is more than 90 days before `today`
 * (one space between).
 */
export function withCheckedNote(c: Cost, today: string): Cost {
  if (Date.parse(today) - Date.parse(`${c.checked}T00:00:00.000Z`) <= 90 * 86_400_000) return c;
  return { ...c, words: `${c.words} ${words('cost.checked', { date: c.checked })}` };
}

/**
 * `estimate(p, { label, hoursOn })` for screens before a machine exists (10.1).
 * `hoursOn` defaults to 730.
 */
export function estimate(p: Price, o: { label: string; hoursOn?: number }): Cost {
  const hoursOn = o.hoursOn ?? HOURS_PER_MONTH;
  if (p.perHour !== undefined) {
    const capped = Math.min(p.perMonthCap ?? Infinity, p.perHour * hoursOn + p.asleepPerHour * (HOURS_PER_MONTH - hoursOn));
    const perMonth = Math.max(p.planFloorPerMonth ?? 0, capped);
    return withCheckedNote({
      perMonth,
      floor: p.planFloorPerMonth ?? null,
      currency: p.currency,
      basis: 'list',
      checked: p.checked,
      words: sandboxWords(formatAmount(perMonth, p.currency), o.label),
    }, dateOf(new Date()));
  }
  if (p.perMonthCap === undefined) {
    throw new MachineError('bad-recipe', `price row for size ${JSON.stringify(p.size)} has neither perHour nor perMonthCap`);
  }
  return withCheckedNote({
    perMonth: p.perMonthCap,
    floor: p.planFloorPerMonth ?? null,
    currency: p.currency,
    basis: 'list',
    checked: p.checked,
    words: vmWords(formatAmount(p.perMonthCap, p.currency), o.label),
  }, dateOf(new Date()));
}

/**
 * `Machine.cost()` for a provider with `usage`: the amount so far projected over the month,
 * raised to the largest `planFloorPerMonth` in `prices()`. A `balance` rejection resolves
 * instead to the floor-or-zero cost with `cost.balance` words — build that with `balanceCost`.
 */
export function usageCost(u: Usage, prices: readonly Price[], o: { label: string; today: string }): Cost {
  const elapsedHours = Math.max(1, (Date.parse(u.to) - Date.parse(u.from)) / 3_600_000);
  const floors = prices.map((p) => p.planFloorPerMonth).filter((f) => f !== undefined);
  const floor = floors.length > 0 ? Math.max(...floors) : null;
  const perMonth = Math.max(floor ?? 0, (u.amount / elapsedHours) * HOURS_PER_MONTH);
  return withCheckedNote({
    perMonth,
    floor,
    currency: u.currency,
    basis: 'usage',
    checked: u.to.slice(0, 10),
    words: sandboxWords(formatAmount(perMonth, u.currency), o.label),
  }, o.today);
}

/** The `Machine.cost()` answer when `usage` rejects `balance` (10.1). */
export function balanceCost(prices: readonly Price[], o: { label: string; today: string }): Cost {
  const floored = prices.filter((p) => p.planFloorPerMonth !== undefined);
  const floor = floored.length > 0 ? Math.max(...floored.map((p) => p.planFloorPerMonth as number)) : null;
  const currency = floored[0]?.currency ?? prices[0]?.currency ?? 'USD';
  return {
    perMonth: floor ?? 0,
    floor,
    currency,
    basis: 'usage',
    checked: o.today,
    words: words('cost.balance', { label: o.label }),
  };
}

/**
 * `Machine.cost()` for a provider without `usage`: `monthlyEntered` if set, else the
 * `perMonthCap` of `prices()[0]`. Returns `null` when neither is set (the caller rejects
 * `unsupported`).
 */
export function enteredCost(
  monthlyEntered: number | undefined,
  prices: readonly Price[],
  o: { label: string; today: string },
): Cost | null {
  const perMonth = monthlyEntered ?? prices[0]?.perMonthCap;
  if (perMonth === undefined) return null;
  const currency = prices[0]?.currency ?? 'USD';
  const checked = monthlyEntered !== undefined ? o.today : (prices[0]?.checked ?? o.today);
  const amount = formatAmount(perMonth, currency);
  return withCheckedNote({
    perMonth,
    floor: null,
    currency,
    basis: 'entered',
    checked,
    words: vmWords(amount, o.label),
  }, o.today);
}
