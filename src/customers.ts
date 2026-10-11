import type { CustomerInfo, RazorpayGateway } from './razorpay.ts';

/** Prints your Razorpay customers, to find the cust_… IDs for clients.json. */
export async function printCustomers(gateway: Pick<RazorpayGateway, 'listCustomers'>): Promise<void> {
  const customers = await gateway.listCustomers();
  if (customers.length === 0) {
    console.log('No customers yet. Create one with: npm run customers -- --create --name "Client name" --email billing@client.example');
    return;
  }
  const rows = [['ID', 'Name', 'Email'], ...customers.map((customer) => [customer.id, customer.name ?? '', customer.email ?? ''])];
  const widths = [0, 1].map((column) => Math.max(...rows.map((row) => row[column]?.length ?? 0)));
  for (const row of rows) console.log(`${(row[0] ?? '').padEnd(widths[0] ?? 0)}  ${(row[1] ?? '').padEnd(widths[1] ?? 0)}  ${row[2] ?? ''}`);
}

/** Creates a Razorpay customer (or returns the existing one with the same email and phone) and prints a clients.json entry. */
export async function createCustomer(
  gateway: Pick<RazorpayGateway, 'createCustomer'>,
  input: { name: string; email?: string; contact?: string; currency?: string },
): Promise<CustomerInfo> {
  const customer = await gateway.createCustomer({ name: input.name, email: input.email, contact: input.contact });
  console.log(`Razorpay customer: ${customer.id} (${customer.name ?? input.name})`);
  console.log('\nAdd this to clients.json and fill in the items:');
  const entry = { label: suggestLabel(input.name), customerId: customer.id, currency: (input.currency ?? 'USD').toUpperCase(), items: [] };
  console.log(JSON.stringify(entry, null, 2));
  return customer;
}

export function suggestLabel(name: string): string {
  const label = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 20).replace(/-+$/, '');
  return label || 'client';
}
