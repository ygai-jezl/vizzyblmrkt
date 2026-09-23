import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { importJourney } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a draft journey from an exported document ({ connectionId, name?, document }). */
export async function POST(req: Request) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  return respond(await importJourney(gate.ctx, await readJson(req)));
}
