import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { generateJourneyDraft } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The canvas's Generate button: rebuild the DRAFT from the template with fresh
 * on-brand copy — the same architect Vizzy uses from the chat. Replaces the
 * draft only; the published version is untouched.
 */
export async function POST(req: Request, { params }: { params: Promise<{ journeyId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  return respond(await generateJourneyDraft(gate.ctx, (await params).journeyId, await readJson(req)));
}
