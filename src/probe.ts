import { DAY_MS, formatMoney, resolvePeriod } from './billing.ts';
import type { Env } from './config.ts';
import { describeError, notesOf, type Payment, type RazorpayGateway } from './razorpay.ts';
import { formatDay } from './text.ts';


/**
 * Read-only check of what Razorpay returns for your account: which business details are available,
 * how incoming payments (including MoneySaver transfers) look, and whether settlements can be read.
 * Prints field names and payment details, never customer emails or phone numbers.
 */
export async function probe(
  env: Env,
  gateway: Pick<RazorpayGateway, 'fetchBranding' | 'fetchAccount' | 'listPayments' | 'settlementRecon'>,
  now = new Date(),
): Promise<void> {
  const say = (line = '') => console.log(line);
  say(`Razorpay ${env.RAZORPAY_KEY_ID.startsWith('rzp_live_') ? 'live' : 'test'} mode. Read-only: nothing is changed.`);

  say('\nBusiness details');
  try {
    const branding = await gateway.fetchBranding();
    say(`  Checkout branding: name ${quote(branding.name)}, brand name ${quote(branding.brandName)}, logo ${branding.logoUrl ? 'yes' : 'no'}`);
  } catch (error) {
    say(`  Checkout branding: failed (${describeError(error)})`);
  }
  if (!env.RAZORPAY_ACCOUNT_ID) {
    say('  Accounts API: skipped. Set RAZORPAY_ACCOUNT_ID to try reading your address and GSTIN from Razorpay.');
  } else {
    try {
      const account = await gateway.fetchAccount(env.RAZORPAY_ACCOUNT_ID);
      const has = (label: string, value: unknown) => `${label}: ${value ? 'yes' : 'no'}`;
      say(`  Accounts API: works. ${[
        has('legal name', account.legal_business_name),
        has('registered address', account.profile?.addresses?.registered?.street1),
        has('email', account.email),
        has('GSTIN', account.legal_info?.gst),
      ].join(', ')}`);
    } catch (error) {
      say(`  Accounts API: refused (${describeError(error)}). Set the BUSINESS_* values in .env instead.`);
    }
  }

  say('\nPayments in the last 60 days');
  try {
    describePayments(await gateway.listPayments(new Date(now.getTime() - 60 * DAY_MS), now), env.INVOICE_TIMEZONE, say);
  } catch (error) {
    say(`  could not be read (${describeError(error)})`);
  }

  const lastMonth = resolvePeriod(now, env.INVOICE_TIMEZONE, 'previous');
  const [year, month] = lastMonth.key.split('-').map(Number) as [number, number];
  try {
    const items = await gateway.settlementRecon(year, month);
    say(`\nSettlements in ${lastMonth.label}: ${items.length} line(s) available for the settlement report`);
  } catch (error) {
    say(`\nSettlements in ${lastMonth.label}: could not be read (${describeError(error)})`);
  }
  say('\nNext: "npm run payments -- --dry-run" shows how these payments match your invoices.');
}

function describePayments(payments: Payment[], timeZone: string, say: (line: string) => void): void {
  const groups = new Map<string, number>();
  for (const payment of payments) {
    const key = `${payment.method}/${payment.status}/${payment.currency}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  say(`  ${payments.length} payment(s)${groups.size ? `: ${[...groups].map(([key, count]) => `${count} x ${key}`).join(', ')}` : ''}`);
  const foreign = payments.filter((payment) => payment.currency !== 'INR');
  for (const payment of foreign.slice(0, 15)) {
    say(`  ${formatDay(new Date(payment.created_at * 1000), timeZone)}  ${payment.id}  method=${payment.method}  status=${payment.status}  ${
      formatMoney(Number(payment.amount), payment.currency)}${payment.invoice_id ? `  invoice=${payment.invoice_id}` : ''}`);
  }
  if (foreign.length === 0) {
    say('  No foreign-currency payments yet. Run this again after a client pays by bank transfer.');
    return;
  }
  say(`  Fields on these payments: ${[...new Set(foreign.flatMap((payment) => Object.keys(payment)))].sort().join(', ')}`);
  say(`  Note keys: ${[...new Set(foreign.flatMap((payment) => Object.keys(notesOf(payment))))].join(', ') || 'none'}. With a description: ${
    foreign.filter((payment) => (payment as { description?: unknown }).description).length} of ${foreign.length}.`);
}

function quote(value: string | undefined): string {
  return value ? `"${value}"` : '(none)';
}
