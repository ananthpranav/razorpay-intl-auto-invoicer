import cron from 'node-cron';
import { ConfigError, type Env } from './config.ts';
import { invoiceJob, paymentsJob, reportJob, retryJob } from './jobs.ts';
import { log } from './log.ts';
import { describeError } from './razorpay.ts';

/**
 * The latest minute within the last `days` days at which `expression` was due, if any.
 * Used to catch up on an invoice run the server missed while it was down.
 */
export function lastScheduledRun(expression: string, timeZone: string, now: Date, days: number): Date | undefined {
  if (days <= 0) return undefined;
  const task = cron.createTask(expression, () => {}, { timezone: timeZone });
  try {
    const start = Math.floor(now.getTime() / 60_000) * 60_000;
    for (let minute = 0; minute < days * 1440; minute++) {
      const candidate = new Date(start - minute * 60_000);
      if (task.match(candidate)) return candidate;
    }
    return undefined;
  } finally {
    void task.destroy();
  }
}

/**
 * Runs the jobs on their schedules (INVOICE_SCHEDULE, PAYMENT_CHECK_SCHEDULE, REPORT_SCHEDULE, in
 * INVOICE_TIMEZONE; "off" disables one). The clients and bank details files are re-read on every run.
 */
export function startScheduler(env: Env): void {
  const jobs = [
    { name: 'invoice run', expression: env.INVOICE_SCHEDULE, run: (now?: Date) => invoiceJob({ dryRun: false, resend: false, sendPreview: false, now }) },
    { name: 'payment check', expression: env.PAYMENT_CHECK_SCHEDULE, run: () => paymentsJob({ dryRun: false }) },
    { name: 'settlement report', expression: env.REPORT_SCHEDULE, run: () => reportJob({}) },
    // The payment check also retries failed client emails; without it, retry them on their own.
    { name: 'email retry', expression: env.PAYMENT_CHECK_SCHEDULE === 'off' ? '0 10 * * *' : 'off', run: () => retryJob() },
  ].filter((job) => job.expression !== 'off');

  const invalid = jobs.filter((job) => !cron.validate(job.expression));
  if (invalid.length > 0) {
    throw new ConfigError('Invalid schedule', invalid.map((job) => `"${job.expression}" is not a valid cron expression for the ${job.name}`));
  }

  // One job at a time, in the order they were triggered.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (name: string, run: () => Promise<number>): Promise<void> => {
    queue = queue.then(async () => {
      log.info(`Starting the ${name}`);
      try {
        log.info(`The ${name} finished with exit code ${await run()}`);
      } catch (error) {
        log.error(`The ${name} crashed: ${describeError(error)}`);
      }
    });
    return queue;
  };

  const tasks = jobs.map((job) => {
    const task = cron.schedule(job.expression, () => enqueue(job.name, () => job.run()), {
      name: job.name,
      timezone: env.INVOICE_TIMEZONE,
      noOverlap: true,
    });
    log.info(`Scheduled the ${job.name}: "${job.expression}" in ${env.INVOICE_TIMEZONE}, next ${task.getNextRun()?.toISOString() ?? 'unknown'}`);
    return task;
  });

  // Safe to repeat: invoices that already exist are skipped and nobody is emailed twice. The run
  // bills the month it would have billed at its scheduled time.
  const invoiceRun = jobs.find((job) => job.name === 'invoice run');
  const missed = invoiceRun && lastScheduledRun(env.INVOICE_SCHEDULE, env.INVOICE_TIMEZONE, new Date(), env.CATCH_UP_DAYS);
  if (invoiceRun && missed) {
    log.info(`The invoice run was due at ${missed.toISOString()}; running it now in case it was missed`);
    void enqueue('catch-up invoice run', () => invoiceRun.run(missed));
  }

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, stopping the scheduler`);
    await Promise.all(tasks.map((task) => task.stop()));
    await queue;
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
