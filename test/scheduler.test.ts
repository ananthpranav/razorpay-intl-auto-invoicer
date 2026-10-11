import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastScheduledRun } from '../src/scheduler.ts';

test('finds the invoice run the server missed', () => {
  const missed = lastScheduledRun('0 9 1 * *', 'Asia/Kolkata', new Date('2026-11-02T10:00:00Z'), 3);
  assert.equal(missed?.toISOString(), '2026-11-01T03:30:00.000Z');
});

test('only catches up on runs within CATCH_UP_DAYS', () => {
  assert.equal(lastScheduledRun('0 9 1 * *', 'Asia/Kolkata', new Date('2026-11-05T10:00:00Z'), 3), undefined);
  assert.equal(lastScheduledRun('0 9 28 * *', 'Asia/Kolkata', new Date('2026-11-02T10:00:00Z'), 3), undefined);
  assert.equal(lastScheduledRun('0 9 1 * *', 'Asia/Kolkata', new Date('2026-11-02T10:00:00Z'), 0), undefined);
});

test('a run that is not due yet is not a missed run', () => {
  assert.equal(lastScheduledRun('0 9 1 * *', 'Asia/Kolkata', new Date('2026-11-01T03:00:00Z'), 3), undefined);
});
