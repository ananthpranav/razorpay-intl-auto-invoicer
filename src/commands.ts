import { parseArgs, type ParseArgsConfig } from 'node:util';
import { parsePeriod } from './billing.ts';

export const USAGE = `Usage: npm run <command> -- [options]
       docker run ... <image> <command> [options]

Commands:
  start       Run the jobs on their schedules (the Docker default)
  invoice     Create this month's invoices and email them
  payments    Match payments to invoices, send receipts and reminders, retry failed emails
  report      Email last month's settlement report
  customers   List your Razorpay customers, or create one
  probe       Show what Razorpay returns for your account (read-only)
  init [dir]  Write editable .env, clients.json, bank-details.json and docker-compose.yml

invoice options:
  --dry-run          Check everything and render preview PDFs, without creating invoices or emailing clients
  --send-preview     Email the dry-run preview to OWNER_EMAIL (implies --dry-run)
  --period YYYY-MM   Bill this month instead of the one chosen by BILLING_PERIOD
  --only a,b         Only process these client labels
  --resend           Re-render and re-email invoices that already exist for the period
  --reissue          Create a new invoice where this month's invoice was cancelled in Razorpay

payments options:
  --dry-run                     Show what would happen, without recording anything or emailing anyone
  --match <payment>=<invoice>   Record that a payment belongs to an invoice, e.g. pay_XXXXXXXXXXXXXX=INV-202610-client-a

report options:
  --month YYYY-MM    Report on this month instead of last month

customers options:
  --create --name "Client name" [--email billing@client.example] [--contact +15551234567] [--currency USD]`;

const OPTIONS = {
  start: {},
  invoice: {
    'dry-run': { type: 'boolean' },
    'send-preview': { type: 'boolean' },
    period: { type: 'string' },
    only: { type: 'string' },
    resend: { type: 'boolean' },
    reissue: { type: 'boolean' },
  },
  payments: { 'dry-run': { type: 'boolean' }, match: { type: 'string' } },
  report: { month: { type: 'string' } },
  customers: {
    create: { type: 'boolean' },
    name: { type: 'string' },
    email: { type: 'string' },
    contact: { type: 'string' },
    currency: { type: 'string' },
  },
  probe: {},
  init: {},
} satisfies Record<string, ParseArgsConfig['options']>;

export type Command =
  | { name: 'start' }
  | {
    name: 'invoice';
    dryRun: boolean;
    sendPreview: boolean;
    resend: boolean;
    reissue: boolean;
    period?: string;
    only?: string[];
  }
  | { name: 'payments'; dryRun: boolean; match?: { paymentId: string; receipt: string } }
  | { name: 'report'; month?: string }
  | { name: 'customers'; create: boolean; customerName?: string; email?: string; contact?: string; currency?: string }
  | { name: 'probe' }
  | { name: 'init'; target: string };

export type Parsed = { ok: true; command: Command } | { ok: false; exitCode: number; output: string };

const fail = (output: string): Parsed => ({ ok: false, exitCode: 2, output });
const isKnown = (value: string): value is keyof typeof OPTIONS => Object.hasOwn(OPTIONS, value);

/** Turns command-line arguments into a command. Running with no command means "invoice". */
export function parseCommand(argv: string[]): Parsed {
  const [first = 'invoice', ...rest] = argv;
  if (['help', '-h', '--help'].includes(first) || rest.some((arg) => arg === '-h' || arg === '--help')) {
    return { ok: false, exitCode: 0, output: USAGE };
  }
  const name = first.startsWith('-') ? 'invoice' : first;
  const args = first.startsWith('-') ? argv : rest;
  if (!isKnown(name)) return fail(`Unknown command "${name}"\n\n${USAGE}`);

  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args, options: OPTIONS[name], allowPositionals: name === 'init' }) as {
      values: Record<string, string | boolean | undefined>;
      positionals: string[];
    });
  } catch (error) {
    return fail(`${(error as Error).message}\n\n${USAGE}`);
  }
  const text = (key: string) => (typeof values[key] === 'string' ? (values[key] as string) : undefined);
  const flag = (key: string) => values[key] === true;
  for (const key of ['period', 'month']) {
    const value = text(key);
    if (value === undefined) continue;
    try {
      parsePeriod(value);
    } catch (error) {
      return fail((error as Error).message);
    }
  }

  switch (name) {
    case 'start':
    case 'probe':
      return { ok: true, command: { name } };
    case 'init':
      if (positionals.length > 1) return fail(`init takes at most one directory\n\n${USAGE}`);
      return { ok: true, command: { name, target: positionals[0] ?? '.' } };
    case 'invoice':
      return {
        ok: true,
        command: {
          name,
          dryRun: flag('dry-run') || flag('send-preview'),
          sendPreview: flag('send-preview'),
          resend: flag('resend'),
          reissue: flag('reissue'),
          period: text('period'),
          only: text('only')?.split(',').map((label) => label.trim()).filter(Boolean),
        },
      };
    case 'payments': {
      const match = text('match');
      if (match === undefined) return { ok: true, command: { name, dryRun: flag('dry-run') } };
      const [paymentId = '', receipt = ''] = match.split('=').map((part) => part.trim());
      if (!/^pay_[A-Za-z0-9]+$/.test(paymentId) || !receipt) {
        return fail('--match expects <payment id>=<invoice number>, e.g. pay_XXXXXXXXXXXXXX=INV-202610-client-a');
      }
      return { ok: true, command: { name, dryRun: flag('dry-run'), match: { paymentId, receipt } } };
    }
    case 'report':
      return { ok: true, command: { name, month: text('month') } };
    case 'customers':
      return {
        ok: true,
        command: { name, create: flag('create'), customerName: text('name'), email: text('email'), contact: text('contact'), currency: text('currency') },
      };
  }
}
