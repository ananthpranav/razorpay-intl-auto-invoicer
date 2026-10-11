import { readFile } from 'node:fs/promises';
import { ConfigError, type Env } from './config.ts';
import { describeError, type RazorpayGateway } from './razorpay.ts';
import { addressLines, splitLines } from './text.ts';

/** Your business as printed on the PDF. */
export interface BusinessProfile {
  name: string;
  lines: string[]; // address, email and tax lines
  logo?: Buffer;
}

const MAX_LOGO_BYTES = 1_000_000;

/**
 * Reads your business details from Razorpay, with any BUSINESS_* value in .env taking priority:
 * - name and logo: the branding Razorpay Checkout shows (always available);
 * - address, email and GSTIN: Razorpay's Accounts API, when RAZORPAY_ACCOUNT_ID is set. Razorpay
 *   documents that API for partners, so it may refuse normal keys; .env then fills the gaps.
 */
export async function resolveBusinessProfile(
  env: Env,
  gateway: Pick<RazorpayGateway, 'fetchBranding' | 'fetchAccount'>,
  warn: (message: string) => void,
): Promise<BusinessProfile> {
  const branding = await gateway.fetchBranding().catch((error: unknown) => {
    warn(`could not read your business name and logo from Razorpay: ${describeError(error)}`);
    return undefined;
  });
  const account = env.RAZORPAY_ACCOUNT_ID
    ? await gateway.fetchAccount(env.RAZORPAY_ACCOUNT_ID).catch((error: unknown) => {
      warn(`could not read your account details from Razorpay's Accounts API: ${describeError(error)}`);
      return undefined;
    })
    : undefined;

  const name = env.BUSINESS_NAME ?? (account?.legal_business_name || branding?.name || branding?.brandName);
  if (!name) {
    throw new ConfigError('Business name unknown', ['BUSINESS_NAME: Razorpay did not return a business name, so set it in .env']);
  }
  const registered = account?.profile?.addresses?.registered;
  const address = env.BUSINESS_ADDRESS
    ? splitLines(env.BUSINESS_ADDRESS)
    : registered
      ? addressLines({
        line1: registered.street1,
        line2: registered.street2,
        city: registered.city,
        state: registered.state,
        postalCode: registered.postal_code,
        country: registered.country,
      })
      : [];
  const email = env.BUSINESS_EMAIL ?? (account?.email || undefined);
  const gstin = account?.legal_info?.gst;
  const tax = env.BUSINESS_TAX_INFO ? splitLines(env.BUSINESS_TAX_INFO) : gstin ? [`GSTIN: ${gstin}`] : [];

  let logo: Buffer | undefined;
  if (env.SHOW_LOGO) {
    try {
      if (env.BUSINESS_LOGO_PATH) logo = checkImage(await readFile(env.BUSINESS_LOGO_PATH));
      else if (branding?.logoUrl) logo = checkImage(await downloadLogo(branding.logoUrl));
    } catch (error) {
      warn(`logo skipped: ${describeError(error)}`);
    }
  }
  return { name, lines: [...address, ...(email ? [email] : []), ...tax], logo };
}

/** Downloads the Checkout logo, only from Razorpay's own servers over HTTPS. */
export async function downloadLogo(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  const host = parsed.hostname;
  if (parsed.protocol !== 'https:' || !(host === 'razorpay.com' || host.endsWith('.razorpay.com'))) {
    throw new Error(`refusing to download a logo from ${host}`);
  }
  const response = await fetch(parsed, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error(`logo download failed (HTTP ${response.status})`);
  if (Number(response.headers.get('content-length') ?? 0) > MAX_LOGO_BYTES || !response.body) throw new Error('logo is larger than 1 MB');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_LOGO_BYTES) throw new Error('logo is larger than 1 MB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The PDF library can only embed PNG and JPEG images. */
export function checkImage(buffer: Buffer): Buffer {
  const png = buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const jpeg = buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (!png && !jpeg) throw new Error('the logo must be a PNG or JPEG image');
  return buffer;
}
