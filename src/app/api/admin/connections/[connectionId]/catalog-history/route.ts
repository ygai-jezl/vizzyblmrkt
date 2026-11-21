import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { getCatalogHistory } from "@/lib/connect/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The catalog's saved versions, newest first, a page at a time (?cursor=<rev>): what changed, who saved it and when. */
export async function GET(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  const raw = new URL(req.url).searchParams.get("cursor");
  const cursor = raw && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
  return respond(await getCatalogHistory(gate.ctx, connectionId, undefined, { cursor }));
}
