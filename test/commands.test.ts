import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommand } from '../src/commands.ts';

const command = (argv: string[]) => {
  const parsed = parseCommand(argv);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.output);
  return parsed.command;
};
const error = (argv: string[]) => {
  const parsed = parseCommand(argv);
  assert.ok(!parsed.ok);
  return parsed;
};

test('runs the invoices when no command is given', () => {
  assert.deepEqual(command([]), { name: 'invoice', dryRun: false, sendPreview: false, resend: false, reissue: false, period: undefined, only: undefined });
  assert.equal((command(['--send-preview']) as { dryRun: boolean }).dryRun, true);
});

test('parses each command', () => {
  assert.deepEqual(command(['invoice', '--only', 'a, b', '--period', '2026-09', '--reissue']),
    { name: 'invoice', dryRun: false, sendPreview: false, resend: false, reissue: true, period: '2026-09', only: ['a', 'b'] });
  assert.deepEqual(command(['payments', '--match', 'pay_ABC123=INV-202610-a']),
    { name: 'payments', dryRun: false, match: { paymentId: 'pay_ABC123', receipt: 'INV-202610-a' } });
  assert.deepEqual(command(['report', '--month', '2026-09']), { name: 'report', month: '2026-09' });
  assert.deepEqual(command(['customers', '--create', '--name', 'Acme']),
    { name: 'customers', create: true, customerName: 'Acme', email: undefined, contact: undefined, currency: undefined });
  assert.deepEqual(command(['init', '/config']), { name: 'init', target: '/config' });
  assert.deepEqual(command(['start']), { name: 'start' });
});

test('rejects bad input with exit code 2', () => {
  for (const argv of [['frobnicate'], ['payments', '--match', 'nonsense'], ['report', '--month', '2026-13'], ['report', '--resend'], ['init', 'a', 'b'], ['probe', 'extra']]) {
    assert.equal(error(argv).exitCode, 2, argv.join(' '));
  }
});

test('help exits 0', () => {
  assert.equal(error(['--help']).exitCode, 0);
  assert.equal(error(['payments', '-h']).exitCode, 0);
});
