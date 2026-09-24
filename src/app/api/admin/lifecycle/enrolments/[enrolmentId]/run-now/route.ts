import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { runNow } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Run next step now": skip the wait for a TEST or SHADOW enrolment (never live). */
export async function POST(req: Request, { params }: { params: Promise<{ enrolmentId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true, journeys: true });
  if (!gate.ok) return gate.response;
  return respond(await runNow(gate.ctx, (await params).enrolmentId));
}
