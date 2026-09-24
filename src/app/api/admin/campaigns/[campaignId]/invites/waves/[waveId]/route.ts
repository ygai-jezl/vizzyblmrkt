import { readJson, respond } from "@/lib/connect/admin";
import { invitesAdmin } from "@/lib/invites/admin";
import { getWave, patchWave, removeWave } from "@/lib/invites/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ campaignId: string; waveId: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const gate = await invitesAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { campaignId, waveId } = await params;
  return respond(await getWave(gate.ctx, campaignId, waveId));
}

/** Edit a draft wave. */
export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await invitesAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { campaignId, waveId } = await params;
  return respond(await patchWave(gate.ctx, campaignId, waveId, await readJson(req)));
}

/** Delete a draft wave. */
export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await invitesAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { campaignId, waveId } = await params;
  return respond(await removeWave(gate.ctx, campaignId, waveId));
}
