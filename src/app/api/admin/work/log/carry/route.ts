import { badInput, jsonBody, respond, workAdmin } from "@/lib/work/http";
import { CarryBodySchema } from "@/lib/work/inputs";
import { carryOver } from "@/lib/work/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Carry over on Today (WORK_ENABLED): logs today's entry for each workstream still open from
 * yesterday that nobody has logged today, by the person signed in. `day` is the day the page
 * showed, and must be today. Answers the entries it wrote, none when someone carried them first.
 */
export async function POST(req: Request) {
  const gate = await workAdmin(req);
  if (!gate.ok) return gate.response;
  const parsed = CarryBodySchema.safeParse(await jsonBody(req));
  if (!parsed.success) return badInput(parsed.error);
  return respond(await carryOver(gate.scope, parsed.data));
}
