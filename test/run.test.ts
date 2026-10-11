import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { ConfigError } from '../src/config.ts';
import { loadState, saveState } from '../src/state.ts';
import { exitCodeFor, retryFailedEmails, runInvoices, type RunOptions } from '../src/run.ts';
import { BUSINESS, FakeGateway, FakeMailer, makeConfig, NOV_1 } from './helpers.ts';

const live: RunOptions = { dryRun: false, resend: false, sendPreview: false, now: NOV_1 };

beforeEach(() => {
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});
});

function setup() {
  return { config: makeConfig(), gateway: new FakeGateway(), mailer: new FakeMailer() };
}

test('creates one invoice per client, emails each client and sends the owner one summary', async () => {
  const { config, gateway, mailer } = setup();
  const report = await runInvoices(config, { gateway, mailer, business: BUSINESS }, live);

  assert.deepEqual(report.results.map((result) => result.status), ['created', 'created', 'created']);
  assert.equal(exitCodeFor(report), 0);

  const [a, b, c] = gateway.created;
  assert.equal(a?.receipt, 'INV-202610-client-a');
  assert.equal(a?.customer_id, 'cust_XXXXXXXXXXXXXX');
  assert.equal(a?.currency, 'USD');
  assert.equal(a?.email_notify, false);
  assert.equal(a?.sms_notify, false);
  assert.deepEqual(a?.line_items.map((item) => [item.amount, item.quantity, item.currency]), [[2500, 140, 'USD']]);
  assert.deepEqual(b?.line_items.map((item) => [item.amount, item.quantity]), [[2500, 20]]);
  assert.deepEqual(c?.line_items.map((item) => [item.amount, item.quantity, item.currency]), [[25000, 1, 'GBP']]);
  assert.deepEqual(a?.notes, { period: '2026-10', label: 'client-a', source: 'razorpay-intl-auto-invoicer' });

  assert.equal(mailer.sent.length, 4);
  const toClientB = mailer.sent.find((email) => email.to.includes('accounts@example.com')); // emailTo override
  assert.equal(toClientB?.attachments?.[0]?.filename, 'INV-202610-client-b.pdf');
  assert.match(toClientB?.subject ?? '', /USD 500\.00/);
  assert.match(toClientB?.text ?? '', /Routing number \(ACH\): 000000000/);
  assert.match(toClientB?.text ?? '', /Payment reference: INV-202610-client-b/);
  const toClientC = mailer.sent.find((email) => email.to.includes('c@example.com'));
  assert.match(toClientC?.text ?? '', /Sort code: 00-00-00/);
  assert.match(toClientC?.text ?? '', /Due date: 1 Dec 2026/); // dueInDays: 30

  const summary = mailer.sent.at(-1);
  assert.deepEqual(summary?.to, ['owner@example.com']);
  assert.equal(summary?.attachments?.length, 3);
  assert.equal(summary?.subject, 'Invoices for October 2026: 3 created');
  assert.match(summary?.text ?? '', /\+ Add Details/);
});

test('running the same month again skips every client and emails nobody', async () => {
  const { config, gateway, mailer } = setup();
  await runInvoices(config, { gateway, mailer, business: BUSINESS }, live);
  const report = await runInvoices(config, { gateway, mailer, business: BUSINESS }, live);

  assert.deepEqual(report.results.map((result) => result.status), ['skipped', 'skipped', 'skipped']);
  assert.equal(gateway.created.length, 3);
  assert.equal(mailer.sent.length, 4);
  assert.equal(report.ownerNotified, false);
  assert.equal(exitCodeFor(report), 0);
});

test('a dry run creates nothing and emails nobody', async () => {
  const { config, gateway, mailer } = setup();
  const report = await runInvoices(config, { gateway, mailer, business: BUSINESS }, { ...live, dryRun: true });

  assert.deepEqual(report.results.map((result) => result.status), ['preview', 'preview', 'preview']);
  assert.deepEqual(report.results.map((result) => result.total), ['USD 3,500.00', 'USD 500.00', 'GBP 250.00']);
  assert.ok(report.results.every((result) => result.pdf?.content.subarray(0, 5).toString() === '%PDF-'));
  assert.equal(gateway.created.length, 0);
  assert.equal(mailer.sent.length, 0);
});

test('a dry run with --send-preview emails only the owner', async () => {
  const { config, gateway, mailer } = setup();
  await runInvoices(config, { gateway, mailer, business: BUSINESS }, { ...live, dryRun: true, sendPreview: true });

  assert.equal(gateway.created.length, 0);
  assert.equal(mailer.sent.length, 1);
  assert.deepEqual(mailer.sent[0]?.to, ['owner@example.com']);
  assert.equal(mailer.sent[0]?.subject, '[Preview] Invoices for October 2026: 3 preview');
  assert.equal(mailer.sent[0]?.attachments?.length, 3);
});

