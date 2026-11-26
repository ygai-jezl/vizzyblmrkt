import { z } from "zod";
import { fail, invalidInput, limitPerUser, ok } from "@/lib/onboarding/api";
import { nextActionAdmin } from "@/lib/nextAction/api";
import { recordStepOutcome } from "@/lib/nextAction/service";
import { CARD_ID_RE, NEXT_ACTION_LIMITS, STEP_KEYS } from "@/lib/types/nextAction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    cardId: z.string().regex(CARD_ID_RE),
    step: z.enum(STEP_KEYS),
    outcome: z.enum(["done", "dismissed", "answered"]),
    reason: z.string().max(NEXT_ACTION_LIMITS.REASON * 2).nullable().optional(),
    choice: z.number().int().min(0).max(NEXT_ACTION_LIMITS.MAX_CHIPS - 1).nullable().optional(),
  })
  .strict()
  .refine((b) => b.outcome !== "answered" || (b.choice !== null && b.choice !== undefined), { message: "an answer needs its choice", path: ["choice"] });

const OUTCOME_LIMIT = { prefix: "next_action_outcome", burstLimit: 20, hourlyLimit: 200 };

const STATUS: Record<string, number> = { not_found: 404, card_changed: 409, already_decided: 409, not_this_step: 400, no_user: 401 };

/**
 * What the founder did with one step of Your next action (admins, NEXT_ACTION_CARD_ENABLED): done
 * (they pressed its button), answered (a quick question's answer, by its place) or dismissed (with
 * an optional reason, their own words). The step's agent action moves in the same transaction. The
 * card and the step are named by id; their words come from the card as stored, never from here.
 */
export async function POST(req: Request) {
  const g = await nextActionAdmin(req);
  if (!g.ok) return g.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidInput(parsed.error.issues);
  const limited = await limitPerUser(g.ctx, OUTCOME_LIMIT);
  if (limited) return limited;
  const r = await recordStepOutcome(g.ctx, parsed.data);
  if (!r.ok) return fail(STATUS[r.error] ?? 409, r.error);
  return ok({ ok: true, suggestion: r.suggestion });
}
