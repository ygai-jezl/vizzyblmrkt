import { z } from "zod";
import { badInput, jsonBody, respond, workAdmin } from "@/lib/work/http";
import { AddTaskBodySchema } from "@/lib/work/inputs";
import { refuse } from "@/lib/work/result";
import { addSuggestion, dismissSuggestion } from "@/lib/work/suggestions";
import { DECLINE_WHY, isAgentActionId } from "@/lib/types/agentAction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ actionId: string }> };

/**
 * A person's decision on a task Vizzy suggests (WORK_ENABLED), from Review:
 * - `add` with no task: Add to Work, the task as Vizzy suggested it;
 * - `add` with a task: Edit then add, the task as the person sent it from the add page;
 * - `dismiss`, with the reason they tapped (Not now, Not for us, Already on it, Wrong) or none.
 * `rev` is the suggestion as the person saw it: one that changed since is refused. The origin, what
 * Vizzy proposed and which fields were edited are worked out on the server, never read from here.
 */
const DecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("add"), rev: z.number().int().min(1), task: AddTaskBodySchema.optional() }).strict(),
  z.object({ decision: z.literal("dismiss"), rev: z.number().int().min(1), why: z.enum(DECLINE_WHY).optional() }).strict(),
]);

export async function POST(req: Request, { params }: Params) {
  const gate = await workAdmin(req);
  if (!gate.ok) return gate.response;
  const { actionId } = await params;
  if (!isAgentActionId(actionId)) return respond(refuse("suggestion_missing"));
  const parsed = DecisionSchema.safeParse(await jsonBody(req));
  if (!parsed.success) return badInput(parsed.error);
  const body = parsed.data;
  if (body.decision === "dismiss") return respond(await dismissSuggestion(gate.scope, { actionId, rev: body.rev, ...(body.why ? { why: body.why } : {}) }));
  return respond(await addSuggestion(gate.scope, { actionId, rev: body.rev, ...(body.task ? { task: body.task } : {}) }));
}
