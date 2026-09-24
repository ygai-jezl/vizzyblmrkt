import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { duplicateJourneyTo } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Copy the journey onto another product ({ connectionId, name?, which? }) as a new draft. */
export async function POST(req: Request, { params }: { params: Promise<{ journeyId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true, journeys: true });
  if (!gate.ok) return gate.response;
  return respond(await duplicateJourneyTo(gate.ctx, (await params).journeyId, await readJson(req)));
}
