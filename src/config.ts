import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { fractionDigits, hasAtMostTwoDecimals } from './billing.ts';

export class ConfigError extends Error {
  details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.details = details;
  }
}

// ── Environment ──────────────────────────────────────────────────────────────

const required = () => z.string({ error: (issue) => (issue.input === undefined ? 'is required' : undefined) });

const bool = (fallback: boolean) =>
  z.enum(['true', 'false'], { error: 'must be true or false' })
    .optional()
    .transform((value) => (value === undefined ? fallback : value === 'true'));

const int = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).optional().transform((value) => value ?? fallback);

// Unquoted values in .env keep "\n" literally; treat it as a line break.
const multiline = z.string().optional().transform((value) => value?.replace(/\\n/g, '\n'));

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// "3,10" -> [3, 10]
const dayList = (fallback: string) =>
  z.string().default(fallback).transform((value, ctx) => {
    const days = value.split(',').map((part) => part.trim()).filter(Boolean).map(Number);
    if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 365)) {
      ctx.addIssue({ code: 'custom', message: 'use comma-separated whole numbers of days, e.g. 3,10' });
      return z.NEVER;
    }
    return [...new Set(days)].sort((a, b) => a - b);
  });

const envShape = z.object({
  RAZORPAY_KEY_ID: required().regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, 'must look like rzp_test_… or rzp_live_…'),
  RAZORPAY_KEY_SECRET: required(),
  // Optional: lets the tool try Razorpay's Accounts API for your registered address and GSTIN.
  RAZORPAY_ACCOUNT_ID: z.string().regex(/^(acc_)?[A-Za-z0-9]{14}$/, 'must be your account ID, e.g. acc_XXXXXXXXXXXXXX')
    .optional()
    .transform((value) => (value && !value.startsWith('acc_') ? `acc_${value}` : value)),

  CLIENTS_DATA_PATH: z.string().default('./clients.json'),
  BANK_DETAILS_PATH: z.string().default('./bank-details.json'),

  INVOICE_TIMEZONE: z.string().default('Asia/Kolkata').refine(isTimeZone, 'must be an IANA time zone, e.g. Asia/Kolkata'),
  BILLING_PERIOD: z.enum(['previous', 'current']).default('previous'),
  RECEIPT_PREFIX: z.string().regex(/^[A-Za-z0-9]{1,10}$/, 'use 1-10 letters or digits').default('INV'),
  DUE_IN_DAYS: z.coerce.number().int().min(0).max(365).optional(),
  RAZORPAY_NOTIFY: bool(false),

  // Read from Razorpay when not set here; values set here always win.
  BUSINESS_NAME: z.string().optional(),
  BUSINESS_ADDRESS: multiline,
  BUSINESS_EMAIL: z.email().optional(),
  BUSINESS_TAX_INFO: multiline,
  BUSINESS_LOGO_PATH: z.string().optional(),
  SHOW_LOGO: bool(true),
  INVOICE_FOOTER: multiline,
  PDF_FONT_PATH: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(465, 1, 65535),
  SMTP_SECURE: bool(true),
  SMTP_REQUIRE_TLS: bool(true),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().includes('@', { error: 'must contain an email address, e.g. "Your Name <billing@example.com>"' }).optional(),
  EMAIL_REPLY_TO: z.email().optional(),
  OWNER_EMAIL: z.email().optional(),
  SEND_CLIENT_EMAILS: bool(true),
  SEND_PAYMENT_RECEIPTS: bool(false),
  SEND_REMINDERS: bool(false),
  REMINDER_DAYS: dayList('3,10'),

  SAVE_OUTPUT: bool(true),
  OUTPUT_DIR: z.string().default('./output'),
  STATE_PATH: z.string().default('./data/state.json'),
  INVOICE_SCHEDULE: z.string().default('0 9 1 * *'),
  PAYMENT_CHECK_SCHEDULE: z.string().default('0 10 * * *'),
  REPORT_SCHEDULE: z.string().default('0 9 3 * *'),
  CATCH_UP_DAYS: int(3, 0, 28),
  DRY_RUN: bool(false),
});

const envSchema = envShape.superRefine((env, ctx) => {
  if (env.SEND_CLIENT_EMAILS || env.SEND_PAYMENT_RECEIPTS || env.SEND_REMINDERS || env.OWNER_EMAIL) {
    const reason = 'is required when any email is sent (SEND_* settings or OWNER_EMAIL)';
    if (!env.SMTP_HOST) ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: reason });
    if (!env.EMAIL_FROM) ctx.addIssue({ code: 'custom', path: ['EMAIL_FROM'], message: reason });
  }
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASS)) {
    ctx.addIssue({ code: 'custom', path: ['SMTP_PASS'], message: 'set both SMTP_USER and SMTP_PASS, or neither' });
  }
});

export type Env = z.output<typeof envShape>;

/** Loads .env from the working directory if present. Variables already set in the environment win. */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

