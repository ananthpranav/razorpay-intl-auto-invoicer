import { join } from 'node:path';
import { buildLineItems, receiptFor, resolvePeriod, SOURCE_TAG, type Period } from './billing.ts';
import type { BusinessProfile } from './business.ts';
import { ConfigError, recipientsOf, type AppConfig, type Client, type Env } from './config.ts';
import { clientInvoiceEmail, ownerSummaryEmail, type Attachment, type Mailer, type SummaryRow } from './email.ts';
import { writePrivateFile } from './files.ts';
import { log } from './log.ts';
import { renderInvoicePdf } from './pdf.ts';
import { describeError, type InvoiceCreateBody, type RazorpayGateway } from './razorpay.ts';
import { loadState, MAX_EMAIL_ATTEMPTS, resetInvoice, saveState, updateInvoice, type State } from './state.ts';
import { previewView, viewFromInvoice, type InvoiceView } from './view.ts';

/** Invoice statuses that still count. Cancelled or expired invoices are never re-sent. */
const LIVE_STATUSES = new Set(['draft', 'issued', 'partially_paid', 'paid']);

export interface RunOptions {
  dryRun: boolean;
  resend: boolean;
  /** Create a new invoice when this month's invoice was cancelled in Razorpay. */
  reissue?: boolean;
  /** Dry runs only: email the preview to OWNER_EMAIL. */
  sendPreview: boolean;
  period?: string;
  only?: string[];
  now?: Date;
}

export interface RunDeps {
  gateway: Pick<RazorpayGateway, 'fetchCustomer' | 'findInvoicesByReceipt' | 'createInvoice'>;
  mailer?: Mailer;
  business: BusinessProfile;
}

export type ClientStatus = 'created' | 'resent' | 'skipped' | 'preview' | 'failed';

export interface ClientResult {
  label: string;
  receipt: string;
  status: ClientStatus;
  invoiceId?: string;
  total?: string;
  emailed: boolean;
  /** The client email failed: it will be retried, or retries ran out. */
  emailRetry?: 'retrying' | 'gave-up';
  warnings: string[];
  /** Set when something went wrong, even after the invoice was created (status stays "created"). */
  error?: string;
  pdf?: Attachment;
}

export interface RunReport {
  period: Period;
  dryRun: boolean;
  results: ClientResult[];
  /** Problems outside a single client, e.g. the owner summary could not be sent. */
  errors: string[];
  ownerNotified: boolean;
}

export function exitCodeFor(report: RunReport): number {
  return report.errors.length > 0 || report.results.some((result) => result.error !== undefined) ? 1 : 0;
}

export async function runInvoices(config: AppConfig, deps: RunDeps, options: RunOptions): Promise<RunReport> {
  const { env } = config;
  const now = options.now ?? new Date();
  const period = resolvePeriod(now, env.INVOICE_TIMEZONE, env.BILLING_PERIOD, options.period);
  const clients = selectClients(config.clients, options.only);
  const mode = env.RAZORPAY_KEY_ID.startsWith('rzp_live_') ? 'live' : 'test';
  log.info(`${options.dryRun ? 'Dry run' : 'Run'} for ${period.label}: ${clients.length} client(s), Razorpay ${mode} mode`);

  const state = await loadState(env.STATE_PATH);
  const persist = () => (options.dryRun ? Promise.resolve() : saveState(env.STATE_PATH, state));
  const report: RunReport = { period, dryRun: options.dryRun, results: [], errors: [], ownerNotified: false };
  for (const client of clients) {
    const result = await processClient(client, config, deps, options, { period, now, state, persist });
    logResult(result);
    report.results.push(result);
    await persist();
  }
  await notifyOwner(report, config, deps, options);
  return report;
}

/** Re-sends client emails that failed in earlier runs. The daily scheduled job calls this. */
export async function retryFailedEmails(config: AppConfig, deps: RunDeps, now = new Date()): Promise<RunReport[]> {
  if (!config.env.SEND_CLIENT_EMAILS) return [];
  const state = await loadState(config.env.STATE_PATH);
  const enabled = new Set(config.clients.filter((client) => client.enabled).map((client) => client.label));
  const byPeriod = new Map<string, string[]>();
  for (const record of Object.values(state.invoices)) {
    if (!record.emailPending || !record.label || !record.period || !enabled.has(record.label)) continue;
    byPeriod.set(record.period, [...(byPeriod.get(record.period) ?? []), record.label]);
  }
  const reports: RunReport[] = [];
  for (const [period, only] of byPeriod) {
    reports.push(await runInvoices(config, deps, { dryRun: false, resend: false, sendPreview: false, period, only, now }));
  }
  return reports;
}

