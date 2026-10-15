import { brandMapAdmin, brandMapReader } from "@/lib/brandMap/adminApi";
import { isBrandMapImportEnabled } from "@/lib/brandMap/flags";
import { listImportsFromRequest, uploadImportFromRequest } from "@/lib/brandMap/importsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMPORT = { on: isBrandMapImportEnabled, offError: "import_disabled" };

/**
 * Research from a PDF: a brand's imports, and uploading one (PDF only, 14 MB at most, read
 * and dropped; only what it found is kept). Members read; admins upload.
 */
export async function GET(req: Request) {
  const g = await brandMapReader(req, IMPORT);
  if (!g.ok) return g.response;
  return listImportsFromRequest(g.ctx);
}

export async function POST(req: Request) {
  const g = await brandMapAdmin(req, IMPORT);
  if (!g.ok) return g.response;
  return uploadImportFromRequest(g.ctx, await req.formData().catch(() => null));
}
