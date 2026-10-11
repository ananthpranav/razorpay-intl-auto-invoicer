import { parseCommand, type Command } from './commands.ts';
import { ConfigError, loadDotEnv, loadEnv } from './config.ts';
import { initConfig } from './init.ts';
import { customersCommand, invoiceJob, paymentsJob, probeCommand, reportJob } from './jobs.ts';
import { log } from './log.ts';
import { describeError } from './razorpay.ts';
import { startScheduler } from './scheduler.ts';

async function run(command: Command): Promise<number | undefined> {
  if (command.name === 'init') {
    const created = await initConfig(command.target);
    console.log(created.length ? `Created ${created.join(', ')} in ${command.target}` : `Nothing to do: the files already exist in ${command.target}`);
    console.log('Edit .env, clients.json and bank-details.json, then check them with the "probe" and "invoice --dry-run" commands.');
    return 0;
  }

  loadDotEnv();
  // In a terminal the error is on screen; under cron (no TTY) the owner is emailed instead.
  const alertOnFailure = !process.stdout.isTTY;
  switch (command.name) {
    case 'start':
      try {
        startScheduler(loadEnv());
        return undefined; // keeps running
      } catch (error) {
        log.error(describeError(error));
        if (error instanceof ConfigError) for (const detail of error.details) log.error(`  ${detail}`);
        return 2;
      }
    case 'invoice':
      return invoiceJob({ ...command, alertOnFailure });
    case 'payments':
      return paymentsJob({ dryRun: command.dryRun, match: command.match, alertOnFailure });
    case 'report':
      return reportJob({ month: command.month, alertOnFailure });
    case 'customers':
      return customersCommand(command);
    case 'probe':
      return probeCommand();
  }
}

const parsed = parseCommand(process.argv.slice(2));
if (parsed.ok) {
  const code = await run(parsed.command);
  if (code !== undefined) process.exitCode = code;
} else {
  (parsed.exitCode === 0 ? console.log : console.error)(parsed.output);
  process.exitCode = parsed.exitCode;
}
