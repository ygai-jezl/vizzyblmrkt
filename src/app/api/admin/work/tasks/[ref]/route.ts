import { badInput, jsonBody, refParam, respond, respondChanged, workAdmin } from "@/lib/work/http";
import { EditTaskBodySchema } from "@/lib/work/inputs";
import { refuse } from "@/lib/work/result";
import { editTask, removeTask, taskPage } from "@/lib/work/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ ref: string }> };

/**
 * One task by its ref (WORK_ENABLED), with its decisions, its plan links' approvals and, on a due
 * measure's check, what Work counted. A task the person can't see answers 404, never 403.
 */
export async function GET(req: Request, { params }: Params) {
  const gate = await workAdmin(req);
  if (!gate.ok) return gate.response;
  const ref = refParam((await params).ref);
  if (ref === null) return respond(refuse("not_found"));
  return respond(await taskPage(gate.scope, ref));
}

/** Change a task: its fields, typed links, measure, check, or the idea it became. Review's Start sends the status with via review_ready. */
export async function PATCH(req: Request, { params }: Params) {
  const gate = await workAdmin(req);
  if (!gate.ok) return gate.response;
  const ref = refParam((await params).ref);
  if (ref === null) return respond(refuse("not_found"));
  const parsed = EditTaskBodySchema.safeParse(await jsonBody(req));
  if (!parsed.success) return badInput(parsed.error);
  return respondChanged(gate.scope, await editTask(gate.scope, ref, parsed.data));
}

/** Delete a task (admins and owners). Its log rows stay. */
export async function DELETE(req: Request, { params }: Params) {
  const gate = await workAdmin(req);
  if (!gate.ok) return gate.response;
  const ref = refParam((await params).ref);
  if (ref === null) return respond(refuse("not_found"));
  return respondChanged(gate.scope, await removeTask(gate.scope, ref));
}
