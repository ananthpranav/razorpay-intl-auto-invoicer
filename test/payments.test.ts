import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { beforeEach, mock, test } from 'node:test';
import { ConfigError, parseClients, type Client } from '../src/config.ts';
import { matchPayment, type TrackedInvoice } from '../src/matching.ts';
import { runPaymentCheck } from '../src/payments.ts';
import type { Invoice } from '../src/razorpay.ts';
import { runInvoices } from '../src/run.ts';
import { loadState } from '../src/state.ts';
import { BUSINESS, FakeGateway, FakeMailer, makeConfig, makePayment, NOV_1 } from './helpers.ts';

beforeEach(() => {
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});
});

// Checks run at 17:30 in India, after the test payments (06:00 UTC on 5 Nov) arrive.
const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

// ── matchPayment ─────────────────────────────────────────────────────────────

function tracked(label: string, currency: string, amountDue: number, overrides: Partial<TrackedInvoice> = {}): TrackedInvoice {
  const [client] = parseClients([{ label, customerId: 'cust_AAAAAAAAAAAAAA', currency, items: [{ type: 'fixed', name: 'Work', amount: 1 }] }]);
  return {
    receipt: `INV-202610-${label}`,
    invoice: { id: `inv_${label}` } as Invoice,
    client: client as Client,
    currency,
    amountDue,
    issuedAt: NOV_1,
    paid: false,
    ...overrides,
  };
}

test('matches by the invoice number in the transfer reference, however it is written', () => {
  const open = [tracked('client-a', 'USD', 350000), tracked('client-b', 'USD', 50000)];
  for (const reference of ['INV-202610-client-a', 'inv202610clienta', 'Ref: INV 202610 CLIENT A'.replace(/ /g, '')]) {
    const result = matchPayment(makePayment({ amount: 349000, currency: 'USD', notes: { reference } }), open);
    assert.equal(result.kind, 'matched', reference);
    assert.equal(result.kind === 'matched' && result.invoice.receipt, 'INV-202610-client-a');
    assert.equal(result.kind === 'matched' && result.basis, 'reference');
  }
});

test('a similar invoice number does not count as a reference', () => {
  const open = [tracked('client-a', 'USD', 350000), tracked('client-ab', 'USD', 350000)];
  const result = matchPayment(makePayment({ amount: 350000, currency: 'USD', description: 'INV-202610-client-ab' } as never), open);
  assert.equal(result.kind === 'matched' && result.invoice.receipt, 'INV-202610-client-ab');
});

test('falls back to the only open invoice with the exact amount', () => {
  const open = [tracked('client-a', 'USD', 350000), tracked('client-b', 'USD', 50000), tracked('client-c', 'GBP', 50000)];
  const result = matchPayment(makePayment({ amount: 50000, currency: 'USD' }), open);
  assert.equal(result.kind === 'matched' && result.invoice.receipt, 'INV-202610-client-b');
  assert.equal(result.kind === 'matched' && result.basis, 'amount');
});

test('leaves ambiguous and unknown payments to the owner', () => {
  const open = [tracked('client-a', 'USD', 50000), tracked('client-b', 'USD', 50000), tracked('client-c', 'USD', 350000)];
  const ambiguous = matchPayment(makePayment({ amount: 50000, currency: 'USD' }), open);
  assert.equal(ambiguous.kind, 'ambiguous');

  const unmatched = matchPayment(makePayment({ amount: 345000, currency: 'USD' }), open);
  assert.equal(unmatched.kind, 'unmatched');
  assert.equal(unmatched.kind === 'unmatched' && unmatched.candidates[0]?.receipt, 'INV-202610-client-c');
});

test('ignores other currencies and invoices issued after the payment', () => {
  const later = tracked('client-a', 'USD', 50000, { issuedAt: new Date('2026-12-01T00:00:00Z') });
  assert.equal(matchPayment(makePayment({ amount: 50000, currency: 'EUR' }), [tracked('client-b', 'USD', 50000)]).kind, 'unmatched');
  assert.equal(matchPayment(makePayment({ amount: 50000, currency: 'USD' }), [later]).kind, 'unmatched');
});

