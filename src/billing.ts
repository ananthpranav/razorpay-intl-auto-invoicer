import type { Client } from './config.ts';

/** Stored in the notes of every invoice this tool creates, so later runs can find them. */
export const SOURCE_TAG = 'razorpay-intl-auto-invoicer';

export const DAY_MS = 86_400_000;

export interface Period {
  key: string; // "2026-10"
  compact: string; // "202610"
  label: string; // "October 2026"
}

export interface BuiltLineItem {
  name: string;
  description: string;
  quantity: number; // whole number, as Razorpay requires
  unitAmount: number; // minor units (cents/pence)
  totalAmount: number;
}

const DEFAULT_DESCRIPTION = {
  hourly: '{hours} hours at {rate}/hour, {period}',
  fixed: '{period}',
};

const monthLabel = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const moneyNumber = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function makePeriod(year: number, month: number): Period {
  const mm = String(month).padStart(2, '0');
  return {
    key: `${year}-${mm}`,
    compact: `${year}${mm}`,
    label: monthLabel.format(Date.UTC(year, month - 1, 1)),
  };
}

export function parsePeriod(value: string): Period {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) throw new Error(`Invalid period "${value}", expected YYYY-MM`);
  return makePeriod(Number(match[1]), Number(match[2]));
}

/** Calendar date of `now` as seen in `timeZone`. */
export function zonedDate(now: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

/** The month an invoice run bills for: `--period` if given, else the previous or current month in `timeZone`. */
export function resolvePeriod(now: Date, timeZone: string, mode: 'previous' | 'current', override?: string): Period {
  if (override) return parsePeriod(override);
  const { year, month } = zonedDate(now, timeZone);
  if (mode === 'current') return makePeriod(year, month);
  return month === 1 ? makePeriod(year - 1, 12) : makePeriod(year, month - 1);
}

/** Deterministic receipt, e.g. INV-202610-client-a. Used as the invoice number and as the duplicate guard. */
export function receiptFor(prefix: string, period: Period, label: string): string {
  return `${prefix}-${period.compact}-${label}`;
}

export function hasAtMostTwoDecimals(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

/** Converts a major-unit amount (25.5) to minor units (2550). Only 2-decimal currencies are supported. */
export function toMinor(amount: number): number {
  if (!hasAtMostTwoDecimals(amount)) throw new Error(`Amount ${amount} must be a number with at most 2 decimal places`);
  return Math.round(amount * 100);
}

export function formatMoney(minor: number, currency: string): string {
  return `${currency} ${moneyNumber.format(minor / 100)}`;
}

export function fractionDigits(currency: string): number | undefined {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

export function buildLineItems(client: Client, period: Period): BuiltLineItem[] {
  return client.items.map((item) => {
    if (item.type === 'fixed') {
      const amount = toMinor(item.amount);
      const description = fill(item.description ?? DEFAULT_DESCRIPTION.fixed, { period: period.label });
      return { name: item.name, description, quantity: 1, unitAmount: amount, totalAmount: amount };
    }
    const rate = toMinor(item.rate);
    const description = fill(item.description ?? DEFAULT_DESCRIPTION.hourly, {
      period: period.label,
      hours: String(item.hours),
      rate: formatMoney(rate, client.currency),
    });
    if (Number.isInteger(item.hours)) {
      return { name: item.name, description, quantity: item.hours, unitAmount: rate, totalAmount: rate * item.hours };
    }
    // Razorpay quantities must be whole numbers, so fractional hours are billed as one line.
    const total = Math.round(rate * item.hours);
    return { name: item.name, description, quantity: 1, unitAmount: total, totalAmount: total };
  });
}
