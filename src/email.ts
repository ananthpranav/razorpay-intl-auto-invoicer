import nodemailer from 'nodemailer';
import type { Period } from './billing.ts';
import type { Env } from './config.ts';
import type { InvoiceView } from './view.ts';

export interface Attachment {
  filename: string;
  content: Buffer;
  contentType?: string; // defaults to application/pdf
}

export interface OutgoingEmail {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html: string;
  attachments?: Attachment[];
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<void>;
}

export function createSmtpMailer(env: Env): Mailer {
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTLS: !env.SMTP_SECURE && env.SMTP_REQUIRE_TLS, // never send the password unencrypted on port 587
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return {
    async send(email) {
      await transport.sendMail({
        from: env.EMAIL_FROM,
        replyTo: env.EMAIL_REPLY_TO,
        to: email.to,
        cc: email.cc,
        subject: email.subject,
        text: email.text,
        html: email.html,
        attachments: email.attachments?.map((file) => ({ ...file, contentType: file.contentType ?? 'application/pdf' })),
      });
    },
  };
}

type Content = Pick<OutgoingEmail, 'subject' | 'text' | 'html'>;

// ── Client emails ────────────────────────────────────────────────────────────

export function clientInvoiceEmail(view: InvoiceView): Content {
  const text = [
    `Hello ${view.billTo.name ?? 'there'},`,
    '',
    `Please find attached invoice ${view.number} for ${view.period}.`,
    '',
    `Amount due: ${view.total}`,
    ...(view.dueDate ? [`Due date: ${view.dueDate}`] : []),
    '',
    ...paymentText(view),
    '',
    'Thank you,',
    view.seller.name,
  ].join('\n');

  const html = page([
    `<p>Hello ${esc(view.billTo.name ?? 'there')},</p>`,
    `<p>Please find attached invoice <strong>${esc(view.number)}</strong> for ${esc(view.period)}.</p>`,
    table([
      ['Amount due', `<strong>${esc(view.total)}</strong>`],
      ...(view.dueDate ? [['Due date', esc(view.dueDate)]] : []),
    ]),
    paymentHtml(view),
    `<p>Thank you,<br>${esc(view.seller.name)}</p>`,
  ]);

  return { subject: `Invoice ${view.number} for ${view.period} (${view.total})`, text, html };
}

export function paymentReceiptEmail(view: InvoiceView, payment: { amount: string; receivedOn: string }): Content {
  const line = `We received your payment of ${payment.amount} for invoice ${view.number} (${view.period}) on ${payment.receivedOn}. Thank you.`;
  const text = [
    `Hello ${view.billTo.name ?? 'there'},`,
    '',
    line,
    '',
    'A copy of the invoice marked as paid is attached for your records.',
    '',
    'Best regards,',
    view.seller.name,
  ].join('\n');
  const html = page([
    `<p>Hello ${esc(view.billTo.name ?? 'there')},</p>`,
    `<p>${esc(line)}</p>`,
    '<p>A copy of the invoice marked as paid is attached for your records.</p>',
    `<p>Best regards,<br>${esc(view.seller.name)}</p>`,
  ]);
  return { subject: `Payment received for invoice ${view.number}`, text, html };
}

export function paymentReminderEmail(view: InvoiceView): Content {
  const line = `This is a friendly reminder that invoice ${view.number} for ${view.period} (${view.total}) was due on ${view.dueDate ?? 'its due date'}.`;
  const paid = 'If you have already paid, thank you, and please ignore this email.';
  const text = [
    `Hello ${view.billTo.name ?? 'there'},`,
    '',
    line,
    paid,
    '',
    ...paymentText(view),
    '',
    'The invoice is attached again for convenience.',
    '',
    'Thank you,',
    view.seller.name,
  ].join('\n');
  const html = page([
    `<p>Hello ${esc(view.billTo.name ?? 'there')},</p>`,
    `<p>${esc(line)}<br>${esc(paid)}</p>`,
    paymentHtml(view),
    '<p>The invoice is attached again for convenience.</p>',
    `<p>Thank you,<br>${esc(view.seller.name)}</p>`,
  ]);
  return { subject: `Reminder: invoice ${view.number} (${view.total}) was due on ${view.dueDate ?? 'its due date'}`, text, html };
}

function paymentText(view: InvoiceView): string[] {
  const { payment } = view;
  return [
    payment.title,
    ...[...payment.fields, { label: 'Payment reference', value: payment.reference }].map((row) => `  ${row.label}: ${row.value}`),
    ...(payment.note ? ['', payment.note] : []),
  ];
}

function paymentHtml(view: InvoiceView): string {
  const { payment } = view;
  const rows = [...payment.fields, { label: 'Payment reference', value: payment.reference }];
  return [
    `<h3 style="margin:24px 0 8px;font-size:15px">${esc(payment.title)}</h3>`,
    table(rows.map((row) => [esc(row.label), `<strong>${esc(row.value)}</strong>`])),
    payment.note ? `<p style="color:#59636e">${esc(payment.note)}</p>` : '',
  ].join('');
}

// ── Owner emails ─────────────────────────────────────────────────────────────

