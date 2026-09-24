import { readJson, respond } from "@/lib/connect/admin";
import { invitesAdmin } from "@/lib/invites/admin";
import { createWave } from "@/lib/invites/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Draft a new invite wave (nothing is sent until someone presses Send). */
export async function POST(req: Request, { params }: { params: Promise<{ campaignId: string }> }) {
  const gate = await invitesAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { campaignId } = await params;
  return respond(await createWave(gate.ctx, campaignId, await readJson(req)));
}
