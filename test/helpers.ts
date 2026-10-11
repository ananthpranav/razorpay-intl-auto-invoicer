import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BusinessProfile } from '../src/business.ts';
import { loadEnv, parseBankDetails, parseClients, type AppConfig, type Env } from '../src/config.ts';
import type { Mailer, OutgoingEmail } from '../src/email.ts';
import type {
  Account,
  Branding,
  CustomerInfo,
  Invoice,
  InvoiceCreateBody,
  Payment,
  RazorpayGateway,
  ReconItem,
} from '../src/razorpay.ts';

/** 1 Nov 2026, 09:00 in India: a run then bills October 2026. */
export const NOV_1 = new Date('2026-11-01T03:30:00Z');

export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export const BUSINESS: BusinessProfile = {
  name: 'Example Studio',
  lines: ['12 Example Road', 'Bengaluru 560001', 'India', 'billing@example.com'],
};

export function readExample(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'invoicer-test-'));
}

export function makeEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    RAZORPAY_KEY_ID: 'rzp_test_FAKEKEY',
    RAZORPAY_KEY_SECRET: 'fake-secret',
    SMTP_HOST: 'smtp.example.com',
    EMAIL_FROM: 'Example Studio <billing@example.com>',
    OWNER_EMAIL: 'owner@example.com',
    SAVE_OUTPUT: 'false',
    DUE_IN_DAYS: '15',
    STATE_PATH: join(tempDir(), 'state.json'),
    ...overrides,
  });
}

export function makeConfig(envOverrides: Record<string, string> = {}): AppConfig {
  return {
    env: makeEnv(envOverrides),
    clients: parseClients(readExample('clients.example.json')),
    bankDetails: parseBankDetails(readExample('bank-details.example.json')),
  };
}

let paymentCount = 0;

/** A payment as Razorpay returns it. Only the fields the invoicer reads are filled in. */
export function makePayment(fields: Partial<Payment> & Pick<Payment, 'amount' | 'currency'>): Payment {
  paymentCount += 1;
  return {
    id: `pay_TEST${String(paymentCount).padStart(10, '0')}`,
    entity: 'payment',
    status: 'authorized',
    method: 'intl_bank_transfer',
    invoice_id: null,
    international: true,
    created_at: new Date('2026-11-05T06:00:00Z').getTime() / 1000,
    notes: [],
    ...fields,
  } as unknown as Payment;
}

export class FakeGateway implements RazorpayGateway {
  customers = new Map<string, CustomerInfo>([
    ['cust_XXXXXXXXXXXXXX', { id: 'cust_XXXXXXXXXXXXXX', name: 'Example Corp', email: 'a@example.com' }],
    ['cust_YYYYYYYYYYYYYY', { id: 'cust_YYYYYYYYYYYYYY', name: 'Second Client Ltd' }],
    ['cust_ZZZZZZZZZZZZZZ', { id: 'cust_ZZZZZZZZZZZZZZ', name: 'Third Client Ltd', email: 'c@example.com' }],
  ]);
  invoices: Invoice[] = [];
  created: InvoiceCreateBody[] = [];
  payments: Payment[] = [];
  recon: ReconItem[] = [];
  branding: Branding = { name: 'Example Studio Pvt Ltd', brandName: 'Example Studio' };
  account?: Account;
  issuedAt = NOV_1;

  async fetchCustomer(customerId: string): Promise<CustomerInfo> {
    const customer = this.customers.get(customerId);
    // Same shape the Razorpay SDK rejects with.
    if (!customer) throw { statusCode: 400, error: { description: 'The id provided does not exist' } };
    return customer;
  }

  async findInvoicesByReceipt(receipt: string): Promise<Invoice[]> {
    return this.invoices.filter((invoice) => invoice.receipt === receipt);
  }

  async createInvoice(body: InvoiceCreateBody): Promise<Invoice> {
    this.created.push(body);
    const customer = this.customers.get(body.customer_id ?? '');
    const lineItems = body.line_items.map((item, index) => {
      const amount = Number(item.amount);
      const quantity = item.quantity ?? 1;
      return {
        id: `li_TEST${index}`,
        name: item.name,
        description: item.description,
        amount,
        unit_amount: amount,
        gross_amount: amount * quantity,
        currency: item.currency,
        quantity,
      };
    });
    const total = lineItems.reduce((sum, item) => sum + item.gross_amount, 0);
    const invoice = {
      id: `inv_TEST${String(this.invoices.length + 1).padStart(10, '0')}`,
      entity: 'invoice',
      type: 'invoice',
      status: 'issued',
      receipt: body.receipt,
      customer_id: body.customer_id,
      currency: body.currency,
      amount: total,
      amount_due: total,
      issued_at: this.issuedAt.getTime() / 1000,
      created_at: this.issuedAt.getTime() / 1000,
      notes: body.notes,
      line_items: lineItems,
      customer_details: { name: customer?.name, email: customer?.email },
    } as unknown as Invoice;
    this.invoices.push(invoice);
    return invoice;
  }

  async listCustomerInvoices(customerId: string): Promise<Invoice[]> {
    return this.invoices.filter((invoice) => (invoice as unknown as { customer_id: string }).customer_id === customerId);
  }

  async listPayments(from: Date, to: Date): Promise<Payment[]> {
    return this.payments.filter((payment) => payment.created_at * 1000 >= from.getTime() && payment.created_at * 1000 <= to.getTime());
  }

  async listCustomers(): Promise<CustomerInfo[]> {
    return [...this.customers.values()];
  }

  async createCustomer(input: { name: string; email?: string; contact?: string }): Promise<CustomerInfo> {
    const customer = { id: `cust_NEW${String(this.customers.size).padStart(11, '0')}`, ...input };
    this.customers.set(customer.id, customer);
    return customer;
  }

  async settlementRecon(): Promise<ReconItem[]> {
    return this.recon;
  }

  async fetchAccount(): Promise<Account> {
    if (!this.account) throw { statusCode: 401, error: { description: 'Access Denied' } };
    return this.account;
  }

  async fetchBranding(): Promise<Branding> {
    return this.branding;
  }
}

export class FakeMailer implements Mailer {
  sent: OutgoingEmail[] = [];
  failFor = new Set<string>();
  onSend?: (email: OutgoingEmail) => void;

  async send(email: OutgoingEmail): Promise<void> {
    if (email.to.some((address) => this.failFor.has(address))) throw new Error('SMTP 550 mailbox unavailable');
    this.sent.push(email);
    this.onSend?.(email);
  }
}