test('one failing client does not stop the others', async () => {
  const { config, gateway, mailer } = setup();
  gateway.customers.delete('cust_YYYYYYYYYYYYYY');
  const report = await runInvoices(config, { gateway, mailer, business: BUSINESS }, live);

  assert.deepEqual(report.results.map((result) => result.status), ['created', 'failed', 'created']);
  assert.equal(report.results[1]?.error, 'Razorpay API error 400: The id provided does not exist');
  assert.equal(gateway.created.length, 2);
  assert.equal(exitCodeFor(report), 1);
  const summary = mailer.sent.at(-1);
  assert.equal(summary?.subject, 'Invoices for October 2026: 2 created, 1 failed');
  assert.match(summary?.text ?? '', /failed client emails are sent again/);
});

test('an email failure after creating is reported, and --resend recovers it', async () => {
  const { config, gateway, mailer } = setup();
  mailer.failFor.add('a@example.com');
  const first = await runInvoices(config, { gateway, mailer, business: BUSINESS }, live);
  assert.equal(first.results[0]?.status, 'created');
  assert.equal(first.results[0]?.error, 'SMTP 550 mailbox unavailable');
  assert.equal(exitCodeFor(first), 1);

  mailer.failFor.clear();
  const retry = await runInvoices(config, { gateway, mailer, business: BUSINESS }, { ...live, resend: true, only: ['client-a'] });
  assert.equal(retry.results.length, 1);
  assert.equal(retry.results[0]?.status, 'resent');
  assert.equal(retry.results[0]?.emailed, true);
  assert.equal(gateway.created.length, 3); // nothing new was created
  assert.equal(exitCodeFor(retry), 0);
});

test('no invoice is created for a client without an email address', async () => {
  const { config, gateway, mailer } = setup();
  gateway.customers.set('cust_ZZZZZZZZZZZZZZ', { id: 'cust_ZZZZZZZZZZZZZZ', name: 'Third Client Ltd' });
  const report = await runInvoices(config, { gateway, mailer, business: BUSINESS }, live);

  assert.equal(report.results[2]?.status, 'failed');
  assert.match(report.results[2]?.error ?? '', /no recipient email/);
  assert.ok(gateway.created.every((body) => body.customer_id !== 'cust_ZZZZZZZZZZZZZZ'));
});

test('warns when a PDF has no buyer address', async () => {
  const { config, gateway, mailer } = setup();
  const report = await runInvoices(config, { gateway, mailer, business: BUSINESS }, live);

  assert.deepEqual(report.results[0]?.warnings, []); // client-a has billTo
  assert.match(report.results[1]?.warnings[0] ?? '', /no buyer address/);
});

test('--only rejects unknown labels', async () => {
  const { config, gateway, mailer } = setup();
  await assert.rejects(runInvoices(config, { gateway, mailer, business: BUSINESS }, { ...live, only: ['nope'] }), ConfigError);
  assert.equal(gateway.created.length, 0);
});

test('without a mailer the run still creates invoices and reports the missing email setup', async () => {
  const { config, gateway } = setup();
  const report = await runInvoices(config, { gateway, business: BUSINESS }, live);
  assert.ok(report.results.every((result) => result.status === 'created' && result.error === 'email is not configured'));
});

test('a failed client email is retried on the next run, and only once', async () => {
  const { config, gateway, mailer } = setup();
  const deps = { gateway, mailer, business: BUSINESS };
  mailer.failFor.add('a@example.com');
  const first = await runInvoices(config, deps, live);
  assert.match(first.results[0]?.error ?? '', /SMTP 550/);
  assert.match(mailer.sent.at(-1)?.text ?? '', /the email will be retried/);

  mailer.failFor.clear();
  mailer.sent = [];
  const rerun = await runInvoices(config, deps, live);
  assert.deepEqual(rerun.results.map((result) => result.status), ['resent', 'skipped', 'skipped']);
  assert.equal(mailer.sent.filter((email) => email.to.includes('a@example.com')).length, 1);

  const third = await runInvoices(config, deps, live);
  assert.deepEqual(third.results.map((result) => result.status), ['skipped', 'skipped', 'skipped']);
  assert.equal(gateway.created.length, 3);
});

