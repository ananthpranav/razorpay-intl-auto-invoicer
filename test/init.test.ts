import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { initConfig } from '../src/init.ts';
import { tempDir } from './helpers.ts';

test('writes the editable files once, readable only by you', async () => {
  const dir = join(tempDir(), 'invoicer');
  assert.deepEqual(await initConfig(dir), ['.env', 'clients.json', 'bank-details.json', 'docker-compose.yml']);
  assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'clients.json')).mode & 0o777, 0o600);

  writeFileSync(join(dir, 'clients.json'), '[]');
  assert.deepEqual(await initConfig(dir), []);
  assert.equal(readFileSync(join(dir, 'clients.json'), 'utf8'), '[]');
});