export interface SummaryRow {
  label: string;
  receipt: string;
  invoiceId?: string;
  total?: string;
  status: string; // created | resent | skipped | preview | failed
  outcome: string; // human-readable result
  failed: boolean;
  warnings: string[];
}

const MSEA_STEPS =
  'In the Razorpay Dashboard, open Transactions, filter by "Pending Actions" and click "+ Add Details" on the transfer. ' +
  'Upload the matching invoice PDF and add the buyer\'s address. Razorpay settles the payment only after that.';

export function ownerSummaryEmail(summary: { period: Period; dryRun: boolean; rows: SummaryRow[] }): Content {
  const { period, dryRun, rows } = summary;
  const failed = rows.filter((row) => row.failed).length;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.failed ? 'failed' : row.status;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const countText = [...counts].map(([key, count]) => `${count} ${key}`).join(', ');
  const intro = dryRun
    ? `Preview of the invoice run for ${period.label}. Nothing was created in Razorpay and no client was emailed.`
    : `Invoice run for ${period.label}.`;
  const warnings = rows.flatMap((row) => row.warnings.map((warning) => `${row.label}: ${warning}`));
  const reminder = `When a client's transfer arrives in your MoneySaver Export Account: ${MSEA_STEPS}`;

  const text = [
    intro,
    '',
    ...rows.map((row) => [row.label, row.receipt, row.invoiceId ?? '-', row.total ?? '-', row.outcome].join('  |  ')),
    ...(warnings.length ? ['', 'Warnings:', ...warnings.map((warning) => `- ${warning}`)] : []),
    ...(failed ? ['', 'Fix the problem and run the invoices again: existing invoices are skipped and failed client emails are sent again. While the scheduler runs, it also retries failed emails every day, up to 4 tries.'] : []),
    '',
    reminder,
  ].join('\n');

  const html = page([
    `<p>${esc(intro)}</p>`,
    dataTable(
      ['Client', 'Invoice no.', 'Razorpay ID', 'Amount', 'Result'],
      rows.map((row) => [row.label, row.receipt, row.invoiceId ?? '-', row.total ?? '-', row.outcome]),
      rows.map((row) => row.failed),
    ),
    list('Warnings', warnings),
    failed ? '<p>Fix the problem and run the invoices again: existing invoices are skipped and failed client emails are sent again. While the scheduler runs, it also retries failed emails every day, up to 4 tries.</p>' : '',
    `<p style="color:#59636e">${esc(reminder)}</p>`,
  ]);

  const prefix = dryRun ? '[Preview] ' : '';
  return { subject: `${prefix}Invoices for ${period.label}: ${countText || 'nothing to do'}`, text, html };
}

export interface DigestMatch {
  label: string;
  receipt: string;
  paymentId: string;
  amount: string;
  receivedOn: string;
  basis: string; // how it was matched, in words
  captured: boolean;
  buyer: string[]; // name and address to paste into "+ Add Details"
}

export interface DigestUnmatched {
  paymentId: string;
  amount: string;
  receivedOn: string;
  ambiguous: boolean;
  candidates: Array<{ receipt: string; total: string }>;
}

export interface PaymentDigest {
  baseline: boolean;
  matched: DigestMatch[];
  unmatched: DigestUnmatched[];
  reopened: string[];
  receipts: string[];
  reminders: string[];
  errors: string[];
}

