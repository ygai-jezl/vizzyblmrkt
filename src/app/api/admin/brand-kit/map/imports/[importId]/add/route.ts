import { brandMapAdmin } from "@/lib/brandMap/adminApi";
import { isBrandMapImportEnabled } from "@/lib/brandMap/flags";
import { addImportedFromRequest } from "@/lib/brandMap/importsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ importId: string }> };

/** "Add ticked": the ticked items of an import go on the map, decided. Admin-only. */
export async function POST(req: Request, { params }: RouteParams) {
  const g = await brandMapAdmin(req, { on: isBrandMapImportEnabled, offError: "import_disabled" });
  if (!g.ok) return g.response;
  const { importId } = await params;
  return addImportedFromRequest(g.ctx, importId, await req.json().catch(() => null));
}
