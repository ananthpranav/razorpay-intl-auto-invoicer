import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLineItems, formatMoney, makePeriod, parsePeriod, receiptFor, resolvePeriod, toMinor } from '../src/billing.ts';
import { parseClients } from '../src/config.ts';
import { NOV_1, readExample } from './helpers.ts';

const october = makePeriod(2026, 10);

test('bills the previous month in the configured time zone', () => {
  const period = resolvePeriod(NOV_1, 'Asia/Kolkata', 'previous');
  assert.deepEqual(period, { key: '2026-10', compact: '202610', label: 'October 2026' });
});

test('a January run bills December of the previous year', () => {
  assert.equal(resolvePeriod(new Date('2027-01-01T04:00:00Z'), 'Asia/Kolkata', 'previous').key, '2026-12');
});

test('the time zone decides which day it is', () => {
  const now = new Date('2026-10-31T20:00:00Z'); // already 1 Nov 01:30 in India, still 31 Oct in UTC
  assert.equal(resolvePeriod(now, 'Asia/Kolkata', 'previous').key, '2026-10');
  assert.equal(resolvePeriod(now, 'UTC', 'previous').key, '2026-09');
});

test('current-month billing and an explicit period', () => {
  assert.equal(resolvePeriod(NOV_1, 'Asia/Kolkata', 'current').key, '2026-11');
  assert.equal(resolvePeriod(NOV_1, 'Asia/Kolkata', 'previous', '2025-03').label, 'March 2025');
});

test('rejects malformed periods', () => {
  for (const value of ['2026-13', '2026-00', '26-10', '2026-1', '2026/10']) {
    assert.throws(() => parsePeriod(value), /expected YYYY-MM/);
  }
});

test('receipts are deterministic', () => {
  assert.equal(receiptFor('INV', october, 'client-a'), 'INV-202610-client-a');
});

test('converts amounts to minor units without floating-point drift', () => {
  assert.equal(toMinor(25), 2500);
  assert.equal(toMinor(3500), 350000);
  assert.equal(toMinor(19.99), 1999);
  assert.equal(toMinor(0.1 + 0.2), 30);
  for (const bad of [1.005, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => toMinor(bad), /at most 2 decimal places/);
  }
});

test('formats money with the currency code', () => {
  assert.equal(formatMoney(350000, 'USD'), 'USD 3,500.00');
  assert.equal(formatMoney(1999, 'GBP'), 'GBP 19.99');
});

test('example clients total USD 3,500, USD 500 and GBP 250', () => {
  const clients = parseClients(readExample('clients.example.json'));
  const totals = clients.map((client) => buildLineItems(client, october).reduce((sum, item) => sum + item.totalAmount, 0));
  assert.deepEqual(totals, [350000, 50000, 25000]);

  const [hourly] = buildLineItems(clients[0]!, october);
  assert.deepEqual(hourly, {
    name: 'Software development services',
    description: '140 hours at USD 25.00/hour, October 2026',
    quantity: 140,
    unitAmount: 2500,
    totalAmount: 350000,
  });
  const [fixed] = buildLineItems(clients[2]!, october);
  assert.deepEqual(fixed, { name: 'Monthly retainer', description: 'October 2026', quantity: 1, unitAmount: 25000, totalAmount: 25000 });
});

test('fractional hours are billed as one line, because Razorpay quantities are whole numbers', () => {
  const [client] = parseClients([{
    label: 'part-time',
    customerId: 'cust_AAAAAAAAAAAAAA',
    currency: 'USD',
    items: [{ type: 'hourly', name: 'Consulting', rate: 25, hours: 140.5 }],
  }]);
  assert.deepEqual(buildLineItems(client!, october), [{
    name: 'Consulting',
    description: '140.5 hours at USD 25.00/hour, October 2026',
    quantity: 1,
    unitAmount: 351250,
    totalAmount: 351250,
  }]);
});

test('custom descriptions fill known placeholders and keep unknown ones', () => {
  const [client] = parseClients([{
    label: 'custom',
    customerId: 'cust_AAAAAAAAAAAAAA',
    currency: 'EUR',
    items: [{ type: 'fixed', name: 'Retainer', amount: 100, description: 'Retainer for {period} {unknown}' }],
  }]);
  assert.equal(buildLineItems(client!, october)[0]?.description, 'Retainer for October 2026 {unknown}');
});
