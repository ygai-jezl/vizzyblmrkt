import { brandMapAdmin, brandMapReader } from "@/lib/brandMap/adminApi";
import { isBrandMapSituationsEnabled } from "@/lib/brandMap/flags";
import { editSituationFromRequest, removeSituationFromRequest, situationFromRequest } from "@/lib/brandMap/situationsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SITUATIONS = { on: isBrandMapSituationsEnabled, offError: "situations_disabled" };

type RouteParams = { params: Promise<{ situationId: string }> };

/**
 * One buying situation with its questions; editing it (naming the revision it started from,
 * or starring it) and removing it. Members read; admins change.
 */
export async function GET(req: Request, { params }: RouteParams) {
  const g = await brandMapReader(req, SITUATIONS);
  if (!g.ok) return g.response;
  const { situationId } = await params;
  return situationFromRequest(g.ctx, situationId);
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const g = await brandMapAdmin(req, SITUATIONS);
  if (!g.ok) return g.response;
  const { situationId } = await params;
  return editSituationFromRequest(g.ctx, situationId, await req.json().catch(() => null));
}

export async function DELETE(req: Request, { params }: RouteParams) {
  const g = await brandMapAdmin(req, SITUATIONS);
  if (!g.ok) return g.response;
  const { situationId } = await params;
  return removeSituationFromRequest(g.ctx, situationId);
}
