import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { getJourneyDetail, patchJourney } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ journeyId: string }> };

/** The journey (draft + delivery), its connection's catalog, and the draft's issues. */
export async function GET(req: Request, { params }: Params) {
  const gate = await lifecycleAdmin(req, { mutate: false, journeys: true });
  if (!gate.ok) return gate.response;
  return respond(await getJourneyDetail(gate.ctx, (await params).journeyId));
}

/** Name, delivery mode, test recipients, shadow inbox, caps. */
export async function PATCH(req: Request, { params }: Params) {
  const gate = await lifecycleAdmin(req, { mutate: true, journeys: true });
  if (!gate.ok) return gate.response;
  return respond(await patchJourney(gate.ctx, (await params).journeyId, await readJson(req)));
}