test('a payment made through the invoice link always matches that invoice', () => {
  const invoice = tracked('client-a', 'USD', 350000, { paid: true });
  const result = matchPayment(makePayment({ amount: 1, currency: 'USD', invoice_id: 'inv_client-a' }), [], [invoice]);
  assert.equal(result.kind === 'matched' && result.basis, 'invoice_link');
});

// ── runPaymentCheck ──────────────────────────────────────────────────────────

/** Invoices October for the three example clients, then runs the first (baseline) payment check. */
async function invoicedMonth(envOverrides: Record<string, string> = {}) {
  const config = makeConfig(envOverrides);
  const gateway = new FakeGateway();
  const mailer = new FakeMailer();
  await runInvoices(config, { gateway, mailer, business: BUSINESS }, { dryRun: false, resend: false, sendPreview: false, now: NOV_1 });
  await runPaymentCheck(config, { gateway, mailer, business: BUSINESS }, { dryRun: false, now: day('2026-11-02') });
  mailer.sent = [];
  return { config, gateway, mailer, deps: { gateway, mailer, business: BUSINESS } };
}

test('the first check only records existing payments', async () => {
  const config = makeConfig({ SEND_PAYMENT_RECEIPTS: 'true', SEND_REMINDERS: 'true' });
  const gateway = new FakeGateway();
  const mailer = new FakeMailer();
  await runInvoices(config, { gateway, mailer, business: BUSINESS }, { dryRun: false, resend: false, sendPreview: false, now: NOV_1 });
  mailer.sent = [];
  gateway.payments.push(makePayment({ amount: 350000, currency: 'USD', status: 'captured', notes: { ref: 'INV-202610-client-a' } }));

  const report = await runPaymentCheck(config, { gateway, mailer, business: BUSINESS }, { dryRun: false, now: day('2026-11-20') });
  assert.equal(report.baseline, true);
  assert.equal(report.matched.length, 1);
  assert.equal(report.receipts.length, 0);
  assert.equal(report.reminders.length, 0); // client-b is overdue, but reminders start with the next check
  assert.deepEqual(mailer.sent.map((email) => email.to), [['owner@example.com']]);
  assert.match(mailer.sent[0]?.text ?? '', /First payment check/);

  const state = await loadState(config.env.STATE_PATH);
  assert.ok(state.initializedAt);
  assert.equal(Object.values(state.payments)[0]?.receiptSkipped, true);
});

test('a new transfer is matched and the owner gets the PDF to upload', async () => {
  const { gateway, mailer, deps, config } = await invoicedMonth();
  gateway.payments.push(makePayment({ amount: 350000, currency: 'USD', notes: { transfer_reference: 'INV-202610-client-a' } }));

  const report = await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-05') });
  assert.equal(report.matched[0]?.invoice.receipt, 'INV-202610-client-a');
  assert.equal(mailer.sent.length, 1);
  const digest = mailer.sent[0];
  assert.deepEqual(digest?.to, ['owner@example.com']);
  assert.equal(digest?.subject, '[Action needed] Payments update: 1 matched');
  assert.match(digest?.text ?? '', /USD 3,500\.00 received 5 Nov 2026/);
  assert.match(digest?.text ?? '', /Buyer: Example Corp, 100 Example Street, San Francisco, CA 94105, United States/);
  assert.deepEqual(digest?.attachments?.map((file) => file.filename), ['INV-202610-client-a.pdf']);
});

