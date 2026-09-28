import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { restoreCatalogVersion } from "@/lib/connect/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bring back an earlier version of the catalog (saved as a new version). */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string; rev: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { connectionId, rev } = await params;
  return respond(await restoreCatalogVersion(gate.ctx, connectionId, /^\d{1,9}$/.test(rev) ? Number(rev) : -1, await readJson(req)));
}
