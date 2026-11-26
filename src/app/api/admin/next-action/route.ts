import { z } from "zod";
import { fail, invalidInput, limitPerUser, ok } from "@/lib/onboarding/api";
import { nextActionAdmin } from "@/lib/nextAction/api";
import { composeNextAction, viewAfter } from "@/lib/nextAction/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ reason: z.enum(["state", "another"]) }).strict();
/** Show another: a new card each time, so a few a minute at most. */
const ANOTHER_LIMIT = { prefix: "next_action_another", burstLimit: 3, hourlyLimit: 12 };
/** Home asks when its card is out of date: no model call unless the inputs changed. */
const STATE_LIMIT = { prefix: "next_action_state", burstLimit: 10, hourlyLimit: 120 };

/**
 * Your next action (admins, NEXT_ACTION_CARD_ENABLED): write a new card off Home's request path.
 * `state`: Home's card is out of date (its inputs changed), so a card is written only when the
 * inputs still differ; `another`: the founder pressed Show another. Answers with the card to draw,
 * or `view: null` for the steps list; `failed` when Show another could not write a card, and the
 * card on Home stays. The brand is always the session's.
 */
export async function POST(req: Request) {
  const g = await nextActionAdmin(req);
  if (!g.ok) return g.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidInput(parsed.error.issues);
  const limited = await limitPerUser(g.ctx, parsed.data.reason === "another" ? ANOTHER_LIMIT : STATE_LIMIT);
  if (limited) return limited;
  try {
    const r = await composeNextAction(g.ctx, { reason: parsed.data.reason });
    const view = viewAfter(r, Date.now());
    return ok({ view, composed: r.composed, ...(r.held ? { held: r.held } : {}), ...(r.failed ? { failed: r.failed } : {}) });
  } catch (err) {
    console.warn("[next-action] the card was not written:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return fail(503, "unavailable");
  }
}
