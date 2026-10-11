import type { Client } from './config.ts';
import type { Invoice, Payment } from './razorpay.ts';

/** An invoice this tool created, as the payment checks see it. */
export interface TrackedInvoice {
  receipt: string;
  invoice: Invoice;
  client: Client;
  currency: string;
  amountDue: number; // minor units
  issuedAt: Date;
  paid: boolean; // paid through the Razorpay invoice link
}

export type MatchBasis = 'invoice_link' | 'reference' | 'amount';

export type MatchResult =
  | { kind: 'matched'; invoice: TrackedInvoice; basis: MatchBasis }
  | { kind: 'ambiguous' | 'unmatched'; candidates: TrackedInvoice[] };

/**
 * Finds the invoice a payment belongs to, most certain rule first:
 * 1. it was paid through the invoice's own Razorpay link;
 * 2. the invoice number appears in the payment (clients are asked to use it as the transfer reference);
 * 3. it is the only open invoice for exactly this currency and amount.
 * Anything else is left for the owner to decide.
 */
export function matchPayment(payment: Payment, open: TrackedInvoice[], all: TrackedInvoice[] = open): MatchResult {
  if (payment.invoice_id) {
    const linked = all.find((item) => item.invoice.id === payment.invoice_id);
    if (linked) return { kind: 'matched', invoice: linked, basis: 'invoice_link' };
  }
  const amount = Number(payment.amount);
  const pool = open.filter((item) => item.currency === payment.currency && item.issuedAt.getTime() <= payment.created_at * 1000);
  const words = wordsIn(payment);
  const referenced = pool.filter((item) => words.has(compact(item.receipt)));
  if (referenced.length === 1) return { kind: 'matched', invoice: referenced[0]!, basis: 'reference' };

  const sameAmount = (referenced.length > 1 ? referenced : pool).filter((item) => item.amountDue === amount);
  if (sameAmount.length === 1) return { kind: 'matched', invoice: sameAmount[0]!, basis: 'amount' };
  if (sameAmount.length > 1) return { kind: 'ambiguous', candidates: sameAmount };
  const closest = [...pool].sort((a, b) => Math.abs(a.amountDue - amount) - Math.abs(b.amountDue - amount)).slice(0, 3);
  return { kind: 'unmatched', candidates: closest };
}

const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Every word in the payment's text, so the invoice number is found wherever Razorpay stores the transfer reference. */
function wordsIn(payment: Payment): Set<string> {
  const words = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const word of value.split(/[\s,;:/|()"'[\]{}<>]+/)) {
        const normalized = compact(word);
        if (normalized) words.add(normalized);
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  visit(payment);
  return words;
}