function selectClients(clients: Client[], only: string[] | undefined): Client[] {
  if (!only || only.length === 0) return clients.filter((client) => client.enabled);
  const problems = only.flatMap((label) => {
    const client = clients.find((candidate) => candidate.label === label);
    if (!client) return [`unknown client label "${label}"`];
    return client.enabled ? [] : [`client "${label}" is disabled in the clients file`];
  });
  if (problems.length > 0) throw new ConfigError('Invalid --only selection', problems);
  return clients.filter((client) => only.includes(client.label));
}

interface RunContext {
  period: Period;
  now: Date;
  state: State;
  persist: () => Promise<void>;
}

async function processClient(client: Client, config: AppConfig, deps: RunDeps, options: RunOptions, run: RunContext): Promise<ClientResult> {
  const { env } = config;
  const { period, now, state } = run;
  const receipt = receiptFor(env.RECEIPT_PREFIX, period, client.label);
  const result: ClientResult = { label: client.label, receipt, status: 'failed', emailed: false, warnings: [] };
  const sendsEmail = env.SEND_CLIENT_EMAILS && !options.dryRun;
  try {
    const bankDetails = config.bankDetails[client.currency];
    if (!bankDetails) throw new Error(`no bank details for ${client.currency}`);

    const matches = await deps.gateway.findInvoicesByReceipt(receipt);
    const existing = matches.find((invoice) => LIVE_STATUSES.has(invoice.status ?? 'issued'));
    const pending = Boolean(state.invoices[receipt]?.emailPending);
    if (!existing && matches.length > 0 && !options.reissue) {
      if (pending) updateInvoice(state, receipt, { emailPending: undefined });
      throw new Error(`this month's invoice is ${matches[0]?.status} in Razorpay; run with --reissue --only ${client.label} to issue a new one`);
    }
    // A failed email is retried, unless the client has paid in the meantime.
    const retry = Boolean(existing && pending && env.SEND_CLIENT_EMAILS && existing.status !== 'paid');
    if (existing && pending && existing.status === 'paid') updateInvoice(state, receipt, { emailPending: undefined });
    if (existing && !options.resend && !retry) {
      result.status = 'skipped';
      result.invoiceId = existing.id;
      return result;
    }

    // Checked before anything is created, so nothing is created for a client that cannot be emailed.
    const customer = await deps.gateway.fetchCustomer(client.customerId);
    const recipients = env.SEND_CLIENT_EMAILS ? recipientsOf(client, customer.email) : [];
    const ctx = { env, client, period, bankDetails, business: deps.business, receipt };

    let view: InvoiceView;
    if (existing) {
      result.invoiceId = existing.id;
      result.status = options.dryRun ? 'preview' : 'resent';
      view = viewFromInvoice(existing, ctx, options.dryRun ? 'preview' : undefined);
    } else if (options.dryRun) {
      result.status = 'preview';
      view = previewView(buildLineItems(client, period), customer, ctx, now);
    } else {
      const invoice = await deps.gateway.createInvoice(createBody(client, env, period, receipt));
      result.invoiceId = invoice.id;
      result.status = 'created';
      // Saved straight away: if anything below fails, the next run still sends the email.
      resetInvoice(state, receipt, { label: client.label, period: period.key, emailPending: env.SEND_CLIENT_EMAILS || undefined });
      await run.persist();
      view = viewFromInvoice(invoice, ctx);
    }
    result.total = view.total;
    if (view.billTo.addressLines.length === 0) {
      result.warnings.push('no buyer address on the PDF (MSEA needs it): add billTo in the clients file or a billing address in Razorpay');
    }

    result.pdf = { filename: `${receipt}.pdf`, content: await renderInvoicePdf(view, { fontPath: env.PDF_FONT_PATH }) };
    if (env.SAVE_OUTPUT) {
      const folder = join(env.OUTPUT_DIR, options.dryRun ? `${period.key}-preview` : period.key);
      await writePrivateFile(join(folder, result.pdf.filename), result.pdf.content).catch((error: unknown) => {
        result.warnings.push(`could not save the PDF to ${folder}: ${describeError(error)}`);
      });
    }

    if (sendsEmail) {
      if (!deps.mailer) throw new Error('email is not configured');
      updateInvoice(state, receipt, { label: client.label, period: period.key, emailPending: true });
      await deps.mailer.send({ to: recipients, cc: client.emailCc, ...clientInvoiceEmail(view), attachments: [result.pdf] });
      updateInvoice(state, receipt, { emailPending: undefined, emailAttempts: undefined, emailedAt: now.toISOString() });
      result.emailed = true;
    }
  } catch (error) {
    result.error = describeError(error);
    const record = state.invoices[receipt];
    if (sendsEmail && record?.emailPending) {
      const attempts = (record.emailAttempts ?? 0) + 1;
      const again = attempts < MAX_EMAIL_ATTEMPTS;
      updateInvoice(state, receipt, { emailAttempts: attempts, emailPending: again || undefined });
      result.emailRetry = again ? 'retrying' : 'gave-up';
    }
  }
  return result;
}

