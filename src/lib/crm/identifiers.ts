import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import { registrableDomain } from "@/lib/domains/registrableDomain";

/**
 * Deterministic, tenant-scoped document ids for the CRM collections.
 *
 * SECURITY (critical): Firestore document ids are GLOBAL within a collection,
 * and TenantCollection.create() uses an atomic create() that rejects
 * ALREADY_EXISTS across ANY tenant. So every deterministic id MUST hash the
 * tenantId in — otherwise two tenants deriving the same key (e.g. both have a
 * contact at "acme.com") would collide and the second write would fail. Mirrors
 * deterministicSignupId, which is tenant-unique only because campaignId already
 * is. See src/lib/tenant/repository.ts and docs/ARCHITECTURE-AND-DELIVERY.md §4.
 */
function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 40);
}

/** Contact id from (tenant, contactKey). contactKey = normalizeEmail(email) ?? phone. */
export function deterministicContactId(tenantId: string, contactKey: string): string {
  return `ct_${hash(`${tenantId}\n${contactKey.trim().toLowerCase()}`)}`;
}

/** Company id from (tenant, canonical registrable domain). */
export function deterministicCompanyId(tenantId: string, domain: string): string {
  return `co_${hash(`${tenantId}\n${domain.trim().toLowerCase()}`)}`;
}

/** Per-recipient email-message id from (tenant, provider, provider message id, recipient). */
export function deterministicMessageId(
  tenantId: string,
  provider: string,
  providerId: string,
  recipientKey: string,
): string {
  return `em_${hash(`${tenantId}\n${provider}\n${providerId}\n${recipientKey.trim().toLowerCase()}`)}`;
}

/**
 * The CANONICAL registrable domain (eTLD+1, ASCII/punycode-normalised) of a host.
 *
 * registrableDomain() collapses subdomains (mail.acme.com → acme.com) but leaves
 * a Unicode IDN as-is, so "ёлка.рф" and its punycode form "xn--e1afmkfd.xn--p1ai"
 * would hash to two different company ids — spawning phantom companies that
 * defeat per-company enrich dedup, the daily cap, and contact↔company
 * association. domainToASCII collapses both to the single punycode form.
 * Returns null for IPs / localhost / unparseable hosts.
 */
export function canonicalDomain(host: string): string | null {
  const reg = registrableDomain(host);
  if (!reg) return null;
  const ascii = domainToASCII(reg);
  return ascii || reg;
}

/** Canonical registrable domain of an email address's host part, or null. */
export function domainFromEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return canonicalDomain(email.slice(at + 1));
}
