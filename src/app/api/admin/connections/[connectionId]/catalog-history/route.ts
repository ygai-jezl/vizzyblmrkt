import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { getCatalogHistory } from "@/lib/connect/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The catalog's last saved versions: what changed, who saved it and when. */
export async function GET(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await getCatalogHistory(gate.ctx, connectionId));
}
