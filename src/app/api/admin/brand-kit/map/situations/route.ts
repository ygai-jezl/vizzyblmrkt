import { brandMapAdmin, brandMapReader } from "@/lib/brandMap/adminApi";
import { isBrandMapSituationsEnabled } from "@/lib/brandMap/flags";
import { createSituationFromRequest, listSituationsFromRequest } from "@/lib/brandMap/situationsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SITUATIONS = { on: isBrandMapSituationsEnabled, offError: "situations_disabled" };

/**
 * A brand's buying situations, and adding one by hand. Members read; admins change.
 */
export async function GET(req: Request) {
  const g = await brandMapReader(req, SITUATIONS);
  if (!g.ok) return g.response;
  return listSituationsFromRequest(g.ctx);
}

export async function POST(req: Request) {
  const g = await brandMapAdmin(req, SITUATIONS);
  if (!g.ok) return g.response;
  return createSituationFromRequest(g.ctx, await req.json().catch(() => null));
}
