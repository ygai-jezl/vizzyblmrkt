import { Resolver } from "node:dns/promises";
import { registrableDomain } from "@/lib/domains/registrableDomain";
import type { SenderDnsRecord } from "@/lib/types/tenant";

/**
 * MailChimp Transactional (Mandrill) custom sending-domain verification. Mandrill
 * is the authority for whether mail from a domain will authenticate (DKIM + SPF +
 * domain ownership), so "verifying a domain" means registering it with Mandrill
 * and polling its checks — not just storing a flag. All calls degrade gracefully
 * when MANDRILL_API_KEY is absent (dev / before a provider is configured): the
 * fixed DNS records are still produced, but live status — and the per-domain
 * ownership token — can't be read.
 *
 * Docs: https://mailchimp.com/developer/transactional/api/senders/
 */

const BASE = "https://mandrillapp.com/api/1.0";
const TIMEOUT_MS = 8000;

/** SPF: add Mandrill to the domain's sender policy (soft-fail the rest). Recommended. */
const SPF_VALUE = "v=spf1 include:spf.mandrillapp.com ~all";
/** DMARC: Mandrill requires at least a permissive monitoring policy on the domain. */
const DMARC_VALUE = "v=DMARC1; p=none;";
/**
 * Mandrill's current DKIM authentication: two CNAMEs (mte1/mte2 selectors) that
 * point at Mandrill-hosted keys, letting Mandrill rotate keys without DNS churn.
 * The targets are the same for every account, so they're constants — no env var.
 */
const DKIM_CNAMES: ReadonlyArray<readonly [string, string]> = [
  ["mte1._domainkey", "dkim1.mandrillapp.com"],
  ["mte2._domainkey", "dkim2.mandrillapp.com"],
];
/** Prefix Mandrill expects on the domain-ownership TXT value (mandrill_verify.<key>). */
const OWNERSHIP_PREFIX = "mandrill_verify";

export function mandrillConfigured(): boolean {
  return Boolean(process.env.MANDRILL_API_KEY?.trim());
}

/**
 * The DNS records a tenant publishes to authenticate `domain` with Mandrill. The
 * ownership TXT is only emitted once Mandrill has minted a `verifyTxtKey` for the
 * domain (returned by senders/add-domain); the SPF/DKIM/DMARC records are fixed.
 */
export function senderDnsRecords(domain: string, verifyTxtKey?: string): SenderDnsRecord[] {
  const d = domain.trim().toLowerCase();
  const records: SenderDnsRecord[] = [];
  const key = verifyTxtKey?.trim();
  if (key) {
    records.push({ type: "TXT", host: d, value: `${OWNERSHIP_PREFIX}.${key}`, valid: false });
  }
  records.push({ type: "TXT", host: d, value: SPF_VALUE, valid: false });
  for (const [prefix, target] of DKIM_CNAMES) {
    records.push({ type: "CNAME", host: `${prefix}.${d}`, value: target, valid: false });
  }
  records.push({ type: "TXT", host: `_dmarc.${d}`, value: DMARC_VALUE, valid: false });
  return records;
}

/**
 * Reflect the provider's DKIM/SPF/ownership verdict onto the published records.
 * With `published` (our own DNS lookup, see checkPublishedRecords), the SPF row is
 * also ticked when the record is found in DNS, and the DMARC row gets a real tick.
 * Without it, DMARC is left untouched, as before.
 */
export function applyRecordValidity(
  records: SenderDnsRecord[],
  status: { dkimValid: boolean; spfValid: boolean; ownershipValid: boolean },
  published?: PublishedRecords,
): SenderDnsRecord[] {
  return records.map((r) => {
    if (r.host.includes("._domainkey.")) return { ...r, valid: status.dkimValid };
    if (r.value.startsWith(`${OWNERSHIP_PREFIX}.`)) return { ...r, valid: status.ownershipValid };
    if (r.value.startsWith("v=spf1")) {
      return { ...r, valid: status.spfValid || published?.spfFound === true };
    }
    if (published && r.host.startsWith("_dmarc.")) {
      return {
        type: r.type,
        host: r.host,
        value: r.value,
        valid: published.dmarcFound,
        ...(published.dmarcFrom ? { inheritedFrom: published.dmarcFrom } : {}),
      };
    }
    return r; // DMARC without our own lookup: Mandrill doesn't check it
  });
}

/** Reads a name's TXT records, each as the arrays of strings DNS may split it into. */
export type TxtLookup = (name: string) => Promise<string[][]>;

