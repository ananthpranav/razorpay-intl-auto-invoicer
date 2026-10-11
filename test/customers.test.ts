import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { parseClients } from '../src/config.ts';
import { createCustomer, suggestLabel } from '../src/customers.ts';
import { FakeGateway } from './helpers.ts';

test('suggests a valid client label from a name', () => {
  assert.equal(suggestLabel('Acme Inc.'), 'acme-inc');
  assert.equal(suggestLabel('  Über GmbH & Co. KG — Berlin Office '), 'ber-gmbh-co-kg-berli');
  assert.equal(suggestLabel('!!!'), 'client');
});

test('creates a customer and prints a clients.json entry to fill in', async () => {
  const output: string[] = [];
  mock.method(console, 'log', (line: string) => output.push(line));
  const gateway = new FakeGateway();
  const customer = await createCustomer(gateway, { name: 'Acme Inc.', email: 'ap@acme.example', currency: 'gbp' });

  assert.equal(gateway.customers.get(customer.id)?.email, 'ap@acme.example');
  const entry = JSON.parse(output.at(-1) ?? '{}');
  assert.deepEqual(entry, { label: 'acme-inc', customerId: customer.id, currency: 'GBP', items: [] });
  // Once items are added, the entry is valid.
  assert.doesNotThrow(() => parseClients([{ ...entry, items: [{ type: 'fixed', name: 'Retainer', amount: 250 }] }]));
});
