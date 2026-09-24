import { respond } from "@/lib/connect/admin";
import { invitesAdmin } from "@/lib/invites/admin";
import { previewWave } from "@/lib/invites/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who a draft would reach, and a rendered sample (sends nothing). */
export async function POST(req: Request, { params }: { params: Promise<{ campaignId: string; waveId: string }> }) {
  const gate = await invitesAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { campaignId, waveId } = await params;
  return respond(await previewWave(gate.ctx, campaignId, waveId));
}
