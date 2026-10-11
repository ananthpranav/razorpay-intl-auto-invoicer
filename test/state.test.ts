import assert from 'node:assert/strict';
import { readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError } from '../src/config.ts';
import { writePrivateFile } from '../src/files.ts';
import { emptyState, loadState, saveState, withStateLock } from '../src/state.ts';
import { tempDir } from './helpers.ts';

test('a missing state file means a fresh start', async () => {
  assert.deepEqual(await loadState(join(tempDir(), 'missing', 'state.json')), emptyState());
});

test('saves privately and reads back what it saved', async () => {
  const path = join(tempDir(), 'data', 'state.json');
  const state = emptyState();
  state.initializedAt = '2026-11-02T00:00:00.000Z';
  state.payments.pay_X = { status: 'matched', receipt: 'INV-202610-client-a', basis: 'reference', seenAt: '2026-11-05T00:00:00.000Z' };
  state.invoices['INV-202610-client-b'] = { remindersSent: [3] };
  await saveState(path, state);
  assert.deepEqual(await loadState(path), state);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('refuses a damaged state file instead of starting over', async () => {
  const path = join(tempDir(), 'state.json');
  writeFileSync(path, JSON.stringify({ version: 2 }));
  await assert.rejects(loadState(path), (error) => error instanceof ConfigError && /unexpected format/.test(error.message));
});

test('a second run is refused while another one holds the state', async () => {
  const path = join(tempDir(), 'state.json');
  let release = () => {};
  let held = () => {};
  const holding = new Promise<void>((resolve) => { held = resolve; });
  const first = withStateLock(path, () => new Promise<void>((resolve) => {
    release = resolve;
    held();
  }));
  await holding;
  await assert.rejects(withStateLock(path, async () => {}), /Another run is in progress/);
  release();
  await first;
  assert.equal(await withStateLock(path, async () => 'free again'), 'free again');
});

test('a lock left behind by a crashed run expires after 30 minutes', async () => {
  const path = join(tempDir(), 'state.json');
  writeFileSync(`${path}.lock`, '12345');
  const hourAgo = new Date(Date.now() - 3_600_000);
  utimesSync(`${path}.lock`, hourAgo, hourAgo);
  assert.equal(await withStateLock(path, async () => 'ran'), 'ran');
});

test('private writes never follow a link planted at the temporary path', async () => {
  const dir = tempDir();
  const victim = join(dir, 'victim.txt');
  writeFileSync(victim, 'untouched');
  const path = join(dir, 'state.json');
  symlinkSync(victim, `${path}.${process.pid}.tmp`);
  await writePrivateFile(path, 'new state');
  assert.equal(readFileSync(victim, 'utf8'), 'untouched');
  assert.equal(readFileSync(path, 'utf8'), 'new state');
});
