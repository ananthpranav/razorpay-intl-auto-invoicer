import { DAY_MS, formatMoney, type BuiltLineItem, type Period } from './billing.ts';
import type { BusinessProfile } from './business.ts';
import type { BankDetails, BillTo, Client, Env } from './config.ts';
import type { CustomerInfo, Invoice } from './razorpay.ts';
import { addressLines, formatDay, splitLines } from './text.ts';

/** A diagonal stamp across the PDF: previews are not real invoices, paid copies serve as receipts. */
export type Stamp = 'preview' | 'paid';

/** Display-ready invoice used by both the PDF and the emails. */
export interface InvoiceView {
  number: string;
  razorpayId?: string;
  issueDate: string;
  dueDate?: string;
  period: string;
  seller: { name: string; lines: string[]; logo?: Buffer };
  billTo: { name?: string; email?: string; addressLines: string[] };
  rows: Array<{ name: string; description?: string; quantity: string; unitPrice: string; amount: string }>;
  total: string;
  payment: { title: string; fields: Array<{ label: string; value: string }>; reference: string; note?: string };
  footerLines: string[];
  stamp?: Stamp;
}

export interface ViewContext {
  env: Env;
  client: Client;
  period: Period;
  bankDetails: BankDetails;
  business: BusinessProfile;
  receipt: string;
}

interface Row {
  name: string;
  description?: string | null;
  quantity: number;
  unitAmount: number;
  totalAmount: number;
}

/** When an invoice issued at `issuedAt` is due, or undefined when no due date is configured. */
export function dueDateOf(issuedAt: Date, client: Client, env: Env): Date | undefined {
  const days = client.dueInDays ?? env.DUE_IN_DAYS;
  return days === undefined ? undefined : new Date(issuedAt.getTime() + days * DAY_MS);
}

export function issuedAtOf(invoice: Invoice): Date {
  return new Date((invoice.issued_at ?? invoice.date ?? invoice.created_at) * 1000);
}

/** View of an invoice Razorpay returned: its numbers and customer details are authoritative. */
export function viewFromInvoice(invoice: Invoice, ctx: ViewContext, stamp?: Stamp): InvoiceView {
  const rows: Row[] = invoice.line_items.map((item) => {
    const unitAmount = Number(item.unit_amount ?? item.amount);
    return {
      name: item.name,
      description: item.description,
      quantity: item.quantity,
      unitAmount,
      totalAmount: item.gross_amount ?? unitAmount * item.quantity,
    };
  });
  const amount = Number(invoice.amount);
  const details = invoice.customer_details;
  const address = details?.billing_address;
  const fromRazorpay = {
    name: details?.name ?? details?.customer_name ?? undefined,
    email: details?.email ?? details?.customer_email ?? undefined,
    addressLines: address
      ? addressLines({ ...address, postalCode: address.zipcode })
      : [],
  };
  return buildView(ctx, {
    number: invoice.receipt ?? ctx.receipt,
    razorpayId: invoice.id,
    issuedAt: issuedAtOf(invoice),
    currency: invoice.currency ?? ctx.client.currency,
    rows,
    total: Number.isFinite(amount) ? amount : rows.reduce((sum, row) => sum + row.totalAmount, 0),
    billTo: ctx.client.billTo ? fromConfig(ctx.client.billTo, fromRazorpay.email) : fromRazorpay,
    stamp,
  });
}

/** View for a dry run, before anything exists in Razorpay. */
export function previewView(items: BuiltLineItem[], customer: CustomerInfo, ctx: ViewContext, now: Date): InvoiceView {
  return buildView(ctx, {
    number: ctx.receipt,
    issuedAt: now,
    currency: ctx.client.currency,
    rows: items,
    total: items.reduce((sum, item) => sum + item.totalAmount, 0),
    billTo: ctx.client.billTo
      ? fromConfig(ctx.client.billTo, customer.email)
      : { name: customer.name, email: customer.email, addressLines: [] },
    stamp: 'preview',
  });
}

interface ViewInput {
  number: string;
  razorpayId?: string;
  issuedAt: Date;
  currency: string;
  rows: Row[];
  total: number;
  billTo: InvoiceView['billTo'];
  stamp?: Stamp;
}

function buildView(ctx: ViewContext, input: ViewInput): InvoiceView {
  const { env, client, period, bankDetails, business } = ctx;
  const dueAt = dueDateOf(input.issuedAt, client, env);
  const money = (minor: number) => formatMoney(minor, input.currency);
  return {
    number: input.number,
    razorpayId: input.razorpayId,
    issueDate: formatDay(input.issuedAt, env.INVOICE_TIMEZONE),
    dueDate: dueAt ? formatDay(dueAt, env.INVOICE_TIMEZONE) : undefined,
    period: period.label,
    seller: { name: business.name, lines: business.lines, logo: business.logo },
    billTo: input.billTo,
    rows: input.rows.map((row) => ({
      name: row.name,
      description: row.description ?? undefined,
      quantity: String(row.quantity),
      unitPrice: money(row.unitAmount),
      amount: money(row.totalAmount),
    })),
    total: money(input.total),
    payment: { title: bankDetails.title, fields: bankDetails.fields, reference: input.number, note: bankDetails.note },
    footerLines: splitLines(env.INVOICE_FOOTER),
    stamp: input.stamp,
  };
}

function fromConfig(billTo: BillTo, email: string | undefined): InvoiceView['billTo'] {
  return { name: billTo.name, email, addressLines: addressLines(billTo) };
}
