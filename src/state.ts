import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ConfigError } from './config.ts';
import { writePrivateFile } from './files.ts';

// What the jobs remember between runs, so nobody is emailed twice.

const paymentRecord = z.object({
  status: z.enum(['matched', 'unmatched', 'failed']),
  receipt: z.string().optional(),
  basis: z.enum(['invoice_link', 'reference', 'amount', 'manual']).optional(),
  seenAt: z.string(),
  receiptSentAt: z.string().optional(),
  receiptSkipped: z.boolean().optional(),
});

const invoiceRecord = z.object({
  paymentId: z.string().optional(),
  remindersSent: z.array(z.number()).default([]),
  label: z.string().optional(),
  period: z.string().optional(),
  emailedAt: z.string().optional(),
  emailPending: z.boolean().optional(), // the client email failed; the next run retries it
  emailAttempts: z.number().int().optional(),
  receiptSentAt: z.string().optional(), // at most one payment receipt per invoice
  receiptPaymentId: z.string().optional(),
});

const stateSchema = z.object({
  version: z.literal(1),
  initializedAt: z.string().optional(),
  payments: z.record(z.string(), paymentRecord).default({}),
  invoices: z.record(z.string(), invoiceRecord).default({}),
});

export type State = z.output<typeof stateSchema>;
export type PaymentRecord = z.output<typeof paymentRecord>;
export type InvoiceRecord = z.output<typeof invoiceRecord>;

export function emptyState(): State {
  return { version: 1, payments: {}, invoices: {} };
}

export async function loadState(path: string): Promise<State> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw new ConfigError(`Cannot read the state file at ${path} (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  // Never silently start over: that could resend receipts and reminders.
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new ConfigError(`The state file at ${path} is not valid JSON: fix or remove it`);
  }
  const result = stateSchema.safeParse(data);
  if (!result.success) throw new ConfigError(`The state file at ${path} has an unexpected format: fix or remove it`);
  return result.data;
}

export async function saveState(path: string, state: State): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** A client email is tried this many times, then left to the owner. */
export const MAX_EMAIL_ATTEMPTS = 4;

export function updateInvoice(state: State, receipt: string, changes: Partial<InvoiceRecord>): void {
  state.invoices[receipt] = { remindersSent: [], ...state.invoices[receipt], ...changes };
}

/** A new (or re-issued) invoice starts with a clean record; payments linked to the old one are detached. */
export function resetInvoice(state: State, receipt: string, changes: Partial<InvoiceRecord>): void {
  for (const [id, payment] of Object.entries(state.payments)) {
    if (payment.receipt === receipt) state.payments[id] = { status: 'unmatched', seenAt: payment.seenAt };
  }
  state.invoices[receipt] = { remindersSent: [], ...changes };
}

/**
 * Links a payment to an invoice, keeping exactly one payment per invoice. Re-linking the same pair
 * keeps its receipt state (a manual link marks it confirmed). Returns the payment it displaced.
 */
export function linkPayment(
  state: State,
  paymentId: string,
  receipt: string,
  basis: NonNullable<PaymentRecord['basis']>,
  now: Date,
): string | undefined {
  const current = state.payments[paymentId];
  if (current?.status === 'matched' && current.receipt === receipt) {
    if (basis === 'manual') current.basis = 'manual';
    return undefined;
  }
  unlinkPayment(state, paymentId);
  const displaced = state.invoices[receipt]?.paymentId;
  if (displaced) unlinkPayment(state, displaced);
  state.payments[paymentId] = { status: 'matched', receipt, basis, seenAt: current?.seenAt ?? now.toISOString() };
  updateInvoice(state, receipt, { paymentId });
  return displaced;
}

/** Detaches a payment from its invoice, which counts as unpaid again. A receipt sent for it no longer stands. */
export function unlinkPayment(state: State, paymentId: string, status: 'unmatched' | 'failed' = 'unmatched'): void {
  const record = state.payments[paymentId];
  if (!record) return;
  const invoice = record.receipt ? state.invoices[record.receipt] : undefined;
  if (invoice?.paymentId === paymentId) delete invoice.paymentId;
  if (invoice?.receiptPaymentId === paymentId) {
    delete invoice.receiptSentAt;
    delete invoice.receiptPaymentId;
  }
  state.payments[paymentId] = { status, seenAt: record.seenAt };
}

const STALE_LOCK_MS = 30 * 60_000;

/**
 * Runs `job` while holding a lock next to the state file, so a manual run and the scheduler
 * (possibly in another container) never overwrite each other's state.
 */
export async function withStateLock<T>(path: string, job: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  if (!(await tryLock(lock)) && !(await takeOverStaleLock(lock))) {
    throw new Error(`Another run is in progress (lock file ${lock}). Try again when it finishes.`);
  }
  try {
    return await job();
  } finally {
    await rm(lock, { force: true });
  }
}

/** A lock older than STALE_LOCK_MS was left by a crashed run. Renaming it away is atomic, so only one process wins. */
async function takeOverStaleLock(lock: string): Promise<boolean> {
  let age: number;
  try {
    age = Date.now() - (await stat(lock)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return tryLock(lock); // released meanwhile
    throw error;
  }
  if (age < STALE_LOCK_MS) return false;
  const claimed = `${lock}.${process.pid}.stale`;
  try {
    await rename(lock, claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; // another process took it over
    throw error;
  }
  await rm(claimed, { force: true });
  return tryLock(lock);
}

async function tryLock(lock: string): Promise<boolean> {
  try {
    await writeFile(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}
