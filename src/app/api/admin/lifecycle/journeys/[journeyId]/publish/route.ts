import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { publishJourney } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Publish the saved draft as the next version (422 with the issues if it isn't valid). */
export async function POST(req: Request, { params }: { params: Promise<{ journeyId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true, journeys: true });
  if (!gate.ok) return gate.response;
  // The body is optional: `{ existingSignups }` answers the order guard's question.
  const body = await req.json().catch(() => undefined);
  return respond(await publishJourney(gate.ctx, (await params).journeyId, body));
}
