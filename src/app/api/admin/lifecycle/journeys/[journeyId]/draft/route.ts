import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { saveDraft } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Save the draft (graph + pools + settings). The published version is untouched. */
export async function PUT(req: Request, { params }: { params: Promise<{ journeyId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  return respond(await saveDraft(gate.ctx, (await params).journeyId, await readJson(req)));
}
