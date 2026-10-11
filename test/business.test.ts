import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkImage, downloadLogo, resolveBusinessProfile } from '../src/business.ts';
import { ConfigError } from '../src/config.ts';
import type { Account } from '../src/razorpay.ts';
import { FakeGateway, makeEnv, PNG_1X1, tempDir } from './helpers.ts';


const account = {
  legal_business_name: 'Example Studio Private Limited',
  email: 'accounts@studio.example',
  profile: { addresses: { registered: { street1: '12 Example Road', street2: 'Indiranagar', city: 'Bengaluru', state: 'Karnataka', postal_code: '560038', country: 'in' } } },
  legal_info: { gst: '29AAAAA0000A1Z5' },
} as unknown as Account;

test('uses the name Razorpay Checkout shows when .env has none', async () => {
  const profile = await resolveBusinessProfile(makeEnv({ SHOW_LOGO: 'false' }), new FakeGateway(), () => {});
  assert.deepEqual(profile, { name: 'Example Studio Pvt Ltd', lines: [], logo: undefined });
});

test('reads address, email and GSTIN from the Accounts API when it is allowed', async () => {
  const gateway = new FakeGateway();
  gateway.account = account;
  const profile = await resolveBusinessProfile(makeEnv({ RAZORPAY_ACCOUNT_ID: 'AAAAAAAAAAAAAA', SHOW_LOGO: 'false' }), gateway, () => {});
  assert.equal(profile.name, 'Example Studio Private Limited');
  assert.deepEqual(profile.lines, [
    '12 Example Road',
    'Indiranagar',
    'Bengaluru, Karnataka 560038',
    'IN',
    'accounts@studio.example',
    'GSTIN: 29AAAAA0000A1Z5',
  ]);
});

test('values in .env win over Razorpay', async () => {
  const gateway = new FakeGateway();
  gateway.account = account;
  const env = makeEnv({
    RAZORPAY_ACCOUNT_ID: 'acc_AAAAAAAAAAAAAA',
    BUSINESS_NAME: 'Studio Trading Name',
    BUSINESS_ADDRESS: 'PO Box 1\\nBengaluru',
    BUSINESS_TAX_INFO: 'IEC: 0000000000',
    SHOW_LOGO: 'false',
  });
  const profile = await resolveBusinessProfile(env, gateway, () => {});
  assert.deepEqual(profile.lines, ['PO Box 1', 'Bengaluru', 'accounts@studio.example', 'IEC: 0000000000']);
  assert.equal(profile.name, 'Studio Trading Name');
});

test('falls back to .env with a warning when Razorpay refuses the Accounts API', async () => {
  const warnings: string[] = [];
  const env = makeEnv({ RAZORPAY_ACCOUNT_ID: 'acc_AAAAAAAAAAAAAA', BUSINESS_EMAIL: 'billing@example.com', SHOW_LOGO: 'false' });
  const profile = await resolveBusinessProfile(env, new FakeGateway(), (message) => warnings.push(message));
  assert.deepEqual(profile.lines, ['billing@example.com']);
  assert.deepEqual(warnings, ["could not read your account details from Razorpay's Accounts API: Razorpay API error 401: Access Denied"]);
});

test('asks for BUSINESS_NAME when Razorpay has no name either', async () => {
  const gateway = new FakeGateway();
  gateway.branding = {};
  await assert.rejects(resolveBusinessProfile(makeEnv({ SHOW_LOGO: 'false' }), gateway, () => {}), ConfigError);
});

test('uses a local logo file and checks it is an image', async () => {
  const dir = tempDir();
  const png = join(dir, 'logo.png');
  const gif = join(dir, 'logo.gif');
  writeFileSync(png, PNG_1X1);
  writeFileSync(gif, Buffer.from('GIF89a'));
  const profile = await resolveBusinessProfile(makeEnv({ BUSINESS_LOGO_PATH: png }), new FakeGateway(), () => {});
  assert.deepEqual(profile.logo, PNG_1X1);

  const warnings: string[] = [];
  const noLogo = await resolveBusinessProfile(makeEnv({ BUSINESS_LOGO_PATH: gif }), new FakeGateway(), (message) => warnings.push(message));
  assert.equal(noLogo.logo, undefined);
  assert.deepEqual(warnings, ['logo skipped: the logo must be a PNG or JPEG image']);
  assert.throws(() => checkImage(Buffer.from('<svg/>')), /PNG or JPEG/);
});

test('only downloads logos from Razorpay over HTTPS', async () => {
  await assert.rejects(downloadLogo('https://example.com/logo.png'), /refusing to download a logo from example.com/);
  await assert.rejects(downloadLogo('http://cdn.razorpay.com/logos/x.png'), /refusing/);
  await assert.rejects(downloadLogo('https://cdn.razorpay.com.evil.example/x.png'), /refusing/);
});
