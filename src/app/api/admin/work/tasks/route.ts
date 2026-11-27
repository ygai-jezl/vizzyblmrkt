import { badInput, jsonBody, respond, respondChanged, workAdmin } from "@/lib/work/http";
import { AddTaskBodySchema, filtersOf } from "@/lib/work/inputs";
import { addTask, listTasks } from "@/lib/work/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Work's one list (WORK_ENABLED): every task the person sees across the organisation's brands and
 * regions, with the filters in the address (brand, stage, status, must, due, kind), checks due
 * first, then Must have, then the most recently changed. Names the regions that didn't answer.
 */
export async function GET(req: Request) {
  const gate = await workAdmin(req);
  if (!gate.ok) return gate.response;
  return respond(await listTasks(gate.scope, filtersOf(new URL(req.url).searchParams)));
}

/**
 * Add a task (quick add or the add page). The origin is the person, set here; the brand's region
 * and the ref come from the server. Members tag only their own brand.
 */
export async function POST(req: Request) {
  const gate = await workAdmin(req);
  if (!gate.ok) return gate.response;
  const parsed = AddTaskBodySchema.safeParse(await jsonBody(req));
  if (!parsed.success) return badInput(parsed.error);
  return respondChanged(gate.scope, await addTask(gate.scope, parsed.data));
}
