import { brandMapAdmin, brandMapReader } from "@/lib/brandMap/adminApi";
import { isBrandMapImportEnabled } from "@/lib/brandMap/flags";
import { importFromRequest, removeImportFromRequest } from "@/lib/brandMap/importsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMPORT = { on: isBrandMapImportEnabled, offError: "import_disabled" };

type RouteParams = { params: Promise<{ importId: string }> };

/** One import, item by item; removing it (what was added from it stays on the map). Members read; admins remove. */
export async function GET(req: Request, { params }: RouteParams) {
  const g = await brandMapReader(req, IMPORT);
  if (!g.ok) return g.response;
  const { importId } = await params;
  return importFromRequest(g.ctx, importId);
}

export async function DELETE(req: Request, { params }: RouteParams) {
  const g = await brandMapAdmin(req, IMPORT);
  if (!g.ok) return g.response;
  const { importId } = await params;
  return removeImportFromRequest(g.ctx, importId);
}
