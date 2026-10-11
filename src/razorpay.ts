import Razorpay from 'razorpay';
import { log } from './log.ts';
import type { Accounts } from 'razorpay/dist/types/accounts' with { 'resolution-mode': 'require' };
import type { Invoices } from 'razorpay/dist/types/invoices' with { 'resolution-mode': 'require' };
import type { Payments } from 'razorpay/dist/types/payments' with { 'resolution-mode': 'require' };

export type Invoice = Invoices.RazorpayInvoice;
export type InvoiceCreateBody = Invoices.RazorpayInvoiceCreateRequestBody;
export type Payment = Payments.RazorpayPayment;
export type Account = Accounts.RazorpayAccount;

export interface CustomerInfo {
  id: string;
  name?: string;
  email?: string;
  contact?: string;
}

/** What Razorpay Checkout shows about your business. */
export interface Branding {
  name?: string;
  brandName?: string;
  logoUrl?: string;
}

/** One line of Razorpay's settlement reconciliation. Amounts are in currency subunits (paise for INR). */
export interface ReconItem {
  entity_id: string;
  type: string;
  debit: number;
  credit: number;
  amount: number | string;
  currency: string;
  fee: number;
  tax: number;
  settled: boolean;
  settled_at: number | null;
  created_at: number;
  settlement_id: string | null;
  settlement_utr: string | null;
}

/** The Razorpay calls this project makes. Tests swap in a fake. */
export interface RazorpayGateway {
  fetchCustomer(customerId: string): Promise<CustomerInfo>;
  /** Every invoice with this receipt, including cancelled ones. */
  findInvoicesByReceipt(receipt: string): Promise<Invoice[]>;
  createInvoice(body: InvoiceCreateBody): Promise<Invoice>;
  listCustomerInvoices(customerId: string): Promise<Invoice[]>;
  listPayments(from: Date, to: Date): Promise<Payment[]>;
  listCustomers(): Promise<CustomerInfo[]>;
  createCustomer(input: { name: string; email?: string; contact?: string }): Promise<CustomerInfo>;
  settlementRecon(year: number, month: number): Promise<ReconItem[]>;
  fetchAccount(accountId: string): Promise<Account>;
  fetchBranding(): Promise<Branding>;
}

const unix = (date: Date) => Math.floor(date.getTime() / 1000);
const MAX_PAGES = 50;

/** Fetches every page of a Razorpay list endpoint (newest first), up to MAX_PAGES pages. */
async function collect<T>(fetchPage: (skip: number) => Promise<{ items?: T[] }>, pageSize: number): Promise<T[]> {
  const all: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const items = (await fetchPage(page * pageSize)).items ?? [];
    all.push(...items);
    if (items.length < pageSize) return all;
  }
  log.warn(`Razorpay returned more than ${all.length} items; only the newest ${all.length} were read`);
  return all;
}

/** Razorpay returns notes as an object, or as an empty array when there are none. */
export function notesOf(entity: { notes?: unknown }): Record<string, string | number> {
  const notes = entity.notes;
  return notes && typeof notes === 'object' && !Array.isArray(notes) ? (notes as Record<string, string | number>) : {};
}

function toCustomerInfo(customer: { id: string; name?: string; email?: string; contact?: string | number }): CustomerInfo {
  return {
    id: customer.id,
    name: customer.name || undefined,
    email: customer.email || undefined,
    contact: customer.contact ? String(customer.contact) : undefined,
  };
}

export function createRazorpayGateway(keyId: string, keySecret: string): RazorpayGateway {
  const client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  return {
    fetchCustomer: async (customerId) => toCustomerInfo(await client.customers.fetch(customerId)),
    async findInvoicesByReceipt(receipt) {
      const page = await client.invoices.all({ receipt, count: 100 });
      return page.items.filter((invoice) => invoice.receipt === receipt);
    },
    createInvoice: (body) => client.invoices.create(body),
    listCustomerInvoices: (customerId) => collect((skip) => client.invoices.all({ customer_id: customerId, count: 100, skip }), 100),
    listPayments: (from, to) => collect((skip) => client.payments.all({ from: unix(from), to: unix(to), count: 100, skip }), 100),
    listCustomers: async () => (await collect((skip) => client.customers.all({ count: 100, skip }), 100)).map(toCustomerInfo),
    createCustomer: async (input) => toCustomerInfo(await client.customers.create({ ...input, fail_existing: 0 })),
    settlementRecon: (year, month) =>
      // The SDK types this as a single item; the API returns a collection.
      collect(async (skip) => (await client.settlements.reports({ year, month, count: 1000, skip })) as unknown as { items?: ReconItem[] }, 1000),
    fetchAccount: (accountId) => client.accounts.fetch(accountId),
    async fetchBranding() {
      // The public endpoint Razorpay Checkout uses to show your name and logo. It takes only the key ID.
      const response = await fetch(`https://api.razorpay.com/v1/preferences?key_id=${encodeURIComponent(keyId)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Razorpay preferences request failed (HTTP ${response.status})`);
      const data = (await response.json()) as { merchant_name?: string; merchant_brand_name?: string; options?: { image?: string } };
      return {
        name: data.merchant_name || undefined,
        brandName: data.merchant_brand_name || undefined,
        logoUrl: data.options?.image || undefined,
      };
    },
  };
}

interface RazorpayApiError {
  statusCode: number | string;
  error?: { description?: string };
}

function isRazorpayApiError(value: unknown): value is RazorpayApiError {
  return typeof value === 'object' && value !== null && 'statusCode' in value;
}

/**
 * A log-safe description of an error. Never log the raw object: SDK and HTTP errors
 * can carry request details, including the Authorization header.
 */
export function describeError(error: unknown): string {
  if (isRazorpayApiError(error)) {
    return `Razorpay API error ${error.statusCode}: ${error.error?.description ?? 'no description'}`;
  }
  if (error instanceof TypeError && error.message.includes("reading 'status'")) {
    // The SDK fails this way when the request never got a response (DNS, timeout, offline).
    return 'Could not reach the Razorpay API (network error)';
  }
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}
