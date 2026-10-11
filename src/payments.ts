import { DAY_MS, formatMoney, makePeriod, parsePeriod, SOURCE_TAG, zonedDate, type Period } from './billing.ts';
import type { BusinessProfile } from './business.ts';
import { ConfigError, recipientsOf, type AppConfig, type Client } from './config.ts';
import {
  paymentDigestEmail,
  paymentReceiptEmail,
  paymentReminderEmail,
  type Attachment,
  type DigestMatch,
  type Mailer,
} from './email.ts';
import { log } from './log.ts';
import { matchPayment, type MatchBasis, type TrackedInvoice } from './matching.ts';
import { renderInvoicePdf } from './pdf.ts';
import { describeError, notesOf, type Invoice, type Payment, type RazorpayGateway } from './razorpay.ts';
import { linkPayment, loadState, saveState, unlinkPayment, updateInvoice, type State } from './state.ts';
import { formatDay } from './text.ts';
import { dueDateOf, issuedAtOf, viewFromInvoice, type InvoiceView, type Stamp } from './view.ts';

/** Invoices older than this are no longer chased. */
const TRACK_DAYS = 180;
/** How far back each check looks for payments. */
const LOOKBACK_DAYS = 60;
/** Reminders stop this many days after the last REMINDER_DAYS entry. */
const REMINDER_GRACE_DAYS = 7;
const DEAD_STATUSES = new Set(['failed', 'refunded']);

const BASIS_TEXT: Record<MatchBasis, string> = {
  invoice_link: 'paid through the Razorpay invoice link',
  reference: 'matched by the invoice number in the transfer reference',
  amount: 'matched by amount only, so please check it (confirm it with --match to send the client a receipt)',
};

export interface PaymentCheckOptions {
  dryRun: boolean;
  now?: Date;
  /** Record by hand that a payment belongs to an invoice. */
  match?: { paymentId: string; receipt: string };
}

export interface PaymentDeps {
  gateway: Pick<RazorpayGateway, 'listCustomerInvoices' | 'listPayments'>;
  mailer?: Mailer;
  business: BusinessProfile;
}

export interface PaymentReport {
  baseline: boolean;
  dryRun: boolean;
  matched: Array<{ payment: Payment; invoice: TrackedInvoice; basis: MatchBasis }>;
  unmatched: Array<{ payment: Payment; candidates: TrackedInvoice[]; ambiguous: boolean }>;
  /** Matched payments that later failed or were refunded: their invoices are open again. */
  reopened: Array<{ payment: Payment; receipt: string }>;
  receipts: Array<{ payment: Payment; invoice: TrackedInvoice }>;
  reminders: Array<{ invoice: TrackedInvoice; daysOverdue: number }>;
  errors: string[];
  ownerNotified: boolean;
}

export function paymentExitCode(report: PaymentReport): number {
  return report.errors.length > 0 ? 1 : 0;
}

/**
 * The daily payment check: matches new payments to invoices, emails clients a receipt once Razorpay
 * captures a payment, sends overdue reminders, and emails the owner what happened.
 * The first run only records what already exists, so nobody gets a late receipt or reminder.
 */
