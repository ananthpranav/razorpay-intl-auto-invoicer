import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Writes a file readable only by the current user (PDFs, reports and state hold client and bank details).
 * Writes to a temporary file first, so a crash never leaves a half-written file behind.
 */
export async function writePrivateFile(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await rm(temp, { force: true });
  await writeFile(temp, content, { mode: 0o600, flag: 'wx' }); // never follows a planted link
  await rename(temp, path);
}
