import { forTenant, TenantIsolationError } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { Signup, Answer } from "@/lib/types/signup";
import { computeScore } from "./scoring";
import {
  normalizeEmail,
  generateReferralToken,
  generateVerificationToken,
  deterministicSignupId,
} from "./identifiers";
import type { SignupInput } from "./signupInput";
import { appendTenantParam } from "@/lib/http/tenantParam";

export interface CreateSignupOptions {
  /** Injected fake Firestore for tests. */
  db?: FirestoreLike;
  /** Base origin used to build a referral link when the campaign has no URL. */
  hostedPageBaseUrl?: string;
  /** Whether reCAPTCHA passed a real (non-skipped) assessment. */
  captchaValid?: boolean;
  /**
   * Tenant id to carry on the referral link (`?t=`) when the hosted page is on
   * the shared platform host. Omit for custom-domain hosting (origin-resolved).
   */
  tenantId?: string;
  /** ISO timestamp; injectable for deterministic tests. */
  now?: string;
  /**
   * Visitor's resolved content language (BCP-47 base code), already clamped to the
   * launch's supported set by the route. Stored so emails match the signup language.
   */
  locale?: string | null;
}

export interface SignupResult {
  signup: Signup;
  /** true when this email/phone had already joined (idempotent re-submit). */
  alreadyJoined: boolean;
  totalSignups: number;
}

function buildReferralLink(
  campaign: Campaign,
  token: string,
  hostedPageBaseUrl?: string,
  tenantId?: string,
): string {
  // A custom waitlist URL is the customer's own page (origin-resolved); only the
  // platform-hosted fallback needs the tenant hint to resolve on the shared host.
  if (campaign.waitlistUrlLocation) {
    const base = campaign.waitlistUrlLocation;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}ref=${token}`;
  }
  const base = `${hostedPageBaseUrl ?? ""}/waitlist/${campaign.id}?ref=${token}`;
  return appendTenantParam(base, tenantId);
}

function buildAnswers(campaign: Campaign, input: SignupInput): Answer[] | undefined {
  if (!input.answers?.length) return undefined;
  const optionalByQuestion = new Map(
    campaign.questions.map((q) => [q.question_value, q.optional]),
  );
  return input.answers.map((a) => ({
    question_value: a.question_value,
    optional: optionalByQuestion.get(a.question_value) ?? true,
    answer_value: a.answer_value,
  }));
}

/**
 * Create a waitlist signup. Idempotent: the document id is derived from
 * (campaign, contact), so a duplicate submit returns the existing signup
 * (alreadyJoined=true) rather than creating or overwriting. All security/state
 * fields (tenantId, score, status, verified) are set here — never from input.
 */
export async function createSignup(
  ctx: TenantContext,
  campaign: Campaign,
  input: SignupInput,
  opts: CreateSignupOptions = {},
): Promise<SignupResult> {
  const repo = forTenant(ctx, opts.db);

  const email = input.email ? normalizeEmail(input.email) : null;
  const phone = input.phone?.trim() || null;
  const contactKey = email ?? phone ?? "";
  const id = deterministicSignupId(campaign.id, contactKey);

  const referralToken = generateReferralToken();
  const verified = !campaign.usesSignupVerification;
  const status: Signup["status"] = verified ? "verified_active" : "unverified";
  // Double opt-in: an unverified signup gets a token to confirm via email.
  const verificationToken = verified ? null : generateVerificationToken();
  const now = opts.now ?? new Date().toISOString();

  const data = {
    campaignId: campaign.id,
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    email,
    phone,
    verified,
    captchaValid: opts.captchaValid ?? false,
    isSpam: false,
    status,
    amountReferred: 0,
    referralToken,
    referralLink: buildReferralLink(
      campaign,
      referralToken,
      opts.hostedPageBaseUrl,
      opts.tenantId,
    ),
    referredBySignupToken: input.referredBySignupToken ?? null,
    verificationToken,
    score: computeScore(0, campaign.spotsToMoveUponReferral),
    removedDate: null,
    removedPriority: null,
    metadata: input.metadata,
    answers: buildAnswers(campaign, input),
    utm:
      input.utm && Object.values(input.utm).some(Boolean) ? input.utm : undefined,
    referrerUrl: input.referrerUrl || null,
    locale: opts.locale ?? null,
    createdAt: now,
  };

  let signup: Signup;
  let alreadyJoined = false;
  try {
    signup = await repo.signups.create(id, data as never);
  } catch (err) {
    // Atomic create() rejects an existing id as TenantIsolationError. Within a
    // tenant-scoped repo that means this contact already signed up → idempotent.
    if (err instanceof TenantIsolationError) {
      const existing = await repo.signups.getById(id);
      if (!existing) throw err;
      signup = existing;
      alreadyJoined = true;
    } else {
      throw err;
    }
  }

  const totalSignups = await repo.signups.count([
    ["campaignId", "==", campaign.id],
  ]);

  return { signup, alreadyJoined, totalSignups };
}
