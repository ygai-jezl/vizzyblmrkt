import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { createJourney, listJourneys } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lifecycle journeys (optionally for one connection), plus the connections to build on. */
export async function GET(req: Request) {
  const gate = await lifecycleAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const connectionId = new URL(req.url).searchParams.get("connectionId") ?? undefined;
  return respond(await listJourneys(gate.ctx, { connectionId }));
}

/** New journey from a template (a draft — nothing sends until it's published). */
export async function POST(req: Request) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  return respond(await createJourney(gate.ctx, await readJson(req)));
}
