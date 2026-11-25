import { z } from "zod";
import { badId, invalidInput, limitPerUser, ok, onboardingAdmin, refused } from "@/lib/onboarding/api";
import { confirmLearned } from "@/lib/onboarding/store";
import { ProfileAnswersInputSchema } from "@/lib/types/businessProfile";
import { LEARNED_FACT_ID_RE, ONBOARDING_LIMITS, isConversationId } from "@/lib/types/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const CONFIRM_LIMIT = { prefix: "onboarding_confirm", burstLimit: 10, hourlyLimit: 60 };

/** The answers as the page shows them, and which learned facts to keep, by id only: never a fact's words. */
const Body = z
  .object({
    answers: ProfileAnswersInputSchema,
    keep: z.array(z.string().regex(LEARNED_FACT_ID_RE)).max(ONBOARDING_LIMITS.MAX_FACTS_LEARNED),
  })
  .strict();

/**
 * "Looks right" on Here's what I learned (ONBOARDING_ENABLED; admins): save the answers to the
 * brand's profile and keep the picked facts, copied from what the conversation learned. A repeat
 * adds nothing. The brand is the session's, never the body's.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const g = await onboardingAdmin(req, { need: "onboarding" });
  if (!g.ok) return g.response;
  const { id } = await params;
  if (!isConversationId(id)) return badId("id");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidInput(parsed.error.issues);
  const limited = await limitPerUser(g.ctx, CONFIRM_LIMIT);
  if (limited) return limited;

  const r = await confirmLearned(g.ctx, id, parsed.data);
  if (!r.ok) return refused(r);
  return ok({
    profile: r.value.profile,
    kept: r.value.kept.map((f) => ({ id: f.id, kind: f.kind, text: f.text, quote: f.quote, source: f.source, conversationId: f.conversationId, heardAt: f.heardAt })),
    duplicate: r.value.duplicate,
    full: r.value.full,
  });
}
