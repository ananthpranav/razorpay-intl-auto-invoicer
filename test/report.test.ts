import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, mock, test } from 'node:test';
import type { ReconItem } from '../src/razorpay.ts';
import { runSettlementReport } from '../src/report.ts';
import { saveState } from '../src/state.ts';
import { FakeGateway, FakeMailer, makeConfig, NOV_1, tempDir } from './helpers.ts';

beforeEach(() => {
  mock.method(console, 'log', () => {});
});

function recon(fields: Partial<ReconItem>): ReconItem {
  return {
    entity_id: 'pay_TEST0000000001',
    type: 'payment',
    debit: 0,
    credit: 29071000,
    amount: 29500000,
    currency: 'INR',
    fee: 360000,
    tax: 64800,
    settled: true,
    settled_at: new Date('2026-10-07T04:00:00Z').getTime() / 1000,
    created_at: new Date('2026-10-05T04:00:00Z').getTime() / 1000,
    settlement_id: 'setl_TEST00000001',
    settlement_utr: 'UTR0000001',
    ...fields,
  };
}

test('emails last month\'s settlements as a CSV with totals and a FIRS reminder', async () => {
  const output = tempDir();
  const config = makeConfig({ SAVE_OUTPUT: 'true', OUTPUT_DIR: output });
  await saveState(config.env.STATE_PATH, {
    version: 1,
    payments: { pay_TEST0000000001: { status: 'matched', receipt: 'INV-202609-client-a', seenAt: '2026-10-05T00:00:00.000Z' } },
    invoices: {},
  });
  const gateway = new FakeGateway();
  gateway.recon = [
    recon({ entity_id: 'pay_TEST0000000002', credit: 4113000, amount: 4200000, fee: 73700, tax: 13300, settled_at: new Date('2026-10-20T04:00:00Z').getTime() / 1000 }),
    recon({}),
    recon({ entity_id: 'rfnd_TEST000000001', type: 'refund', credit: 0, debit: 100000, amount: 100000, fee: 0, tax: 0, settlement_utr: '=HYPERLINK("x")' }),
  ];
  const mailer = new FakeMailer();

  const report = await runSettlementReport(config, { gateway, mailer }, { now: NOV_1 });
  assert.equal(report.period.key, '2026-10');
  assert.deepEqual(report.totals, { settledPayments: 2, credited: 33184000, debited: 100000, fees: 433700, tax: 78100 });

  const lines = report.csv.trim().split('\r\n');
  assert.equal(lines[0], 'Settled on,Type,Razorpay ID,Invoice no.,Currency,Amount,Fee,GST on fee,Credit,Debit,Settlement ID,Settlement UTR');
  assert.equal(lines[1], '2026-10-07,payment,pay_TEST0000000001,INV-202609-client-a,INR,295000.00,3600.00,648.00,290710.00,0.00,setl_TEST00000001,UTR0000001');
  assert.equal(lines[2]?.split(',').at(-1), '"\'=HYPERLINK(""x"")"'); // neutralised formula
  assert.equal(lines[3]?.slice(0, 10), '2026-10-20');

  const email = mailer.sent[0];
  assert.deepEqual(email?.to, ['owner@example.com']);
  assert.equal(email?.subject, 'Razorpay settlements for October 2026: INR 331,840.00 credited');
  assert.match(email?.text ?? '', /FIRS/);
  assert.deepEqual(email?.attachments?.map((file) => [file.filename, file.contentType]), [['settlements-2026-10.csv', 'text/csv']]);

  const saved = join(output, 'reports', 'settlements-2026-10.csv');
  assert.equal(report.savedTo, saved);
  assert.equal(readFileSync(saved, 'utf8'), report.csv);
  assert.equal(statSync(saved).mode & 0o777, 0o600);
});

test('stays quiet for a month without settlements', async () => {
  const mailer = new FakeMailer();
  const report = await runSettlementReport(makeConfig(), { gateway: new FakeGateway(), mailer }, { month: '2026-09' });
  assert.equal(report.period.label, 'September 2026');
  assert.equal(report.lines, 0);
  assert.equal(mailer.sent.length, 0);
});
