import type { SenderDnsRecord } from "@/lib/types/tenant";

/**
 * MailChimp Transactional (Mandrill) custom sending-domain verification. Mandrill
 * is the authority for whether mail from a domain will authenticate (DKIM + SPF),
 * so "verifying a domain" means registering it with Mandrill and polling its
 * checks — not just storing a flag. All calls degrade gracefully when
 * MANDRILL_API_KEY is absent (dev / before a provider is configured): the DNS
 * records to publish are still produced, but live status can't be read.
 *
 * Docs: https://mailchimp.com/developer/transactional/api/senders/
 */

const BASE = "https://mandrillapp.com/api/1.0";
const TIMEOUT_MS = 8000;

/** SPF: add Mandrill to the domain's sender policy (soft-fail the rest). */
const SPF_VALUE = "v=spf1 include:spf.mandrillapp.com ~all";
/** DMARC: a permissive monitoring policy is enough to start sending. */
const DMARC_VALUE = "v=DMARC1; p=none;";
/** Host prefix for Mandrill's DKIM record on a domain. */
const DKIM_HOST_PREFIX = "mandrill._domainkey";

export function mandrillConfigured(): boolean {
  return Boolean(process.env.MANDRILL_API_KEY?.trim());
}

/**
 * The Mandrill DKIM public-key TXT value. This is account/region specific (copy
 * it from Mailchimp Transactional → Domains), so it is config, not a constant —
 * when unset the DKIM record is shown with an empty value the admin must fill in.
 */
function dkimValue(): string {
  return process.env.MANDRILL_DKIM_TXT_VALUE?.trim() || "";
}

/** The three DNS records a tenant publishes to authenticate `domain` with Mandrill. */
export function senderDnsRecords(domain: string): SenderDnsRecord[] {
  const d = domain.trim().toLowerCase();
  return [
    { type: "TXT", host: d, value: SPF_VALUE, valid: false },
    { type: "TXT", host: `${DKIM_HOST_PREFIX}.${d}`, value: dkimValue(), valid: false },
    { type: "TXT", host: `_dmarc.${d}`, value: DMARC_VALUE, valid: false },
  ];
}

/** Reflect the provider's DKIM/SPF verdict onto the published records. */
export function applyRecordValidity(
  records: SenderDnsRecord[],
  status: { dkimValid: boolean; spfValid: boolean },
): SenderDnsRecord[] {
  return records.map((r) => {
    if (r.host.startsWith(`${DKIM_HOST_PREFIX}.`)) return { ...r, valid: status.dkimValid };
    if (r.value.startsWith("v=spf1")) return { ...r, valid: status.spfValid };
    return r; // DMARC is not provider-checked
  });
}

export interface ProviderDomainStatus {
  /** Whether the provider call itself succeeded (false ⇒ couldn't check). */
  ok: boolean;
  dkimValid: boolean;
  spfValid: boolean;
  status: "pending" | "verified" | "failed";
  /** Provider error / reason surfaced to the admin (e.g. "provider_not_configured"). */
  detail?: string;
}

interface MandrillDomain {
  domain?: string;
  spf?: { valid?: boolean; error?: string | null };
  dkim?: { valid?: boolean; error?: string | null };
  verified_at?: string | null;
  valid_signing?: boolean;
}

async function callSenders(
  endpoint: "add-domain" | "check-domain",
  domain: string,
): Promise<{ ok: boolean; data?: MandrillDomain; reason?: string }> {
  const key = process.env.MANDRILL_API_KEY?.trim();
  if (!key) return { ok: false, reason: "provider_not_configured" };
  try {
    const res = await fetch(`${BASE}/senders/${endpoint}.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, domain }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as
      | (MandrillDomain & { message?: string; name?: string })
      | null;
    if (!res.ok) {
      return { ok: false, reason: json?.message || json?.name || `http_${res.status}` };
    }
    return { ok: true, data: (json ?? {}) as MandrillDomain };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError" ? "timeout" : "request_error";
    return { ok: false, reason };
  }
}

function toStatus(r: {
  ok: boolean;
  data?: MandrillDomain;
  reason?: string;
}): ProviderDomainStatus {
  if (!r.ok || !r.data) {
    return { ok: false, dkimValid: false, spfValid: false, status: "pending", detail: r.reason };
  }
  const dkimValid = Boolean(r.data.dkim?.valid);
  const spfValid = Boolean(r.data.spf?.valid);
  // `valid_signing` is Mandrill's own "ready to sign for this domain" verdict.
  const ready = Boolean(r.data.valid_signing) || (dkimValid && spfValid);
  return {
    ok: true,
    dkimValid,
    spfValid,
    status: ready ? "verified" : "pending",
    detail: r.data.dkim?.error || r.data.spf?.error || undefined,
  };
}

/** Register a sending domain with Mandrill (idempotent on their side). */
export async function addSendingDomain(domain: string): Promise<ProviderDomainStatus> {
  return toStatus(await callSenders("add-domain", domain));
}

/** Re-run Mandrill's DKIM/SPF checks for a domain and report the verdict. */
export async function checkSendingDomain(domain: string): Promise<ProviderDomainStatus> {
  return toStatus(await callSenders("check-domain", domain));
}
