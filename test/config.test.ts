import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { checkBankDetails, ConfigError, loadConfig, loadEnv, parseBankDetails, parseClients, recipientsOf } from '../src/config.ts';
import { makeEnv, readExample } from './helpers.ts';

const base = { RAZORPAY_KEY_ID: 'rzp_test_FAKEKEY', RAZORPAY_KEY_SECRET: 'fake-secret', BUSINESS_NAME: 'Example Studio' };
const client = { label: 'client-a', customerId: 'cust_XXXXXXXXXXXXXX', currency: 'USD', items: [{ type: 'fixed', name: 'Retainer', amount: 100 }] };

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected a ConfigError');
}

test('the shipped example files are valid', () => {
  const clients = parseClients(readExample('clients.example.json'));
  const bankDetails = parseBankDetails(readExample('bank-details.example.json'));
  assert.doesNotThrow(() => checkBankDetails(clients, bankDetails));
});

test('.env.example parses and fills in sensible values', () => {
  const values = parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));
  const env = loadEnv({ ...values, RAZORPAY_KEY_SECRET: 'fake-secret' });
  assert.equal(env.BUSINESS_NAME, undefined); // read from Razorpay unless set
  assert.equal(env.EMAIL_FROM, 'Your Name <billing@example.com>');
  assert.equal(env.INVOICE_SCHEDULE, '0 9 1 * *');
  assert.equal(env.PAYMENT_CHECK_SCHEDULE, '0 10 * * *');
  assert.equal(env.RAZORPAY_NOTIFY, false);
  assert.equal(env.SEND_PAYMENT_RECEIPTS, false);
  assert.equal(env.SEND_REMINDERS, false);
  assert.deepEqual(env.REMINDER_DAYS, [3, 10]);
  assert.equal(env.DUE_IN_DAYS, 15);
});

test('environment defaults', () => {
  const env = loadEnv({ ...base, SEND_CLIENT_EMAILS: 'false' });
  assert.equal(env.BILLING_PERIOD, 'previous');
  assert.equal(env.RECEIPT_PREFIX, 'INV');
  assert.equal(env.INVOICE_TIMEZONE, 'Asia/Kolkata');
  assert.equal(env.INVOICE_SCHEDULE, '0 9 1 * *');
  assert.equal(env.CATCH_UP_DAYS, 3);
  assert.equal(env.SAVE_OUTPUT, true);
  assert.equal(env.DUE_IN_DAYS, undefined);
});

test('reports every missing required variable', () => {
  const error = configError(() => loadEnv({}));
  assert.deepEqual(error.details, ['RAZORPAY_KEY_ID: is required', 'RAZORPAY_KEY_SECRET: is required']);
});

test('requires SMTP settings only when emails are sent', () => {
  const error = configError(() => loadEnv({ ...base, SEND_CLIENT_EMAILS: 'true' }));
  assert.ok(error.details.some((detail) => detail.startsWith('SMTP_HOST: is required')));
  assert.ok(error.details.some((detail) => detail.startsWith('EMAIL_FROM: is required')));
  assert.doesNotThrow(() => loadEnv({ ...base, SEND_CLIENT_EMAILS: 'false' }));
});

test('rejects invalid values', () => {
  const error = configError(() =>
    loadEnv({ ...base, SEND_CLIENT_EMAILS: 'yes', RAZORPAY_KEY_ID: 'key', INVOICE_TIMEZONE: 'Mars/Base', RECEIPT_PREFIX: 'IN-V' }));
  const fields = error.details.map((detail) => detail.split(':')[0]);
  assert.deepEqual(fields.sort(), ['INVOICE_TIMEZONE', 'RAZORPAY_KEY_ID', 'RECEIPT_PREFIX', 'SEND_CLIENT_EMAILS']);
});

test('empty values count as not set', () => {
  const env = makeEnv({ DUE_IN_DAYS: '', BUSINESS_TAX_INFO: '   ' });
  assert.equal(env.DUE_IN_DAYS, undefined);
  assert.equal(env.BUSINESS_TAX_INFO, undefined);
});

test('rejects duplicate labels', () => {
  const error = configError(() => parseClients([client, { ...client, customerId: 'cust_YYYYYYYYYYYYYY' }]));
  assert.deepEqual(error.details, ['clients[1].label: duplicate label "client-a"']);
});

test('the same customer can have several invoices under different labels', () => {
  assert.equal(parseClients([client, { ...client, label: 'client-a-project-2' }]).length, 2);
});

