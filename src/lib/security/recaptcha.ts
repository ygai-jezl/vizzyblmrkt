import { GoogleAuth } from "google-auth-library";
import { registrableDomain, normalizeHost } from "@/lib/domains/registrableDomain";

/**
 * Server-side reCAPTCHA Enterprise verification.
 *
 * FEATURE-FLAGGED: when RECAPTCHA_ENABLED !== "true" we short-circuit to a
 * "skipped" pass so signup works on dev before the key is minted. Flip the flag
 * (and set RECAPTCHA_PROJECT_ID + NEXT_PUBLIC_RECAPTCHA_SITE_KEY) to enforce.
 * The assessment is ALWAYS done server-side — the browser only sends a token.
 */
export interface RecaptchaResult {
  ok: boolean;
  /** true when verification was bypassed because the feature is disabled. */
  skipped: boolean;
  score?: number;
  reason?: string;
}

export function recaptchaEnabled(): boolean {
  return process.env.RECAPTCHA_ENABLED === "true";
}

const MIN_SCORE = 0.5;

let auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  auth ??= new GoogleAuth({
    scopes: "https://www.googleapis.com/auth/cloud-platform",
  });
  return auth;
}

export async function verifyRecaptcha(
  token: string | undefined,
  expectedAction: string,
): Promise<RecaptchaResult> {
  if (!recaptchaEnabled()) return { ok: true, skipped: true };
  if (!token) return { ok: false, skipped: false, reason: "missing-token" };

  const project =
    process.env.RECAPTCHA_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
  const siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
  if (!project || !siteKey) {
    return { ok: false, skipped: false, reason: "misconfigured" };
  }

  try {
    const client = await getAuth().getClient();
    const res = await client.request<{
      tokenProperties?: { valid?: boolean; action?: string; invalidReason?: string };
      riskAnalysis?: { score?: number };
    }>({
      url: `https://recaptchaenterprise.googleapis.com/v1/projects/${project}/assessments`,
      method: "POST",
      data: { event: { token, siteKey, expectedAction } },
    });

    const props = res.data.tokenProperties;
    if (!props?.valid) {
      return { ok: false, skipped: false, reason: props?.invalidReason ?? "invalid-token" };
    }
    if (props.action !== expectedAction) {
      return { ok: false, skipped: false, reason: "action-mismatch" };
    }
    const score = res.data.riskAnalysis?.score ?? 0;
    return { ok: score >= MIN_SCORE, skipped: false, score, reason: score >= MIN_SCORE ? undefined : "low-score" };
  } catch {
    return { ok: false, skipped: false, reason: "assessment-error" };
  }
}

/**
 * Safe ceiling on how many domains we'll add to the shared key. The default path
 * never grows the list (every brand uses the one platform host); only
 * ownership-proven CUSTOM domains add an entry, so this is a runaway guard far
 * below the Enterprise per-key limit.
 */
const MAX_RECAPTCHA_DOMAINS = 200;

const KEYS_BASE = "https://recaptchaenterprise.googleapis.com/v1";

function keyResource(): { project: string; siteKey: string } | null {
  const project = process.env.RECAPTCHA_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
  const siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
  if (!project || !siteKey) return null;
  return { project, siteKey };
}

export interface RegisterDomainResult {
  ok: boolean;
  /** true when verification is disabled (dev) and the call was a no-op. */
  skipped?: boolean;
  /** true when the domain (eTLD+1) was already on the key. */
  alreadyPresent?: boolean;
  reason?: string;
}

/**
 * Add a domain's registrable domain (eTLD+1) to the reCAPTCHA Enterprise key's
 * allowed-domains list so signups from it pass the assessment. Read-modify-write
 * (getKey → append → patch with a field mask) — there is no append API, and the
 * mask keeps every other key setting untouched. reCAPTCHA matches subdomains of
 * a registered bare domain automatically, so we register the eTLD+1 once and the
 * list stays small. Idempotent; a no-op when reCAPTCHA is disabled (dev).
 */
export async function registerRecaptchaDomain(
  host: string,
): Promise<RegisterDomainResult> {
  if (!recaptchaEnabled()) return { ok: true, skipped: true };
  const res = keyResource();
  if (!res) return { ok: false, reason: "misconfigured" };
  const domain = registrableDomain(host) ?? normalizeHost(host);
  if (!domain) return { ok: false, reason: "invalid_host" };

  const keyName = `projects/${res.project}/keys/${res.siteKey}`;
  try {
    const client = await getAuth().getClient();
    const current = await client.request<{
      name?: string;
      webSettings?: { allowedDomains?: string[] };
    }>({ url: `${KEYS_BASE}/${keyName}`, method: "GET" });

    const existing = current.data.webSettings?.allowedDomains ?? [];
    if (existing.some((d) => d.toLowerCase() === domain)) {
      return { ok: true, alreadyPresent: true };
    }
    if (existing.length >= MAX_RECAPTCHA_DOMAINS) {
      return { ok: false, reason: "cap_reached" };
    }

    await client.request({
      url: `${KEYS_BASE}/${keyName}?updateMask=webSettings.allowedDomains`,
      method: "PATCH",
      data: {
        name: keyName,
        webSettings: { allowedDomains: [...existing, domain] },
      },
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: "request_error" };
  }
}

/** Current count of allowed domains on the key (for UI cap warnings); null on error. */
export async function getRecaptchaDomainCount(): Promise<number | null> {
  const res = keyResource();
  if (!res) return null;
  try {
    const client = await getAuth().getClient();
    const current = await client.request<{
      webSettings?: { allowedDomains?: string[] };
    }>({
      url: `${KEYS_BASE}/projects/${res.project}/keys/${res.siteKey}`,
      method: "GET",
    });
    return current.data.webSettings?.allowedDomains?.length ?? 0;
  } catch {
    return null;
  }
}
