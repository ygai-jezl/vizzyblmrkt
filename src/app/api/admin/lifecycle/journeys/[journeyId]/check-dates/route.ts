import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { checkJourneyDates } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Check now": run today's check for a journey that starts when a date passes, instead of waiting for the daily one. */
export async function POST(req: Request, { params }: { params: Promise<{ journeyId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true, journeys: true });
  if (!gate.ok) return gate.response;
  return respond(await checkJourneyDates(gate.ctx, (await params).journeyId));
}
