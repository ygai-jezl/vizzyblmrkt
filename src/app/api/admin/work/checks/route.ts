import { badInput, jsonBody, respondChanged, workAdmin } from "@/lib/work/http";
import { CheckActionBodySchema } from "@/lib/work/inputs";
import { actOnCheck } from "@/lib/work/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A task's check (WORK_ENABLED): Mark checked, Look again (Review's Tomorrow), or the one tap read
 * on a measure's check (Better, Same, Worse, Too soon to tell). A read is taken only on a
 * measure's check, and a measure's check only takes a read or a new date. Review's Done and
 * Tomorrow send Mark checked and Look again, with via review_check.
 */
export async function POST(req: Request) {
  const gate = await workAdmin(req);
  if (!gate.ok) return gate.response;
  const parsed = CheckActionBodySchema.safeParse(await jsonBody(req));
  if (!parsed.success) return badInput(parsed.error);
  return respondChanged(gate.scope, await actOnCheck(gate.scope, parsed.data));
}
