import { brandMapAdmin } from "@/lib/brandMap/adminApi";
import { isBrandMapImportEnabled } from "@/lib/brandMap/flags";
import { placeImportFromRequest } from "@/lib/brandMap/importsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ importId: string }> };

/** Place a batch of an import's items on the map (a step of its run). Nothing is added. Admin-only. */
export async function POST(req: Request, { params }: RouteParams) {
  const g = await brandMapAdmin(req, { on: isBrandMapImportEnabled, offError: "import_disabled" });
  if (!g.ok) return g.response;
  const { importId } = await params;
  return placeImportFromRequest(g.ctx, importId, await req.json().catch(() => null));
}
