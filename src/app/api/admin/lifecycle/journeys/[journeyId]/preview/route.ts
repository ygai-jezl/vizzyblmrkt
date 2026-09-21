import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { previewJourney } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Dry-run the draft for an imagined user: when each email would go out. */
export async function POST(req: Request, { params }: { params: Promise<{ journeyId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  return respond(await previewJourney(gate.ctx, (await params).journeyId, await readJson(req)));
}
