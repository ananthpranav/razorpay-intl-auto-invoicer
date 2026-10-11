import { join } from 'node:path';
import { formatMoney, resolvePeriod, type Period } from './billing.ts';
import type { AppConfig } from './config.ts';
import { settlementReportEmail, type Mailer } from './email.ts';
import { writePrivateFile } from './files.ts';
import { log } from './log.ts';
import { describeError, type RazorpayGateway, type ReconItem } from './razorpay.ts';
import { loadState, type State } from './state.ts';
import { isoDay } from './text.ts';

export interface SettlementReport {
  period: Period;
  lines: number;
  csv: string;
  currency: string;
  totals: { settledPayments: number; credited: number; debited: number; fees: number; tax: number };
  savedTo?: string;
  emailed: boolean;
  errors: string[];
}

const COLUMNS = ['Settled on', 'Type', 'Razorpay ID', 'Invoice no.', 'Currency', 'Amount', 'Fee', 'GST on fee', 'Credit', 'Debit', 'Settlement ID', 'Settlement UTR'];

/** Last month's settlements from Razorpay's reconciliation API, as a CSV for your books, emailed to OWNER_EMAIL. */
export async function runSettlementReport(
  config: AppConfig,
  deps: { gateway: Pick<RazorpayGateway, 'settlementRecon'>; mailer?: Mailer },
  options: { month?: string; now?: Date },
): Promise<SettlementReport> {
  const { env } = config;
  const period = resolvePeriod(options.now ?? new Date(), env.INVOICE_TIMEZONE, 'previous', options.month);
  const [year, month] = period.key.split('-').map(Number) as [number, number];
  const items = (await deps.gateway.settlementRecon(year, month))
    .sort((a, b) => (a.settled_at ?? a.created_at) - (b.settled_at ?? b.created_at));
  const state = await loadState(env.STATE_PATH);
  const currency = items[0]?.currency ?? 'INR';
  const report: SettlementReport = {
    period,
    lines: items.length,
    csv: toCsv(items, state, env.INVOICE_TIMEZONE),
    currency,
    totals: {
      settledPayments: items.filter((item) => item.type === 'payment' && item.settled).length,
      credited: sum(items, 'credit'),
      debited: sum(items, 'debit'),
      fees: sum(items, 'fee'),
      tax: sum(items, 'tax'),
    },
    emailed: false,
    errors: [],
  };
  log.info(`Settlement report for ${period.label}: ${items.length} line(s)`);
  if (items.length === 0) return report;

  const filename = `settlements-${period.key}.csv`;
  if (env.SAVE_OUTPUT) {
    const path = join(env.OUTPUT_DIR, 'reports', filename);
    try {
      await writePrivateFile(path, report.csv);
      report.savedTo = path;
    } catch (error) {
      report.errors.push(`could not save the report to ${path}: ${describeError(error)}`);
    }
  }
  if (env.OWNER_EMAIL && deps.mailer) {
    try {
      const content = settlementReportEmail({
        period,
        settledPayments: report.totals.settledPayments,
        credited: formatMoney(report.totals.credited, currency),
        fees: formatMoney(report.totals.fees, currency),
        tax: formatMoney(report.totals.tax, currency),
      });
      await deps.mailer.send({
        to: [env.OWNER_EMAIL],
        ...content,
        attachments: [{ filename, content: Buffer.from(report.csv), contentType: 'text/csv' }],
      });
      report.emailed = true;
      log.info('Settlement report emailed to the owner');
    } catch (error) {
      report.errors.push(`could not email the settlement report: ${describeError(error)}`);
    }
  }
  return report;
}

export function toCsv(items: ReconItem[], state: State, timeZone: string): string {
  const money = (minor: number | string) => (Number(minor) / 100).toFixed(2);
  const rows = items.map((item) => [
    cell(item.settled_at ? isoDay(new Date(item.settled_at * 1000), timeZone) : ''),
    cell(item.type),
    cell(item.entity_id),
    cell(state.payments[item.entity_id]?.receipt ?? ''),
    cell(item.currency),
    money(item.amount),
    money(item.fee),
    money(item.tax),
    money(item.credit),
    money(item.debit),
    cell(item.settlement_id ?? ''),
    cell(item.settlement_utr ?? ''),
  ].join(','));
  return `${[COLUMNS.join(','), ...rows].join('\r\n')}\r\n`;
}

/** Quotes a text cell when needed and stops spreadsheets from running it as a formula. */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function sum(items: ReconItem[], key: 'credit' | 'debit' | 'fee' | 'tax'): number {
  return items.reduce((total, item) => total + Number(item[key] ?? 0), 0);
}
