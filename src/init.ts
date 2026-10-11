import { constants, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES: Array<[from: string, to: string, mode: number]> = [
  ['.env.example', '.env', 0o600],
  ['clients.example.json', 'clients.json', 0o600],
  ['bank-details.example.json', 'bank-details.json', 0o600],
  ['docker-compose.yml', 'docker-compose.yml', 0o644],
];

/** Copies the example configuration into `target`, never overwriting a file that exists. */
export async function initConfig(target: string, source = fileURLToPath(new URL('..', import.meta.url))): Promise<string[]> {
  await mkdir(target, { recursive: true });
  const created: string[] = [];
  for (const [from, to, mode] of TEMPLATES) {
    const destination = join(target, to);
    if (existsSync(destination)) continue;
    await copyFile(join(source, from), destination, constants.COPYFILE_EXCL);
    await chmod(destination, mode);
    created.push(to);
  }
  return created;
}
