import { GoogleAuth } from "google-auth-library";

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