/** `requireEmailSettings: false` is for helper commands that never send email. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env, options: { requireEmailSettings?: boolean } = {}): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''));
  const result = (options.requireEmailSettings === false ? envShape : envSchema).safeParse(cleaned);
  if (!result.success) throw new ConfigError('Invalid environment configuration (.env)', describeIssues(result.error, ''));
  return result.data;
}

// ── clients.json ─────────────────────────────────────────────────────────────

const amount = z.number().positive().refine(hasAtMostTwoDecimals, 'use at most 2 decimal places');
const text = (max: number) => z.string().trim().min(1).max(max);

const hourlyItem = z.strictObject({
  type: z.literal('hourly'),
  name: text(200),
  description: text(500).optional(),
  rate: amount,
  hours: amount,
});

const fixedItem = z.strictObject({
  type: z.literal('fixed'),
  name: text(200),
  description: text(500).optional(),
  amount,
});

const address = z.strictObject({
  name: text(200),
  line1: text(200),
  line2: text(200).optional(),
  city: text(100),
  state: text(100).optional(),
  postalCode: text(20),
  country: text(100),
});

function isTwoDecimalCurrency(code: string): boolean {
  return /^[A-Z]{3}$/.test(code) && Intl.supportedValuesOf('currency').includes(code) && fractionDigits(code) === 2;
}

const clientSchema = z.strictObject({
  label: z.string().regex(/^[a-z0-9][a-z0-9-]{0,19}$/, 'use lowercase letters, digits and dashes (max 20)'),
  customerId: z.string().regex(/^cust_[A-Za-z0-9]+$/, 'must be a Razorpay customer id like cust_XXXXXXXXXXXXXX'),
  currency: z.string().transform((value) => value.toUpperCase())
    .refine(isTwoDecimalCurrency, 'must be an ISO currency code with 2 decimal places, e.g. USD, GBP, EUR'),
  enabled: z.boolean().default(true),
  items: z.array(z.discriminatedUnion('type', [hourlyItem, fixedItem])).min(1).max(50),
  billTo: address.optional(),
  emailTo: z.array(z.email()).min(1).optional(),
  emailCc: z.array(z.email()).optional(),
  dueInDays: z.number().int().min(0).max(365).optional(),
});

const clientsSchema = z.array(clientSchema).min(1, 'add at least one client').superRefine((clients, ctx) => {
  const seen = new Set<string>();
  clients.forEach((client, index) => {
    if (seen.has(client.label)) {
      ctx.addIssue({ code: 'custom', path: [index, 'label'], message: `duplicate label "${client.label}"` });
    }
    seen.add(client.label);
  });
});

export type Client = z.output<typeof clientSchema>;
export type BillTo = z.output<typeof address>;

/** Who gets a client's emails: `emailTo`, or else the email on the Razorpay customer. */
export function recipientsOf(client: Client, customerEmail: string | null | undefined): string[] {
  if (!client.emailTo && customerEmail && !z.email().safeParse(customerEmail).success) {
    throw new Error('the email on the Razorpay customer is not a single valid address: set emailTo in the clients file');
  }
  const recipients = client.emailTo ?? (customerEmail ? [customerEmail] : []);
  if (recipients.length === 0) throw new Error('no recipient email: add emailTo in the clients file or an email to the Razorpay customer');
  return recipients;
}

// ── bank-details.json ────────────────────────────────────────────────────────

const bankDetailsSchema = z.record(
  z.string().regex(/^[A-Z]{3}$/, 'keys must be currency codes such as USD'),
  z.strictObject({
    title: text(120),
    fields: z.array(z.strictObject({ label: text(60), value: text(200) })).min(1),
    note: text(500).optional(),
  }),
);

export type BankDetailsMap = z.output<typeof bankDetailsSchema>;
export type BankDetails = BankDetailsMap[string];

// ── Loading ──────────────────────────────────────────────────────────────────

export interface AppConfig {
  env: Env;
  clients: Client[];
  bankDetails: BankDetailsMap;
}

export function parseClients(data: unknown): Client[] {
  const result = clientsSchema.safeParse(data);
  if (!result.success) throw new ConfigError('Invalid clients file', describeIssues(result.error, 'clients'));
  return result.data;
}

export function parseBankDetails(data: unknown): BankDetailsMap {
  const result = bankDetailsSchema.safeParse(data);
  if (!result.success) throw new ConfigError('Invalid bank details file', describeIssues(result.error, 'bank-details'));
  return result.data;
}

export function loadConfig(env: Env): AppConfig {
  const clients = parseClients(readJson(env.CLIENTS_DATA_PATH, 'clients'));
  const bankDetails = parseBankDetails(readJson(env.BANK_DETAILS_PATH, 'bank details'));
  checkBankDetails(clients, bankDetails);
  return { env, clients, bankDetails };
}

export function checkBankDetails(clients: Client[], bankDetails: BankDetailsMap): void {
  const currencies = new Set(clients.filter((client) => client.enabled).map((client) => client.currency));
  const missing = [...currencies].filter((currency) => !bankDetails[currency]);
  if (missing.length > 0) {
    throw new ConfigError(
      'Missing bank details',
      missing.map((currency) => `bank-details: add an entry for ${currency} (an enabled client is billed in it)`),
    );
  }
}

function readJson(path: string, name: string): unknown {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigError(`Cannot read the ${name} file at ${path}${code ? ` (${code})` : ''}`);
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    // V8's message quotes part of the file, which may contain private data: keep only the position.
    const where = /line \d+ column \d+|position \d+/.exec((error as Error).message)?.[0];
    throw new ConfigError(`The ${name} file at ${path} is not valid JSON${where ? ` (${where})` : ''}`);
  }
}

function describeIssues(error: z.ZodError, root: string): string[] {
  return error.issues.map((issue) => {
    let where = root;
    for (const key of issue.path) {
      where += typeof key === 'number' ? `[${key}]` : `${where ? '.' : ''}${String(key)}`;
    }
    return `${where || 'value'}: ${issue.message}`;
  });
}
