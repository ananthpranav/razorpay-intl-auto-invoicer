// Minimal logger. Only pass non-sensitive values: labels, receipts, invoice ids and statuses.
// Never log keys, client names, emails, addresses, bank details or raw error objects.

type Level = 'info' | 'warn' | 'error';

function write(level: Level, message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (level === 'info') console.log(line);
  else console.error(line);
}

export const log = {
  info: (message: string) => write('info', message),
  warn: (message: string) => write('warn', message),
  error: (message: string) => write('error', message),
};
