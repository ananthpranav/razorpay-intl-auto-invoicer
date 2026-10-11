import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLineItems, makePeriod } from '../src/billing.ts';
import { renderInvoicePdf } from '../src/pdf.ts';
import { previewView, type InvoiceView } from '../src/view.ts';
import { BUSINESS, makeConfig, NOV_1, PNG_1X1 } from './helpers.ts';

function sampleView(): InvoiceView {
  const config = makeConfig({ BUSINESS_ADDRESS: '12 Example Road\\nBengaluru 560001\\nIndia', INVOICE_FOOTER: 'Export under LUT.' });
  const client = config.clients[0]!;
  const period = makePeriod(2026, 10);
  return previewView(
    buildLineItems(client, period),
    { id: client.customerId, name: 'Example Corp', email: 'a@example.com' },
    { env: config.env, client, period, bankDetails: config.bankDetails.USD!, business: BUSINESS, receipt: 'INV-202610-client-a' },
    NOV_1,
  );
}

function pageCount(pdf: Buffer): number {
  return pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0;
}

test('renders a one-page invoice PDF', async () => {
  const view = sampleView();
  assert.equal(view.total, 'USD 3,500.00');
  assert.deepEqual(view.billTo.addressLines, ['100 Example Street', 'San Francisco, CA 94105', 'United States']);
  const pdf = await renderInvoicePdf({ ...view, stamp: undefined });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pageCount(pdf), 1);
});

test('long invoices continue on new pages', async () => {
  const view = sampleView();
  const rows = Array.from({ length: 50 }, (_, index) => ({ ...view.rows[0]!, name: `Line item ${index + 1}` }));
  const pdf = await renderInvoicePdf({ ...view, rows });
  assert.ok(pageCount(pdf) >= 2);
});

test('embeds the logo and stamps paid copies', async () => {
  const view = sampleView();
  const pdf = await renderInvoicePdf({ ...view, seller: { ...view.seller, logo: PNG_1X1 }, stamp: 'paid' });
  const raw = pdf.toString('latin1');
  assert.match(raw, /\/Subtype \/Image/);
  assert.equal(pageCount(pdf), 1);
});
