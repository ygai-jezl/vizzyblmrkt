import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isNavV2Phase2Enabled } from "@/lib/nav/flags";
import { REVEALABLE, revealKeysOf } from "@/lib/nav/reveal";
import { invalidInput, limitPerUser } from "@/lib/onboarding/api";
import { isOnboardingEnabled } from "@/lib/onboarding/flags";
import { addSidebarShown } from "@/lib/tenant/control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A click each, at most once per section per brand; this only stops a loop hammering the brand's record. */
const OPEN_LIMIT = { prefix: "nav_open", burstLimit: 20, hourlyLimit: 120 };

const Body = z.object({ key: z.enum(REVEALABLE) }).strict();

const json = (status: number, body: unknown) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Open early in the sidebar's Coming up, or a waiting section's page opened another way (⌘K, a
 * link): show that section for good (ONBOARDING_ENABLED, nav v2 phase 2). Recorded per brand as the
 * section and when, with no user id. Any member may, since it only adds a link ⌘K already reaches.
 * 409 `no_profile` for a brand without Coming up: this never starts it. The brand is the session's.
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isOnboardingEnabled() || !isNavV2Phase2Enabled()) return json(404, { error: "not_found" });
  const ctx = await getAdminContext();
  if (!ctx) return json(401, { error: "unauthorized" });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidInput(parsed.error.issues);
  const limited = await limitPerUser(ctx, OPEN_LIMIT);
  if (limited) return limited;

  const { key } = parsed.data;
  const shown = await addSidebarShown(ctx.tenantId, [key], { key, at: new Date().toISOString() });
  if (!shown) return json(409, { error: "no_profile" });
  return json(200, { shown: revealKeysOf(shown) });
}