test('rejects bad customer ids and misspelled fields', () => {
  const error = configError(() => parseClients([{
    ...client,
    customerId: '12345',
    items: [{ type: 'hourly', name: 'Dev', rate: 25, hour: 140 }],
  }]));
  assert.ok(error.details.some((detail) => detail.startsWith('clients[0].customerId: must be a Razorpay customer id')));
  assert.ok(error.details.some((detail) => detail.startsWith('clients[0].items[0]')));
});

test('accepts only 2-decimal currencies and normalises the code', () => {
  for (const currency of ['JPY', 'KWD', 'XYZ']) {
    const error = configError(() => parseClients([{ ...client, currency }]));
    assert.match(error.details[0] ?? '', /^clients\[0\]\.currency/);
  }
  assert.equal(parseClients([{ ...client, currency: 'gbp' }])[0]?.currency, 'GBP');
});

test('rejects amounts with more than 2 decimals', () => {
  const error = configError(() => parseClients([{ ...client, items: [{ type: 'hourly', name: 'Dev', rate: 25.005, hours: 1 }] }]));
  assert.deepEqual(error.details, ['clients[0].items[0].rate: use at most 2 decimal places']);
});

test('every enabled client currency needs bank details', () => {
  const clients = parseClients([client, { ...client, label: 'eu-client', currency: 'EUR' }, { ...client, label: 'old', currency: 'AUD', enabled: false }]);
  const bankDetails = parseBankDetails({ USD: { title: 'Bank transfer', fields: [{ label: 'Account', value: '000' }] } });
  const error = configError(() => checkBankDetails(clients, bankDetails));
  assert.deepEqual(error.details, ['bank-details: add an entry for EUR (an enabled client is billed in it)']);
});

test('invalid JSON errors never echo the file contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invoicer-test-'));
  const path = join(dir, 'clients.json');
  writeFileSync(path, '[{ "label": "client-a", "secret": "TOPSECRET-123" oops }]');
  const error = configError(() => loadConfig(makeEnv({ CLIENTS_DATA_PATH: path })));
  assert.match(error.message, /is not valid JSON/);
  assert.doesNotMatch(error.message, /TOPSECRET/);
});

test('a missing data file is reported with its path', () => {
  const error = configError(() => loadConfig(makeEnv({ CLIENTS_DATA_PATH: '/nonexistent/clients.json' })));
  assert.equal(error.message, 'Cannot read the clients file at /nonexistent/clients.json (ENOENT)');
});

test('parses reminder days and the account ID', () => {
  const env = loadEnv({ ...base, SEND_CLIENT_EMAILS: 'false', REMINDER_DAYS: '10, 3,3', RAZORPAY_ACCOUNT_ID: 'AAAAAAAAAAAAAA' });
  assert.deepEqual(env.REMINDER_DAYS, [3, 10]);
  assert.equal(env.RAZORPAY_ACCOUNT_ID, 'acc_AAAAAAAAAAAAAA');
  assert.deepEqual(loadEnv({ ...base, SEND_CLIENT_EMAILS: 'false' }).REMINDER_DAYS, [3, 10]);
  const error = configError(() => loadEnv({ ...base, SEND_CLIENT_EMAILS: 'false', REMINDER_DAYS: 'three' }));
  assert.match(error.details[0] ?? '', /^REMINDER_DAYS: /);
});

test('client receipts and reminders also need SMTP settings', () => {
  const error = configError(() => loadEnv({ ...base, SEND_CLIENT_EMAILS: 'false', SEND_REMINDERS: 'true' }));
  assert.ok(error.details.some((detail) => detail.startsWith('SMTP_HOST: is required')));
});

test('helper commands work without email settings', () => {
  assert.doesNotThrow(() => loadEnv({ ...base }, { requireEmailSettings: false }));
});

test('only sends to a single, valid address taken from Razorpay', () => {
  const [plain] = parseClients([client]);
  assert.deepEqual(recipientsOf(plain!, 'ap@example.com'), ['ap@example.com']);
  assert.throws(() => recipientsOf(plain!, 'ap@example.com, someone@else.example'), /not a single valid address/);
  assert.throws(() => recipientsOf(plain!, undefined), /no recipient email/);
  const [explicit] = parseClients([{ ...client, emailTo: ['billing@example.com'] }]);
  assert.deepEqual(recipientsOf(explicit!, 'bad, value'), ['billing@example.com']);
});