export async function runPaymentCheck(config: AppConfig, deps: PaymentDeps, options: PaymentCheckOptions): Promise<PaymentReport> {
  const { env } = config;
  const now = options.now ?? new Date();
  const state = await loadState(env.STATE_PATH);
  const baseline = state.initializedAt === undefined;
  const report: PaymentReport = {
    baseline,
    dryRun: options.dryRun,
    matched: [],
    unmatched: [],
    reopened: [],
    receipts: [],
    reminders: [],
    errors: [],
    ownerNotified: false,
  };
  // A failed save stops the run: carrying on could email someone twice.
  const persist = () => (options.dryRun ? Promise.resolve() : saveState(env.STATE_PATH, state));

  const tracked = await trackedInvoices(config, deps.gateway, now);
  const byReceipt = new Map(tracked.map((item) => [item.receipt, item]));
  const isUnlinked = (item: TrackedInvoice) => !state.invoices[item.receipt]?.paymentId;
  const isOpen = (item: TrackedInvoice) => !item.paid && isUnlinked(item);

  const currencies = new Set(config.clients.map((client) => client.currency));
  const payments = (await deps.gateway.listPayments(new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS), now))
    .filter((payment) => currencies.has(payment.currency))
    .sort((a, b) => a.created_at - b.created_at);
  if (options.match) recordManualMatch(state, options.match, byReceipt, payments, now);
  log.info(`Payment check: ${payments.length} payment(s) in the last ${LOOKBACK_DAYS} days${baseline ? ', first run' : ''}`);

  for (const payment of payments) {
    const known = state.payments[payment.id];
    if (DEAD_STATUSES.has(payment.status)) {
      if (known?.status === 'matched' && known.receipt) {
        report.reopened.push({ payment, receipt: known.receipt });
        log.warn(`${payment.id}: ${payment.status}, so ${known.receipt} is open again`);
      }
      if (known) unlinkPayment(state, payment.id, 'failed');
      continue;
    }
    if (!known) {
      const result = matchPayment(payment, tracked.filter(isOpen), tracked.filter(isUnlinked));
      if (result.kind === 'matched') {
        linkPayment(state, payment.id, result.invoice.receipt, result.basis, now);
        report.matched.push({ payment, invoice: result.invoice, basis: result.basis });
        log.info(`${payment.id}: belongs to ${result.invoice.receipt} (${result.basis})`);
      } else {
        state.payments[payment.id] = { status: 'unmatched', seenAt: now.toISOString() };
        report.unmatched.push({ payment, candidates: result.candidates, ambiguous: result.kind === 'ambiguous' });
        log.warn(`${payment.id}: no matching invoice found`);
      }
    }

    const record = state.payments[payment.id]!;
    const invoice = record.status === 'matched' && record.receipt ? byReceipt.get(record.receipt) : undefined;
    if (!invoice || payment.status !== 'captured' || record.receiptSentAt || record.receiptSkipped) continue;
    if (baseline || !env.SEND_PAYMENT_RECEIPTS || state.invoices[invoice.receipt]?.receiptSentAt) {
      // Never send a receipt late (turning receipts on later only affects new payments), and send
      // at most one per invoice.
      record.receiptSkipped = true;
      continue;
    }
    if (record.basis === 'amount') continue; // a guess: wait for the owner to confirm it with --match
    if (!(await attempt(report, `${invoice.client.label} ${invoice.receipt}: receipt email failed`, () =>
      sendReceipt(payment, invoice, config, deps, options.dryRun)))) continue;
    record.receiptSentAt = now.toISOString();
    updateInvoice(state, invoice.receipt, { receiptSentAt: record.receiptSentAt, receiptPaymentId: payment.id });
    report.receipts.push({ payment, invoice });
    log.info(`${invoice.client.label} ${invoice.receipt}: payment receipt ${options.dryRun ? 'would be ' : ''}emailed`);
    await persist();
  }

  const lastReminder = env.REMINDER_DAYS.at(-1);
  for (const item of tracked.filter(isOpen)) {
    const due = dueDateOf(item.issuedAt, item.client, env);
    if (!due || lastReminder === undefined) continue;
    const daysOverdue = daysBetween(due, now, env.INVOICE_TIMEZONE);
    const reached = env.REMINDER_DAYS.filter((day) => day <= daysOverdue);
    const latest = reached.at(-1);
    const record = state.invoices[item.receipt] ?? { remindersSent: [] };
    if (latest === undefined || record.remindersSent.includes(latest)) continue;
    const handled = { ...record, remindersSent: [...new Set([...record.remindersSent, ...reached])] };
    if (baseline || !env.SEND_REMINDERS || daysOverdue > lastReminder + REMINDER_GRACE_DAYS) {
      // Same rule as receipts: a reminder that was not sent on time is never sent late.
      state.invoices[item.receipt] = handled;
      continue;
    }
    if (!(await attempt(report, `${item.client.label} ${item.receipt}: reminder email failed`, () =>
      sendReminder(item, config, deps, options.dryRun)))) continue;
    state.invoices[item.receipt] = handled;
    report.reminders.push({ invoice: item, daysOverdue });
    log.info(`${item.client.label} ${item.receipt}: reminder ${options.dryRun ? 'would be ' : ''}emailed (${daysOverdue} days overdue)`);
    await persist();
  }

  state.initializedAt ??= now.toISOString();
  await persist();
  if (!options.dryRun) await notifyOwner(report, config, deps);
  return report;
}

/** Runs `send`, recording a failure in the report. Returns whether it worked. */
async function attempt(report: PaymentReport, failure: string, send: () => Promise<void>): Promise<boolean> {
  try {
    await send();
    return true;
  } catch (error) {
    report.errors.push(`${failure}: ${describeError(error)}`);
    return false;
  }
}

