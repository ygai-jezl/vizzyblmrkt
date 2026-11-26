import { badInput, jsonBody, respond, workAdmin } from "@/lib/work/http";
import { DecisionBodySchema } from "@/lib/work/inputs";
import { recordDecision } from "@/lib/work/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record a decision on a task (WORK_ENABLED), plan approvals among them. Append only: a changed
 * mind is a new row. Who recommended a pick never comes from the request: a person's own decision
 * has none, and a plan approval never has one.
 */
export async function POST(req: Request) {
  const gate = await workAdmin(req);
  if (!gate.ok) return gate.response;
  const parsed = DecisionBodySchema.safeParse(await jsonBody(req));
  if (!parsed.success) return badInput(parsed.error);
  return respond(await recordDecision(gate.scope, parsed.data));
}
