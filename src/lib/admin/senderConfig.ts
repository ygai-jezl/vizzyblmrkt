import { getTenantById, updateTenantConfig } from "@/lib/tenant";
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

/** Lowercase + trim a domain for storage/compare. */
export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/\.$/, "");
}

/** A plausible registrable hostname (e.g. mail.acme.com). No scheme, no path. */
export function isValidDomain(domain: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain);
}