test('the client gets one receipt once Razorpay captures the payment', async () => {
  const { gateway, mailer, deps, config } = await invoicedMonth({ SEND_PAYMENT_RECEIPTS: 'true' });
  const payment = makePayment({ amount: 350000, currency: 'USD', notes: { ref: 'INV-202610-client-a' } });
  gateway.payments.push(payment);
  await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-05') });
  mailer.sent = [];

  (payment as { status: string }).status = 'captured';
  const report = await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-06') });
  assert.equal(report.receipts.length, 1);
  const receipt = mailer.sent.find((email) => email.to.includes('a@example.com'));
  assert.equal(receipt?.subject, 'Payment received for invoice INV-202610-client-a');
  assert.match(receipt?.text ?? '', /We received your payment of USD 3,500\.00/);
  assert.equal(receipt?.attachments?.[0]?.filename, 'INV-202610-client-a-paid.pdf');

  mailer.sent = [];
  const again = await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-07') });
  assert.equal(again.receipts.length, 0);
  assert.equal(mailer.sent.length, 0);
});

test('receipts stay off by default and are never sent late', async () => {
  const { gateway, mailer, deps, config } = await invoicedMonth();
  gateway.payments.push(makePayment({ amount: 350000, currency: 'USD', status: 'captured', notes: { ref: 'INV-202610-client-a' } }));
  await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-05') });
  assert.ok(mailer.sent.every((email) => email.to.includes('owner@example.com')));

  mailer.sent = [];
  const enabled = { ...config, env: { ...config.env, SEND_PAYMENT_RECEIPTS: true } };
  const report = await runPaymentCheck(enabled, deps, { dryRun: false, now: day('2026-11-06') });
  assert.equal(report.receipts.length, 0);
});

test('overdue invoices get one reminder per step, and paid ones none', async () => {
  const { gateway, mailer, deps, config } = await invoicedMonth({ SEND_REMINDERS: 'true' });
  gateway.payments.push(makePayment({ amount: 350000, currency: 'USD', notes: { ref: 'INV-202610-client-a' } }));

  // Due 16 Nov (15 days). 19 Nov is 3 days overdue: the first reminder. client-c is due on 1 Dec.
  const first = await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-19') });
  assert.deepEqual(first.reminders.map((item) => [item.invoice.receipt, item.daysOverdue]), [['INV-202610-client-b', 3]]);
  const reminder = mailer.sent.find((email) => email.to.includes('accounts@example.com'));
  assert.equal(reminder?.subject, 'Reminder: invoice INV-202610-client-b (USD 500.00) was due on 16 Nov 2026');
  assert.match(reminder?.text ?? '', /Routing number \(ACH\): 000000000/);

  const sameDay = await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-19') });
  assert.equal(sameDay.reminders.length, 0);

  const second = await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-26') });
  assert.deepEqual(second.reminders.map((item) => item.daysOverdue), [10]);
});

test('a reminder that was not sent on time is not sent weeks later', async () => {
  const { deps, config } = await invoicedMonth({ SEND_REMINDERS: 'true' });
  const report = await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-12-20') }); // 34 days overdue
  assert.deepEqual(report.reminders.map((item) => item.invoice.receipt), []);
});

test('unmatched payments are reported once and can be matched by hand', async () => {
  const { gateway, mailer, deps, config } = await invoicedMonth({ SEND_PAYMENT_RECEIPTS: 'true' });
  const payment = makePayment({ amount: 24500, currency: 'GBP', status: 'captured' });
  gateway.payments.push(payment);

  const first = await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-05') });
  assert.equal(first.unmatched.length, 1);
  assert.match(mailer.sent[0]?.text ?? '', new RegExp(`--match ${payment.id}=<invoice number>`));
  assert.match(mailer.sent[0]?.text ?? '', /Possible invoices: INV-202610-client-c \(GBP 250\.00\)/);

  mailer.sent = [];
  const quiet = await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-06') });
  assert.equal(quiet.unmatched.length, 0);

  const manual = await runPaymentCheck(config, deps, {
    dryRun: false,
    now: day('2026-11-06'),
    match: { paymentId: payment.id, receipt: 'INV-202610-client-c' },
  });
  assert.equal(manual.receipts[0]?.invoice.receipt, 'INV-202610-client-c');
  assert.ok(mailer.sent.some((email) => email.to.includes('c@example.com') && email.subject.startsWith('Payment received')));
});

