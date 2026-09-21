import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { createProductConnection, listConnections } from "@/lib/connect/adminApi";
import { originFromHeaders } from "@/lib/http/origin";
import { platformOrigin } from "@/lib/platform/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Products: the tenant's connected products (secrets never included). */
export async function GET(req: Request) {
  const gate = await lifecycleAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  return respond(await listConnections(gate.ctx));
}

/** Connect a product (custom) or create a Sandbox. Returns the secret ONCE. */
export async function POST(req: Request) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const origin = platformOrigin() || originFromHeaders(req.headers);
  return respond(await createProductConnection(gate.ctx, await readJson(req), { origin }));
}
