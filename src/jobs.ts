import { resolveBusinessProfile } from './business.ts';
import { ConfigError, loadConfig, loadEnv, type AppConfig, type Env } from './config.ts';
import { createCustomer, printCustomers } from './customers.ts';
import { createSmtpMailer, failureAlertEmail, type Mailer } from './email.ts';
import { log } from './log.ts';
import { paymentExitCode, printPaymentReport, runPaymentCheck, type PaymentCheckOptions } from './payments.ts';
import { probe } from './probe.ts';
import { createRazorpayGateway, describeError, type RazorpayGateway } from './razorpay.ts';
import { runSettlementReport } from './report.ts';
import { exitCodeFor, printPreview, retryFailedEmails, runInvoices, type RunOptions } from './run.ts';
import { withStateLock } from './state.ts';

// Wires the real Razorpay and SMTP clients into each job. Exit codes: 0 success, 1 something
// failed, 2 invalid configuration.

export interface JobOptions {
  /** Email OWNER_EMAIL when the job fails (off for interactive CLI use, where the error is on screen). */
  alertOnFailure?: boolean;
}

interface JobContext {
  env: Env;
  config: AppConfig;
  gateway: RazorpayGateway;
  mailer?: Mailer;
}

export function invoiceJob(options: RunOptions & JobOptions): Promise<number> {
  return runJob(options, ({ env, config, gateway, mailer }) => withStateLock(env.STATE_PATH, async () => {
    const business = await resolveBusinessProfile(env, gateway, log.warn);
    const report = await runInvoices(config, { gateway, mailer, business }, { ...options, dryRun: options.dryRun || env.DRY_RUN });
    if (report.dryRun) printPreview(report, env);
    return exitCodeFor(report);
  }));
}

export function paymentsJob(options: PaymentCheckOptions & JobOptions): Promise<number> {
  return runJob(options, ({ env, config, gateway, mailer }) => withStateLock(env.STATE_PATH, async () => {
    const business = await resolveBusinessProfile(env, gateway, log.warn);
    const dryRun = options.dryRun || env.DRY_RUN;
    const retries = dryRun ? [] : await retryFailedEmails(config, { gateway, mailer, business });
    const report = await runPaymentCheck(config, { gateway, mailer, business }, { ...options, dryRun });
    if (report.dryRun) printPaymentReport(report, config);
    for (const error of report.errors) log.error(error);
    return Math.max(paymentExitCode(report), ...retries.map(exitCodeFor));
  }));
}

/** Retries failed client emails on their own, for setups that turn the payment check off. */
export function retryJob(options: JobOptions = {}): Promise<number> {
  return runJob(options, ({ env, config, gateway, mailer }) => withStateLock(env.STATE_PATH, async () => {
    const business = await resolveBusinessProfile(env, gateway, log.warn);
    const reports = await retryFailedEmails(config, { gateway, mailer, business });
    return Math.max(0, ...reports.map(exitCodeFor));
  }));
}

export function reportJob(options: { month?: string } & JobOptions): Promise<number> {
  return runJob(options, async ({ config, gateway, mailer }) => {
    const report = await runSettlementReport(config, { gateway, mailer }, options);
    if (report.savedTo) log.info(`Saved ${report.savedTo}`);
    for (const error of report.errors) log.error(error);
    return report.errors.length > 0 ? 1 : 0;
  });
}

/** Helper commands only need the Razorpay keys, so they work before email is set up. */
export async function customersCommand(options: { create: boolean; customerName?: string; email?: string; contact?: string; currency?: string }): Promise<number> {
  try {
    const gateway = helperGateway();
    if (!options.create) {
      await printCustomers(gateway);
      return 0;
    }
    if (!options.customerName) throw new ConfigError('--create needs --name "Client name"');
    await createCustomer(gateway, { name: options.customerName, email: options.email, contact: options.contact, currency: options.currency });
    return 0;
  } catch (error) {
    return fail(error);
  }
}

export async function probeCommand(): Promise<number> {
  try {
    const env = loadEnv(process.env, { requireEmailSettings: false });
    await probe(env, createRazorpayGateway(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET));
    return 0;
  } catch (error) {
    return fail(error);
  }
}

function helperGateway(): RazorpayGateway {
  const env = loadEnv(process.env, { requireEmailSettings: false });
  return createRazorpayGateway(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);
}

async function runJob(options: JobOptions, job: (ctx: JobContext) => Promise<number>): Promise<number> {
  let env: Env | undefined;
  try {
    env = loadEnv();
    const config = loadConfig(env);
    const gateway = createRazorpayGateway(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);
    const sendsEmail = env.SEND_CLIENT_EMAILS || env.SEND_PAYMENT_RECEIPTS || env.SEND_REMINDERS || env.OWNER_EMAIL;
    return await job({ env, config, gateway, mailer: sendsEmail ? createSmtpMailer(env) : undefined });
  } catch (error) {
    return fail(error, options.alertOnFailure === false ? undefined : env);
  }
}

async function fail(error: unknown, alertEnv?: Env): Promise<number> {
  const details = error instanceof ConfigError ? error.details : [];
  const message = describeError(error);
  log.error(message);
  for (const detail of details) log.error(`  ${detail}`);
  if (alertEnv?.OWNER_EMAIL && alertEnv.SMTP_HOST && alertEnv.EMAIL_FROM) {
    try {
      await createSmtpMailer(alertEnv).send({ to: [alertEnv.OWNER_EMAIL], ...failureAlertEmail(message, details) });
    } catch (alertError) {
      log.error(`could not email the failure alert: ${describeError(alertError)}`);
    }
  }
  return error instanceof ConfigError ? 2 : 1;
}
