import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { translationsAction, translationsView } from "@/lib/i18n/translationsAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A journey's emails in other languages (ASSET_TRANSLATIONS_ENABLED; 503 while off). GET: each
 * email's tab per language and the brand's languages with their readers (members may look).
 * POST (admins): approve, approve_all, save or make.
 */
export async function GET(req: Request, { params }: { params: Promise<{ journeyId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: false, journeys: true });
  if (!gate.ok) return gate.response;
  return respond(await translationsView(gate.ctx, (await params).journeyId));
}

export async function POST(req: Request, { params }: { params: Promise<{ journeyId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true, journeys: true });
  if (!gate.ok) return gate.response;
  return respond(await translationsAction(gate.ctx, (await params).journeyId, await readJson(req)));
}
