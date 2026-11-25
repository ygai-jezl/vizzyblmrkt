import { badId, limitPerUser, ok, onboardingAdmin, refused } from "@/lib/onboarding/api";
import { removeBusinessFact } from "@/lib/onboarding/store";
import { isFactId } from "@/lib/types/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ factId: string }> };

const REMOVE_LIMIT = { prefix: "onboarding_fact_remove", burstLimit: 20, hourlyLimit: 200 };

/**
 * Remove a kept fact (admins): its words go for good, and Vizzy reads the profile again. Works
 * with the switch off too, so kept words can always be removed. The brand is the session's.
 */
export async function DELETE(req: Request, { params }: RouteParams) {
  const g = await onboardingAdmin(req, { need: "none" });
  if (!g.ok) return g.response;
  const { factId } = await params;
  if (!isFactId(factId)) return badId("factId");
  const limited = await limitPerUser(g.ctx, REMOVE_LIMIT);
  if (limited) return limited;
  const r = await removeBusinessFact(g.ctx, factId);
  return r.ok ? ok({ ok: true }) : refused(r);
}
