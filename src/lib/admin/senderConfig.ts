import { getTenantById, updateTenantConfig, updateTenantSenderConfig } from "@/lib/tenant";
import type { EmailSenderConfig } from "@/lib/types/tenant";

/**
 * Read/write helpers for the tenant-level email sender config (Account Settings →
 * Domains). The config lives on the control-plane tenant document alongside
 * `mailchimpConfig`; domain mutations are read-modify-write (admin settings, low
 * contention — see updateTenantConfig).
 */

const EMPTY: EmailSenderConfig = { domains: [] };

export async function getSenderConfig(tenantId: string): Promise<EmailSenderConfig> {
  const tenant = await getTenantById(tenantId);
  return tenant?.emailSenderConfig ?? EMPTY;
}

export async function saveSenderConfig(
  tenantId: string,
  config: EmailSenderConfig,
): Promise<void> {
  await updateTenantConfig(tenantId, { emailSenderConfig: config });
}

/**
 * Atomically mutate the tenant's sender config (transactional read-modify-write).
 * Use this for per-domain updates so concurrent writers — the verify auto-poll,
 * add-domain, and the web-routing DNS challenge — can't clobber each other's
 * changes to the shared `domains[]` array. The mutator must re-find the domain in
 * the FRESH config it receives so it preserves fields written concurrently.
 */
export async function mutateSenderConfig(
  tenantId: string,
  mutate: (current: EmailSenderConfig) => EmailSenderConfig,
): Promise<EmailSenderConfig> {
  return updateTenantSenderConfig(tenantId, mutate);
}

/** Lowercase + trim a domain for storage/compare. */
export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/\.$/, "");
}

/** A plausible registrable hostname (e.g. mail.acme.com). No scheme, no path. */
export function isValidDomain(domain: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain);
}
