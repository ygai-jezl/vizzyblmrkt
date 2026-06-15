import { createTenant, forTenant, TenantIsolationError } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";

/**
 * Demo seed: the first tenant + a beta campaign, so the hosted landing page has
 * something to render. Shared by the dev seed route and the CLI seed script.
 * Idempotent — re-running reports "exists" instead of overwriting.
 */
export const SEED_TENANT_ID = "ten_vzb";
export const SEED_CAMPAIGN_ID = "beta-launch";
/** Second demo campaign with double opt-in ON (for testing email verification). */
export const SEED_VERIFY_CAMPAIGN_ID = "beta-verify";

export const SEED_ALLOWED_ORIGINS = [
  "http://localhost:3002",
  "http://localhost:3099",
  "https://vizzybl-marketing-dev--vizzybl-marketing-dev.us-central1.hosted.app",
  "https://vizzybl-marketing-prod--vizzybl-marketing-prod.us-central1.hosted.app",
  "https://vizzybl.ai",
  "https://waitlist.vizzybl.ai",
];

export interface SeedResult {
  tenant: "created" | "exists";
  campaign: "created" | "exists";
  hostedPage: string;
}

export async function seedDemoData(): Promise<SeedResult> {
  const now = new Date().toISOString();
  const result: SeedResult = {
    tenant: "created",
    campaign: "created",
    hostedPage: `/waitlist/${SEED_CAMPAIGN_ID}`,
  };

  try {
    await createTenant({
      id: SEED_TENANT_ID,
      tenantName: "Vizzybl AI",
      rootDomain: "vizzybl.ai",
      status: "active",
      region: "us",
      allowedOrigins: SEED_ALLOWED_ORIGINS,
      billingTier: "mvp_free",
      ownerId: "seed",
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (err instanceof TenantIsolationError) result.tenant = "exists";
    else throw err;
  }

  const ctx: TenantContext = {
    tenantId: SEED_TENANT_ID,
    region: "us",
    source: "system",
  };
  try {
    await forTenant(ctx).campaigns.create(SEED_CAMPAIGN_ID, {
      waitlistName: "Vizzybl Beta",
      waitlistUrlLocation: null,
      spotsToMoveUponReferral: 10,
      usesFirstnameLastname: false,
      usesLeaderboard: true,
      usesSignupVerification: false,
      hideCounts: false,
      removeWidgetHeaders: false,
      requiredContactDetail: "EMAIL",
      questions: [
        {
          question_value: "What will you use Vizzybl for?",
          optional: true,
          answer_value: null,
        },
      ],
      twitterMessage: "I just joined the Vizzybl waitlist!",
      sendEmailCongratulationsOnReferral: true,
      leaderboardLength: 5,
      configurationStyleJson: {
        widgetBackgroundColor: "#4937E7",
        widgetButtonColor: "#111827",
        widgetFontColor: "#111827",
        statusDescription: "You're on the list!",
      },
      createdAt: now,
    } as never);
  } catch (err) {
    if (err instanceof TenantIsolationError) result.campaign = "exists";
    else throw err;
  }

  // Second campaign with double opt-in enabled (idempotent).
  try {
    await forTenant(ctx).campaigns.create(SEED_VERIFY_CAMPAIGN_ID, {
      waitlistName: "Vizzybl Beta (verified)",
      waitlistUrlLocation: null,
      spotsToMoveUponReferral: 10,
      usesFirstnameLastname: false,
      usesLeaderboard: true,
      usesSignupVerification: true,
      hideCounts: false,
      removeWidgetHeaders: false,
      requiredContactDetail: "EMAIL",
      questions: [],
      twitterMessage: "I just joined the Vizzybl waitlist!",
      sendEmailCongratulationsOnReferral: true,
      leaderboardLength: 5,
      configurationStyleJson: {
        widgetButtonColor: "#111827",
        statusDescription: "You're on the list!",
      },
      createdAt: now,
    } as never);
  } catch (err) {
    if (!(err instanceof TenantIsolationError)) throw err;
  }

  return result;
}
