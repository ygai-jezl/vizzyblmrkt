import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { stopEnrolment } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Take one user out of the journey. */
export async function POST(req: Request, { params }: { params: Promise<{ enrolmentId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  return respond(await stopEnrolment(gate.ctx, (await params).enrolmentId));
}
