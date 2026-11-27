import { badInput, jsonBody, respond, workAdmin } from "@/lib/work/http";
import { LogEntryBodySchema } from "@/lib/work/inputs";
import { saveLogDraft } from "@/lib/work/drafts";
import { addLogEntry, logDay } from "@/lib/work/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One day of the Log (WORK_ENABLED), today unless `?day=YYYY-MM-DD`: entries, what is in flight,
 * tasks that moved, decisions and, today, the checks due. Days are the session brand's.
 */
export async function GET(req: Request) {
  const gate = await workAdmin(req);
  if (!gate.ok) return gate.response;
  return respond(await logDay(gate.scope, new URL(req.url).searchParams.get("day")));
}

/**
 * Log an entry for today: a workstream, its state, a note, up to 3 links and the task it is about.
 * With `draft`, it saves a note Vizzy drafted, as the person left it, and the draft with it.
 */
export async function POST(req: Request) {
  const gate = await workAdmin(req);
  if (!gate.ok) return gate.response;
  const parsed = LogEntryBodySchema.safeParse(await jsonBody(req));
  if (!parsed.success) return badInput(parsed.error);
  const body = parsed.data;
  return respond(body.draft ? await saveLogDraft(gate.scope, { ...body, draft: body.draft }) : await addLogEntry(gate.scope, body));
}
