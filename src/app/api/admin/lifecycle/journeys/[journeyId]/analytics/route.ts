import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { journeyAnalytics } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Funnel, per-email sends + engagement, and the onboarding goal. */
export async function GET(req: Request, { params }: { params: Promise<{ journeyId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: false, journeys: true });
  if (!gate.ok) return gate.response;
  return respond(await journeyAnalytics(gate.ctx, (await params).journeyId));
}
