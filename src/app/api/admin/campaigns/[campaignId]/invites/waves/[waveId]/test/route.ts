import { respond } from "@/lib/connect/admin";
import { invitesAdmin } from "@/lib/invites/admin";
import { sendTestInvite } from "@/lib/invites/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Send the draft to yourself as a test (nobody is invited). */
export async function POST(req: Request, { params }: { params: Promise<{ campaignId: string; waveId: string }> }) {
  const gate = await invitesAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { campaignId, waveId } = await params;
  return respond(await sendTestInvite(gate.ctx, campaignId, waveId));
}
