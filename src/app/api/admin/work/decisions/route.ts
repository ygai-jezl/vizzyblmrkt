import { badInput, jsonBody, respond, workAdmin } from "@/lib/work/http";
import { DecisionBodySchema } from "@/lib/work/inputs";
import { saveDecisionDraft } from "@/lib/work/drafts";
import { recordDecision } from "@/lib/work/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record a decision on a task (WORK_ENABLED), plan approvals among them. Append only: a changed
 * mind is a new row. Who recommended a pick never comes from the request: a person's own decision
 * has none, and a plan approval never has one. With `draft`, the person chooses on a decision
 * Vizzy drafted: its question, options and pick come from the stored draft only, and a draft is
 * never a plan approval.
 */
export async function POST(req: Request) {
  const gate = await workAdmin(req);
  if (!gate.ok) return gate.response;
  const parsed = DecisionBodySchema.safeParse(await jsonBody(req));
  if (!parsed.success) return badInput(parsed.error);
  const body = parsed.data;
  return respond(body.draft ? await saveDecisionDraft(gate.scope, { ...body, draft: body.draft }) : await recordDecision(gate.scope, body));
}
