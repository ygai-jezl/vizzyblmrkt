import { NextResponse } from "next/server";
import { createTenant, forTenant, TenantIsolationError } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DEV-ONLY seed: creates the first tenant + a demo campaign so the hosted
 * landing page has something to render. Hard-guarded:
 *   - 404 unless ALLOW_SEED === "true" (off by default → inert in prod builds)
 *   - 403 on any *-prod project
 *   - 403 unless x-seed-secret matches SEED_SECRET (when that env is set)
 * Idempotent: re-running reports "exists" instead of overwriting.
 */
const TENANT_ID = "ten_vzb";
const CAMPAIGN_ID = "beta-launch";

const ALLOWED_ORIGINS = [
  "http://localhost:3002",
  "http://localhost:3099",
  "https://vizzybl-marketing-dev--vizzybl-marketing-dev.us-central1.hosted.app",
  "https://vizzybl-marketing-prod--vizzybl-marketing-prod.us-central1.hosted.app",
  "https://vizzybl.ai",
  "https://waitlist.vizzybl.ai",
];

export async function POST(req: Request) {
  if (process.env.ALLOW_SEED !== "true") {
    return new NextResponse("Not found", { status: 404 });
  }
  if ((process.env.GOOGLE_CLOUD_PROJECT ?? "").endsWith("-prod")) {
    return NextResponse.json({ error: "seeding disabled on prod" }, { status: 403 });
  }
  const secret = process.env.SEED_SECRET;
  if (secret && req.headers.get("x-seed-secret") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const now = new Date().toISOString();
  const result = { tenant: "created", campaign: "created" };

  try {
    await createTenant({
      id: TENANT_ID,
      tenantName: "Vizzybl AI",
      rootDomain: "vizzybl.ai",
      status: "active",
      region: "us",
      allowedOrigins: ALLOWED_ORIGINS,
      billingTier: "mvp_free",
      ownerId: "seed",
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (err instanceof TenantIsolationError) result.tenant = "exists";
    else throw err;
  }

  const ctx: TenantContext = { tenantId: TENANT_ID, region: "us", source: "system" };
  try {
    await forTenant(ctx).campaigns.create(CAMPAIGN_ID, {
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

  return NextResponse.json({
    ok: true,
    ...result,
    hostedPage: `/waitlist/${CAMPAIGN_ID}`,
  });
}