export function paymentDigestEmail(digest: PaymentDigest): Content {
  const actionNeeded = digest.matched.filter((match) => !match.captured).length + digest.unmatched.length + digest.reopened.length;
  const parts: string[] = [];
  if (digest.matched.length) parts.push(`${digest.matched.length} matched`);
  if (digest.unmatched.length) parts.push(`${digest.unmatched.length} unmatched`);
  if (digest.reopened.length) parts.push(`${digest.reopened.length} failed or refunded`);
  if (digest.receipts.length) parts.push(`${digest.receipts.length} receipt(s) sent`);
  if (digest.reminders.length) parts.push(`${digest.reminders.length} reminder(s) sent`);
  if (digest.errors.length) parts.push(`${digest.errors.length} error(s)`);

  const notes = digest.baseline
    ? ['First payment check: existing payments were recorded. Client receipts and reminders start with the next check.']
    : [];
  const matchText = (match: DigestMatch) => [
    `${match.amount} received ${match.receivedOn} (${match.paymentId}) -> ${match.receipt} (${match.label}), ${match.basis}.`,
    match.captured
      ? '  Already captured by Razorpay: no action needed.'
      : `  Action needed: ${MSEA_STEPS} The PDF is attached. Buyer: ${match.buyer.join(', ') || 'no address on file'}`,
  ];
  const unmatchedText = (item: DigestUnmatched) => [
    `${item.amount} received ${item.receivedOn} (${item.paymentId}): ${item.ambiguous ? 'several invoices have this amount' : 'no invoice matches'}.`,
    ...(item.candidates.length ? [`  Possible invoices: ${item.candidates.map((c) => `${c.receipt} (${c.total})`).join(', ')}`] : []),
    `  If it belongs to an invoice, record it: npm run payments -- --match ${item.paymentId}=<invoice number>`,
  ];

  const text = [
    ...notes,
    ...(notes.length ? [''] : []),
    ...(digest.matched.length ? ['Payments matched to invoices:', ...digest.matched.flatMap(matchText), ''] : []),
    ...(digest.unmatched.length ? ['Payments that need your attention:', ...digest.unmatched.flatMap(unmatchedText), ''] : []),
    ...(digest.reopened.length ? ['Payments that failed or were refunded:', ...digest.reopened.map((line) => `- ${line}`), ''] : []),
    ...(digest.receipts.length ? ['Receipts sent to clients:', ...digest.receipts.map((line) => `- ${line}`), ''] : []),
    ...(digest.reminders.length ? ['Reminders sent to clients:', ...digest.reminders.map((line) => `- ${line}`), ''] : []),
    ...(digest.errors.length ? ['Errors:', ...digest.errors.map((line) => `- ${line}`)] : []),
  ].join('\n').trim();

  const html = page([
    ...notes.map((note) => `<p style="color:#59636e">${esc(note)}</p>`),
    digest.matched.length
      ? `<h3 style="font-size:15px">Payments matched to invoices</h3>${digest.matched.map((match) => `<p>${esc(matchText(match)[0] ?? '')}<br>${
        match.captured
          ? 'Already captured by Razorpay: no action needed.'
          : `<strong>Action needed:</strong> ${esc(MSEA_STEPS)} The PDF is attached.<br>Buyer: ${esc(match.buyer.join(', ') || 'no address on file')}`
      }</p>`).join('')}`
      : '',
    digest.unmatched.length
      ? `<h3 style="font-size:15px">Payments that need your attention</h3>${digest.unmatched.map((item) =>
        `<p>${unmatchedText(item).map(esc).join('<br>')}</p>`).join('')}`
      : '',
    list('Payments that failed or were refunded', digest.reopened),
    list('Receipts sent to clients', digest.receipts),
    list('Reminders sent to clients', digest.reminders),
    list('Errors', digest.errors),
  ]);

  const prefix = actionNeeded ? '[Action needed] ' : '';
  return { subject: `${prefix}Payments update: ${parts.join(', ') || 'nothing new'}`, text, html };
}

export function settlementReportEmail(report: {
  period: Period;
  settledPayments: number;
  credited: string;
  fees: string;
  tax: string;
}): Content {
  const firs =
    `Remember to download ${report.period.label}'s FIRS certificates from the Razorpay Dashboard: Account & Settings, ` +
    'International payment settings, Foreign inward remittance statement (FIRS). Razorpay has no API for them.';
  const rows: Array<[string, string]> = [
    ['Settled payments', String(report.settledPayments)],
    ['Credited to your bank', report.credited],
    ['Razorpay fees', report.fees],
    ['GST on fees', report.tax],
  ];
  const text = [
    `Razorpay settlements for ${report.period.label}. The full list is attached as a CSV.`,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    firs,
  ].join('\n');
  const html = page([
    `<p>Razorpay settlements for ${esc(report.period.label)}. The full list is attached as a CSV.</p>`,
    table(rows.map(([label, value]) => [esc(label), `<strong>${esc(value)}</strong>`])),
    `<p style="color:#59636e">${esc(firs)}</p>`,
  ]);
  return { subject: `Razorpay settlements for ${report.period.label}: ${report.credited} credited`, text, html };
}

export function failureAlertEmail(message: string, details: string[]): Content {
  const intro = 'The automated invoicing job failed. Fix the problem below and run it again (finished work is not repeated).';
  const text = [intro, '', message, ...details.map((detail) => `- ${detail}`)].join('\n');
  const html = page([`<p>${esc(intro)}</p>`, `<p><strong>${esc(message)}</strong></p>`, list('', details)]);
  return { subject: 'Invoicing job failed', text, html };
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

function page(parts: string[]): string {
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#1f2328;line-height:1.5">${parts.join('')}</div>`;
}

function table(rows: string[][]): string {
  return `<table style="border-collapse:collapse">${rows
    .map(([label, value]) => `<tr><td style="padding:2px 16px 2px 0;color:#59636e">${label}</td><td style="padding:2px 0">${value}</td></tr>`)
    .join('')}</table>`;
}

function dataTable(headings: string[], rows: string[][], highlight: boolean[]): string {
  const cell = 'padding:6px 10px;border-bottom:1px solid #d1d9e0;text-align:left';
  const head = headings.map((heading) => `<th style="${cell};color:#59636e">${esc(heading)}</th>`).join('');
  const body = rows.map((row, index) => `<tr>${row.map((value, column) =>
    `<td style="${cell}${column === row.length - 1 && highlight[index] ? ';color:#cf222e' : ''}">${esc(value)}</td>`).join('')}</tr>`).join('');
  return `<table style="border-collapse:collapse;font-size:13px"><tr>${head}</tr>${body}</table>`;
}

function list(title: string, items: string[]): string {
  if (items.length === 0) return '';
  return `${title ? `<p><strong>${esc(title)}</strong></p>` : ''}<ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
