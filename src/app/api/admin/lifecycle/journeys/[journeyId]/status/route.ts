import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { setJourneyStatus } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pause, resume or archive. */
export async function POST(req: Request, { params }: { params: Promise<{ journeyId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true, journeys: true });
  if (!gate.ok) return gate.response;
  return respond(await setJourneyStatus(gate.ctx, (await params).journeyId, await readJson(req)));
}
