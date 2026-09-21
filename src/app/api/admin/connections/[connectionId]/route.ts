import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { getConnectionDetail, patchConnection, revokeProductConnection } from "@/lib/connect/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ connectionId: string }> };

export async function GET(req: Request, { params }: Params) {
  const gate = await lifecycleAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await getConnectionDetail(gate.ctx, connectionId));
}

/** Update settings: name, pause/resume, endpoints, link domains, catalog, consent. */
export async function PATCH(req: Request, { params }: Params) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await patchConnection(gate.ctx, connectionId, await readJson(req)));
}

/** Revoke: the key stops routing at once and the secrets are destroyed. */
export async function DELETE(req: Request, { params }: Params) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await revokeProductConnection(gate.ctx, connectionId));
}
