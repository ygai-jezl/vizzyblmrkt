import { createFromRequest, listFromRequest, raiseAdmin, raiseReader } from "@/lib/raise/docs/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Content › Raise kit (RAISE_KIT_ENABLED): the brand's decks, newest first. Any member. */
export async function GET(req: Request) {
  const g = await raiseReader(req);
  if (!g.ok) return g.response;
  return listFromRequest(g.ctx);
}

/** New deck: Vizzy drafts version 1 from what YouGrow knows. Admins, with the Raise kit in the plan. */
export async function POST(req: Request) {
  const g = await raiseAdmin(req);
  if (!g.ok) return g.response;
  return createFromRequest(g.ctx, await req.json().catch(() => null));
}