test('a dry run records nothing and emails nobody', async () => {
  const config = makeConfig({ SEND_PAYMENT_RECEIPTS: 'true' });
  const gateway = new FakeGateway();
  const mailer = new FakeMailer();
  await runInvoices(config, { gateway, mailer, business: BUSINESS }, { dryRun: false, resend: false, sendPreview: false, now: NOV_1 });
  mailer.sent = [];
  gateway.payments.push(makePayment({ amount: 350000, currency: 'USD', notes: { ref: 'INV-202610-client-a' } }));

  const before = readFileSync(config.env.STATE_PATH, 'utf8');
  const report = await runPaymentCheck(config, { gateway, mailer, business: BUSINESS }, { dryRun: true, now: day('2026-11-05') });
  assert.equal(report.matched.length, 1);
  assert.equal(mailer.sent.length, 0);
  assert.equal(readFileSync(config.env.STATE_PATH, 'utf8'), before);
});

test('refuses an unknown invoice number for --match', async () => {
  const { deps, config } = await invoicedMonth();
  await assert.rejects(
    runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-05'), match: { paymentId: 'pay_X', receipt: 'INV-209901-nope' } }),
    ConfigError,
  );
});

test('a damaged state file stops the check instead of starting over', async () => {
  const { deps, config } = await invoicedMonth();
  writeFileSync(config.env.STATE_PATH, '{ not json');
  await assert.rejects(runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-05') }), /not valid JSON/);
});

test('repeating a manual match never sends a second receipt', async () => {
  const { gateway, mailer, deps, config } = await invoicedMonth({ SEND_PAYMENT_RECEIPTS: 'true' });
  const payment = makePayment({ amount: 350000, currency: 'USD', status: 'captured', notes: { ref: 'INV-202610-client-a' } });
  gateway.payments.push(payment);
  await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-06') });
  const match = { paymentId: payment.id, receipt: 'INV-202610-client-a' };
  await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-07'), match });
  await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-08'), match });
  assert.equal(mailer.sent.filter((email) => email.subject.startsWith('Payment received')).length, 1);
});

test('a manual match takes the invoice away from a wrongly matched payment', async () => {
  const { gateway, mailer, deps, config } = await invoicedMonth({ SEND_PAYMENT_RECEIPTS: 'true' });
  const wrong = makePayment({ amount: 50000, currency: 'USD', status: 'captured' }); // matched to client-b by amount
  const right = makePayment({ amount: 49000, currency: 'USD', status: 'captured' });
  gateway.payments.push(wrong, right);
  await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-06') });
  await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-07'), match: { paymentId: right.id, receipt: 'INV-202610-client-b' } });

  const state = await loadState(config.env.STATE_PATH);
  assert.equal(state.invoices['INV-202610-client-b']?.paymentId, right.id);
  assert.equal(state.payments[wrong.id]?.status, 'unmatched');
  assert.equal(mailer.sent.filter((email) => email.subject === 'Payment received for invoice INV-202610-client-b').length, 1);
});

test('a payment that fails later reopens its invoice', async () => {
  const { gateway, mailer, deps, config } = await invoicedMonth({ SEND_REMINDERS: 'true' });
  const attempt = makePayment({ amount: 50000, currency: 'USD', invoice_id: gateway.invoices[1]!.id });
  gateway.payments.push(attempt);
  await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-06') });
  mailer.sent = [];

  (attempt as { status: string }).status = 'failed';
  const report = await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-19') });
  assert.deepEqual(report.reopened.map((item) => item.receipt), ['INV-202610-client-b']);
  assert.ok(report.reminders.some((item) => item.invoice.receipt === 'INV-202610-client-b')); // chased again
  assert.match(mailer.sent.find((email) => email.to.includes('owner@example.com'))?.text ?? '', /counts as unpaid again/);
});

test('a failed state save stops the check instead of sending more emails', async () => {
  const { gateway, mailer, deps, config } = await invoicedMonth({ SEND_PAYMENT_RECEIPTS: 'true' });
  gateway.payments.push(
    makePayment({ amount: 350000, currency: 'USD', status: 'captured', notes: { ref: 'INV-202610-client-a' } }),
    makePayment({ amount: 25000, currency: 'GBP', status: 'captured', notes: { ref: 'INV-202610-client-c' } }),
  );
  const folder = dirname(config.env.STATE_PATH);
  mailer.onSend = () => chmodSync(folder, 0o500);
  try {
    await assert.rejects(runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-06') }), /EACCES|permission/i);
  } finally {
    chmodSync(folder, 0o700);
  }
  assert.equal(mailer.sent.length, 1);
});

test('a match by amount alone waits for your confirmation before any receipt', async () => {
  const { gateway, mailer, deps, config } = await invoicedMonth({ SEND_PAYMENT_RECEIPTS: 'true' });
  const payment = makePayment({ amount: 50000, currency: 'USD', status: 'captured' });
  gateway.payments.push(payment);
  const report = await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-06') });
  assert.equal(report.matched[0]?.basis, 'amount');
  assert.equal(report.receipts.length, 0);
  assert.match(mailer.sent[0]?.text ?? '', /confirm it with --match/);

  const confirmed = await runPaymentCheck(config, deps, {
    dryRun: false,
    now: day('2026-11-07'),
    match: { paymentId: payment.id, receipt: 'INV-202610-client-b' },
  });
  assert.equal(confirmed.receipts[0]?.invoice.receipt, 'INV-202610-client-b');
});

test('a second payment on an already paid invoice is left to you', async () => {
  const { gateway, deps, config } = await invoicedMonth();
  const invoiceId = gateway.invoices[1]!.id;
  const first = makePayment({ amount: 50000, currency: 'USD', invoice_id: invoiceId });
  const second = makePayment({ amount: 50000, currency: 'USD', invoice_id: invoiceId });
  gateway.payments.push(first, second);
  const report = await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-06') });

  assert.deepEqual(report.matched.map((item) => item.payment.id), [first.id]);
  assert.deepEqual(report.unmatched.map((item) => item.payment.id), [second.id]);
  assert.equal((await loadState(config.env.STATE_PATH)).invoices['INV-202610-client-b']?.paymentId, first.id);
});

test('refuses to record a payment it has never seen', async () => {
  const { deps, config } = await invoicedMonth();
  await assert.rejects(
    runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-06'), match: { paymentId: 'pay_TYPO', receipt: 'INV-202610-client-a' } }),
    /Unknown payment pay_TYPO/,
  );
});

test('after a payment is moved to another invoice, the first invoice can still get its receipt', async () => {
  const { gateway, mailer, deps, config } = await invoicedMonth({ SEND_PAYMENT_RECEIPTS: 'true' });
  const misfiled = makePayment({ amount: 50000, currency: 'USD', status: 'captured', notes: { ref: 'INV-202610-client-b' } });
  gateway.payments.push(misfiled);
  await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-06') });
  await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-07'), match: { paymentId: misfiled.id, receipt: 'INV-202610-client-a' } });

  mailer.sent = [];
  gateway.payments.push(makePayment({
    amount: 50000, currency: 'USD', status: 'captured', notes: { ref: 'INV-202610-client-b' }, created_at: day('2026-11-07').getTime() / 1000,
  }));
  const report = await runPaymentCheck(config, deps, { dryRun: false, now: day('2026-11-08') });
  assert.deepEqual(report.receipts.map((item) => item.invoice.receipt), ['INV-202610-client-b']);
});
