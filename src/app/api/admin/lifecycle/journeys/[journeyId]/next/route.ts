import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { continueJourneyTo } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Then continue to…": make another journey ({ nextJourneyId }) start after this one — in ITS draft. */
export async function POST(req: Request, { params }: { params: Promise<{ journeyId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true, journeys: true });
  if (!gate.ok) return gate.response;
  return respond(await continueJourneyTo(gate.ctx, (await params).journeyId, await readJson(req)));
}