async function trackedInvoices(
  config: AppConfig,
  gateway: Pick<RazorpayGateway, 'listCustomerInvoices'>,
  now: Date,
): Promise<TrackedInvoice[]> {
  const since = now.getTime() - TRACK_DAYS * DAY_MS;
  // Disabled clients are included: their last invoices may still be unpaid.
  const clientsByCustomer = new Map<string, Client[]>();
  for (const client of config.clients) {
    clientsByCustomer.set(client.customerId, [...(clientsByCustomer.get(client.customerId) ?? []), client]);
  }
  const lists = await Promise.all([...clientsByCustomer].map(async ([customerId, clients]) =>
    ({ clients, invoices: await gateway.listCustomerInvoices(customerId) })));
  const tracked: TrackedInvoice[] = [];
  for (const { clients, invoices } of lists) {
    for (const invoice of invoices) {
      const notes = notesOf(invoice);
      if (notes.source !== SOURCE_TAG || !invoice.receipt) continue;
      if (!['issued', 'partially_paid', 'paid'].includes(invoice.status ?? '')) continue;
      const issuedAt = issuedAtOf(invoice);
      if (issuedAt.getTime() < since) continue;
      const client = clients.find((candidate) => candidate.label === notes.label) ?? clients[0]!;
      tracked.push({
        receipt: invoice.receipt,
        invoice,
        client,
        currency: invoice.currency ?? client.currency,
        amountDue: Number(invoice.amount_due ?? invoice.amount),
        issuedAt,
        paid: invoice.status === 'paid',
      });
    }
  }
  return tracked;
}

function recordManualMatch(
  state: State,
  match: { paymentId: string; receipt: string },
  byReceipt: Map<string, TrackedInvoice>,
  payments: Payment[],
  now: Date,
): void {
  if (!byReceipt.has(match.receipt)) {
    throw new ConfigError(`Unknown invoice ${match.receipt}`, ['only invoices this tool created in the last 180 days can be matched']);
  }
  if (!payments.some((payment) => payment.id === match.paymentId)) {
    throw new ConfigError(`Unknown payment ${match.paymentId}`, [`only payments from the last ${LOOKBACK_DAYS} days in your clients' currencies can be matched`]);
  }
  const displaced = linkPayment(state, match.paymentId, match.receipt, 'manual', now);
  if (displaced) log.warn(`${displaced} no longer counts as the payment for ${match.receipt}`);
  log.info(`${match.paymentId}: recorded as the payment for ${match.receipt}`);
}

async function sendReceipt(payment: Payment, item: TrackedInvoice, config: AppConfig, deps: PaymentDeps, dryRun: boolean): Promise<void> {
  const view = viewFor(item, config, deps.business, 'paid');
  const recipients = recipientsOf(item.client, customerEmailOf(item));
  const pdf = { filename: `${item.receipt}-paid.pdf`, content: await renderInvoicePdf(view, { fontPath: config.env.PDF_FONT_PATH }) };
  if (dryRun) return;
  if (!deps.mailer) throw new Error('email is not configured');
  const content = paymentReceiptEmail(view, { amount: moneyOf(payment), receivedOn: dayOf(payment, config) });
  await deps.mailer.send({ to: recipients, cc: item.client.emailCc, ...content, attachments: [pdf] });
}

async function sendReminder(item: TrackedInvoice, config: AppConfig, deps: PaymentDeps, dryRun: boolean): Promise<void> {
  const view = viewFor(item, config, deps.business);
  const recipients = recipientsOf(item.client, customerEmailOf(item));
  const pdf = { filename: `${item.receipt}.pdf`, content: await renderInvoicePdf(view, { fontPath: config.env.PDF_FONT_PATH }) };
  if (dryRun) return;
  if (!deps.mailer) throw new Error('email is not configured');
  await deps.mailer.send({ to: recipients, cc: item.client.emailCc, ...paymentReminderEmail(view), attachments: [pdf] });
}

