import { personViewAdmin } from "@/lib/audience/admin";
import { pretendEngagement } from "@/lib/audience/sandboxEngage";
import { readJson, respond } from "@/lib/connect/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A Sandbox test user opens or clicks the last email they were sent (AUDIENCE_PERSON_VIEW). */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const gate = await personViewAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await pretendEngagement(gate.ctx, connectionId, await readJson(req)));
}