/** What our own DNS lookup found for the two records Mandrill doesn't fully report. */
export interface PublishedRecords {
  /** A TXT at the domain starts `v=spf1` and includes spf.mandrillapp.com. */
  spfFound: boolean;
  /** A `v=DMARC1` TXT at `_dmarc.<domain>`, or at the parent domain's `_dmarc`. */
  dmarcFound: boolean;
  /** Set when the DMARC record found is the parent domain's, e.g. "acme.com" for mail.acme.com. */
  dmarcFrom?: string;
}

const DNS_TIMEOUT_MS = 3000;
const DNS_TRIES = 2;

function defaultTxtLookup(): TxtLookup {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES });
  return (name) => resolver.resolveTxt(name);
}

/** A name's TXT values, split chunks joined. Any DNS error (none there, timeout) reads as none. */
async function txtValues(name: string, lookup: TxtLookup): Promise<string[]> {
  try {
    const chunks = await lookup(name);
    return chunks.map((parts) => parts.join("").trim());
  } catch {
    return [];
  }
}

const isSpfWithMandrill = (v: string) =>
  /^v=spf1(\s|$)/i.test(v) && /(^|\s)[+]?include:spf\.mandrillapp\.com(\s|$)/i.test(v);
const isDmarc = (v: string) => /^v=DMARC1\s*(;|$)/i.test(v);

/**
 * Look up the domain's SPF and DMARC records in DNS ourselves. Mandrill's verdict
 * (and so the domain's Verified status) needs only ownership and DKIM, and it never
 * checks DMARC, so without this a domain can read Verified with both still missing.
 * A subdomain without its own DMARC record is covered by its parent domain's (mail
 * servers fall back to it), so that counts as found, with `dmarcFrom` saying where.
 * Never throws: a failed lookup reads as "not found".
 */
export async function checkPublishedRecords(
  domain: string,
  lookup: TxtLookup = defaultTxtLookup(),
): Promise<PublishedRecords> {
  const d = domain.trim().toLowerCase();
  const [atDomain, ownDmarc] = await Promise.all([
    txtValues(d, lookup),
    txtValues(`_dmarc.${d}`, lookup),
  ]);
  const spfFound = atDomain.some(isSpfWithMandrill);
  if (ownDmarc.some(isDmarc)) return { spfFound, dmarcFound: true };

  const parent = registrableDomain(d);
  if (parent && parent !== d && (await txtValues(`_dmarc.${parent}`, lookup)).some(isDmarc)) {
    return { spfFound, dmarcFound: true, dmarcFrom: parent };
  }
  return { spfFound, dmarcFound: false };
}

export interface ProviderDomainStatus {
  /** Whether the provider call itself succeeded (false ⇒ couldn't check). */
  ok: boolean;
  dkimValid: boolean;
  spfValid: boolean;
  /** Whether Mandrill considers domain ownership confirmed (verified_at / valid_signing). */
  ownershipValid: boolean;
  /** The per-domain ownership token, when the provider returned one. */
  verifyTxtKey?: string;
  status: "pending" | "verified" | "failed";
  /** Provider error / reason surfaced to the admin (e.g. "provider_not_configured"). */
  detail?: string;
}

interface MandrillDomain {
  domain?: string;
  /** Bare ownership key; the published TXT value is `mandrill_verify.<verify_txt_key>`. */
  verify_txt_key?: string;
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
    return {
      ok: false,
      dkimValid: false,
      spfValid: false,
      ownershipValid: false,
      status: "pending",
      detail: r.reason,
    };
  }
  const dkimValid = Boolean(r.data.dkim?.valid);
  const spfValid = Boolean(r.data.spf?.valid);
  const ownershipValid = Boolean(r.data.verified_at) || Boolean(r.data.valid_signing);
  // `valid_signing` is Mandrill's composite "ready to sign" verdict (DKIM + SPF +
  // domain ownership). The fallback must ALSO require ownership: DKIM+SPF without
  // a confirmed owner is a state Mandrill still treats as unsigned, so it must not
  // count as "verified" — that would authorize a From address that can't send.
  const ready = Boolean(r.data.valid_signing) || (dkimValid && spfValid && ownershipValid);
  return {
    ok: true,
    dkimValid,
    spfValid,
    ownershipValid,
    verifyTxtKey: r.data.verify_txt_key?.trim() || undefined,
    status: ready ? "verified" : "pending",
    detail: r.data.dkim?.error || r.data.spf?.error || undefined,
  };
}

/**
 * Register a sending domain with Mandrill (idempotent on their side). This is the
 * call that mints/returns the domain-ownership token (`verifyTxtKey`).
 */
export async function addSendingDomain(domain: string): Promise<ProviderDomainStatus> {
  return toStatus(await callSenders("add-domain", domain));
}

/** Re-run Mandrill's DKIM/SPF/ownership checks for a domain and report the verdict. */
export async function checkSendingDomain(domain: string): Promise<ProviderDomainStatus> {
  return toStatus(await callSenders("check-domain", domain));
}