test('the daily retry re-sends failed emails without creating invoices', async () => {
  const { config, gateway, mailer } = setup();
  const deps = { gateway, mailer, business: BUSINESS };
  mailer.failFor.add('c@example.com');
  await runInvoices(config, deps, live);
  mailer.failFor.clear();

  const reports = await retryFailedEmails(config, deps, new Date('2026-11-02T04:30:00Z'));
  assert.deepEqual(reports.map((report) => [report.period.key, report.results.map((result) => [result.label, result.status])]),
    [['2026-10', [['client-c', 'resent']]]]);
  assert.equal(gateway.created.length, 3);
  assert.deepEqual(await retryFailedEmails(config, deps), []);
});

test('a cancelled invoice is never re-sent, and is only replaced with --reissue', async () => {
  const { config, gateway, mailer } = setup();
  const deps = { gateway, mailer, business: BUSINESS };
  await runInvoices(config, deps, live);
  (gateway.invoices[0] as unknown as { status: string }).status = 'cancelled';
  mailer.sent = [];

  const resend = await runInvoices(config, deps, { ...live, resend: true, only: ['client-a'] });
  assert.equal(resend.results[0]?.status, 'failed');
  assert.match(resend.results[0]?.error ?? '', /cancelled in Razorpay; run with --reissue --only client-a/);
  assert.equal(mailer.sent.filter((email) => email.to.includes('a@example.com')).length, 0);

  const reissue = await runInvoices(config, deps, { ...live, reissue: true, only: ['client-a'] });
  assert.equal(reissue.results[0]?.status, 'created');
  assert.equal(gateway.created.length, 4);
});

test('an invoice whose PDF fails after it was created is still emailed on the next run', async () => {
  const { config, gateway, mailer } = setup();
  const broken = { ...config, env: { ...config.env, PDF_FONT_PATH: '/nonexistent/font.ttf' } };
  const first = await runInvoices(broken, { gateway, mailer, business: BUSINESS }, { ...live, only: ['client-a'] });
  assert.equal(first.results[0]?.status, 'created');
  assert.ok(first.results[0]?.error);

  mailer.sent = [];
  const next = await runInvoices(config, { gateway, mailer, business: BUSINESS }, { ...live, only: ['client-a'] });
  assert.equal(next.results[0]?.status, 'resent');
  assert.equal(mailer.sent.filter((email) => email.to.includes('a@example.com')).length, 1);
  assert.equal(gateway.created.length, 1);
});

test('gives up on a client email after 4 tries', async () => {
  const { config, gateway, mailer } = setup();
  const deps = { gateway, mailer, business: BUSINESS };
  mailer.failFor.add('a@example.com');
  const outcomes = [];
  for (let run = 0; run < 5; run++) {
    const report = await runInvoices(config, deps, { ...live, only: ['client-a'] });
    outcomes.push(`${report.results[0]?.status}/${report.results[0]?.emailRetry ?? '-'}`);
  }
  assert.deepEqual(outcomes, ['created/retrying', 'resent/retrying', 'resent/retrying', 'resent/gave-up', 'skipped/-']);
  assert.match(mailer.sent.at(-1)?.text ?? '', /gave up after 4 tries/);
});

test('a retry never re-sends an invoice the client has paid', async () => {
  const { config, gateway, mailer } = setup();
  const deps = { gateway, mailer, business: BUSINESS };
  mailer.failFor.add('a@example.com');
  await runInvoices(config, deps, live);
  mailer.failFor.clear();
  mailer.sent = [];
  (gateway.invoices[0] as unknown as { status: string }).status = 'paid';

  const report = await runInvoices(config, deps, live);
  assert.equal(report.results[0]?.status, 'skipped');
  assert.equal(mailer.sent.length, 0);
  assert.equal((await loadState(config.env.STATE_PATH)).invoices['INV-202610-client-a']?.emailPending, undefined);
});

test('a re-issued invoice starts with a clean record', async () => {
  const { config, gateway, mailer } = setup();
  const deps = { gateway, mailer, business: BUSINESS };
  await runInvoices(config, deps, live);
  const state = await loadState(config.env.STATE_PATH);
  state.invoices['INV-202610-client-a'] = { ...state.invoices['INV-202610-client-a']!, remindersSent: [3], receiptSentAt: '2026-11-20T00:00:00.000Z' };
  await saveState(config.env.STATE_PATH, state);
  (gateway.invoices[0] as unknown as { status: string }).status = 'cancelled';

  await runInvoices(config, deps, { ...live, reissue: true, only: ['client-a'] });
  const record = (await loadState(config.env.STATE_PATH)).invoices['INV-202610-client-a'];
  assert.deepEqual(record?.remindersSent, []);
  assert.equal(record?.receiptSentAt, undefined);
  assert.ok(record?.emailedAt);
});