async function notifyOwner(report: PaymentReport, config: AppConfig, deps: PaymentDeps): Promise<void> {
  const owner = config.env.OWNER_EMAIL;
  const news = report.matched.length + report.unmatched.length + report.reopened.length +
    report.receipts.length + report.reminders.length + report.errors.length;
  if (!owner || !deps.mailer || news === 0) return;

  const attachments: Attachment[] = [];
  const matched: DigestMatch[] = [];
  for (const { payment, invoice, basis } of report.matched) {
    const captured = payment.status === 'captured';
    let buyer: string[] = [];
    try {
      const view = viewFor(invoice, config, deps.business);
      buyer = [view.billTo.name, ...view.billTo.addressLines].filter((line): line is string => Boolean(line));
      // The owner uploads this PDF to the transfer in the Razorpay Dashboard.
      if (!captured) attachments.push({ filename: `${invoice.receipt}.pdf`, content: await renderInvoicePdf(view, { fontPath: config.env.PDF_FONT_PATH }) });
    } catch (error) {
      report.errors.push(`${invoice.receipt}: could not prepare the PDF: ${describeError(error)}`);
    }
    matched.push({
      label: invoice.client.label,
      receipt: invoice.receipt,
      paymentId: payment.id,
      amount: moneyOf(payment),
      receivedOn: dayOf(payment, config),
      basis: BASIS_TEXT[basis],
      captured,
      buyer,
    });
  }
  const content = paymentDigestEmail({
    baseline: report.baseline,
    matched,
    unmatched: report.unmatched.map(({ payment, candidates, ambiguous }) => ({
      paymentId: payment.id,
      amount: moneyOf(payment),
      receivedOn: dayOf(payment, config),
      ambiguous,
      candidates: candidates.map((candidate) => ({ receipt: candidate.receipt, total: formatMoney(candidate.amountDue, candidate.currency) })),
    })),
    reopened: report.reopened.map(({ payment, receipt }) => `${payment.id} (${moneyOf(payment)}) ${payment.status}: ${receipt} counts as unpaid again`),
    receipts: report.receipts.map(({ invoice }) => `${invoice.receipt} (${invoice.client.label})`),
    reminders: report.reminders.map(({ invoice, daysOverdue }) => `${invoice.receipt} (${invoice.client.label}), ${daysOverdue} days overdue`),
    errors: report.errors,
  });
  try {
    await deps.mailer.send({ to: [owner], ...content, attachments });
    report.ownerNotified = true;
    log.info('Payment update emailed to the owner');
  } catch (error) {
    const message = `could not email the payment update to the owner: ${describeError(error)}`;
    report.errors.push(message);
    log.error(message);
  }
}

/** Dry runs print what would happen, amounts included; real runs never log amounts. */
export function printPaymentReport(report: PaymentReport, config: AppConfig): void {
  const lines = [
    ...report.matched.map(({ payment, invoice, basis }) =>
      `  matched    ${payment.id}  ${dayOf(payment, config)}  ${moneyOf(payment)} -> ${invoice.receipt} (${basis})${payment.status === 'captured' ? '' : ', needs "+ Add Details"'}`),
    ...report.unmatched.map(({ payment, candidates, ambiguous }) =>
      `  unmatched  ${payment.id}  ${dayOf(payment, config)}  ${moneyOf(payment)}${ambiguous ? ' (several invoices have this amount)' : ''}${
        candidates.length ? `, closest: ${candidates.map((c) => `${c.receipt} (${formatMoney(c.amountDue, c.currency)})`).join(', ')}` : ''}`),
    ...report.reopened.map(({ payment, receipt }) => `  reopened   ${receipt}: ${payment.id} ${payment.status}`),
    ...report.receipts.map(({ invoice }) => `  receipt    ${invoice.receipt} would be emailed to ${invoice.client.label}`),
    ...report.reminders.map(({ invoice, daysOverdue }) => `  reminder   ${invoice.receipt} would be emailed to ${invoice.client.label} (${daysOverdue} days overdue)`),
  ];
  console.log(`\nPayment check (dry run: nothing was recorded and nobody was emailed)${report.baseline ? ', first run' : ''}:`);
  console.log(lines.length ? lines.join('\n') : '  nothing new');
}

function viewFor(item: TrackedInvoice, config: AppConfig, business: BusinessProfile, stamp?: Stamp): InvoiceView {
  const bankDetails = config.bankDetails[item.currency];
  if (!bankDetails) throw new Error(`no bank details for ${item.currency}`);
  const ctx = { env: config.env, client: item.client, period: periodOf(item.invoice), bankDetails, business, receipt: item.receipt };
  return viewFromInvoice(item.invoice, ctx, stamp);
}

function customerEmailOf(item: TrackedInvoice): string | undefined {
  return item.invoice.customer_details?.email ?? item.invoice.customer_details?.customer_email ?? undefined;
}

function periodOf(invoice: Invoice): Period {
  try {
    return parsePeriod(String(notesOf(invoice).period));
  } catch {
    const issued = issuedAtOf(invoice);
    return makePeriod(issued.getUTCFullYear(), issued.getUTCMonth() + 1);
  }
}

function daysBetween(from: Date, to: Date, timeZone: string): number {
  const a = zonedDate(from, timeZone);
  const b = zonedDate(to, timeZone);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS);
}

const moneyOf = (payment: Payment) => formatMoney(Number(payment.amount), payment.currency);
const dayOf = (payment: Payment, config: AppConfig) => formatDay(new Date(payment.created_at * 1000), config.env.INVOICE_TIMEZONE);