function createBody(client: Client, env: Env, period: Period, receipt: string): InvoiceCreateBody {
  return {
    type: 'invoice',
    customer_id: client.customerId,
    currency: client.currency,
    receipt,
    description: `Invoice for ${period.label}`,
    line_items: buildLineItems(client, period).map((item) => ({
      name: item.name,
      description: item.description,
      amount: item.unitAmount,
      currency: client.currency,
      quantity: item.quantity,
    })),
    email_notify: env.RAZORPAY_NOTIFY,
    sms_notify: env.RAZORPAY_NOTIFY,
    notes: { period: period.key, label: client.label, source: SOURCE_TAG },
  };
}

function outcomeOf(result: ClientResult): string {
  const base = {
    created: 'created',
    resent: 'resent',
    skipped: 'skipped (invoice already exists)',
    preview: 'preview only',
    failed: 'failed',
  }[result.status];
  const emailed = result.emailed ? ', emailed to client' : '';
  const error = result.error ? `${result.status === 'failed' ? ': ' : ', then failed: '}${result.error}` : '';
  const retry = result.emailRetry === 'retrying'
    ? ' (the email will be retried)'
    : result.emailRetry === 'gave-up'
      ? ` (gave up after ${MAX_EMAIL_ATTEMPTS} tries: fix it, then run "invoice --resend --only ${result.label}")`
      : '';
  return `${base}${emailed}${error}${retry}`;
}

function logResult(result: ClientResult): void {
  const line = `${result.label} ${result.receipt}${result.invoiceId ? ` ${result.invoiceId}` : ''}: ${outcomeOf(result)}`;
  if (result.error) log.error(line);
  else log.info(line);
  for (const warning of result.warnings) log.warn(`${result.label}: ${warning}`);
}

async function notifyOwner(report: RunReport, config: AppConfig, deps: RunDeps, options: RunOptions): Promise<void> {
  const owner = config.env.OWNER_EMAIL;
  if (!owner || !deps.mailer) return;
  const changed = report.results.some((result) => result.status === 'created' || result.status === 'resent' || result.error);
  // Catch-up runs where every invoice already exists stay quiet.
  if (options.dryRun ? !options.sendPreview : !changed) return;

  const rows: SummaryRow[] = report.results.map((result) => ({
    label: result.label,
    receipt: result.receipt,
    invoiceId: result.invoiceId,
    total: result.total,
    status: result.status,
    outcome: outcomeOf(result),
    failed: result.error !== undefined,
    warnings: result.warnings,
  }));
  try {
    await deps.mailer.send({
      to: [owner],
      ...ownerSummaryEmail({ period: report.period, dryRun: report.dryRun, rows }),
      attachments: report.results.flatMap((result) => (result.pdf ? [result.pdf] : [])),
    });
    report.ownerNotified = true;
    log.info('Summary emailed to the owner');
  } catch (error) {
    const message = `could not email the summary to the owner: ${describeError(error)}`;
    report.errors.push(message);
    log.error(message);
  }
}

/** Dry runs print amounts so they can be checked; real runs never log them. */
export function printPreview(report: RunReport, env: Env): void {
  const rows = report.results.map((result) => [result.label, result.receipt, result.total ?? '-', outcomeOf(result)]);
  const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => row[column]?.length ?? 0)));
  console.log(`\nPreview for ${report.period.label} (nothing was created in Razorpay or emailed to clients):`);
  for (const row of rows) {
    console.log(`  ${row.map((value, column) => (column < 3 ? value.padEnd(widths[column] ?? 0) : value)).join('   ')}`);
  }
  if (env.SAVE_OUTPUT) console.log(`\nPreview PDFs: ${join(env.OUTPUT_DIR, `${report.period.key}-preview`)}`);
}
