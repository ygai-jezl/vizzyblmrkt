import { z } from "zod";
import { countMade } from "@/lib/loops/count";
import { learnedFor } from "@/lib/loops/read";
import { learnFromConversation } from "@/lib/onboarding/learn";
import { badId, fail, invalidInput, limitPerUser, ok, onboardingAdmin, readJsonBody, refused } from "@/lib/onboarding/api";
import { endConversation, mayLearn, saveLearned } from "@/lib/onboarding/store";
import { afterCallEnded, dropIfSilent } from "@/lib/onboarding/voice/calls";
import { heardAnswers } from "@/lib/onboarding/voice/topics";
import { aiUsage } from "@/lib/plans/meter";
import { getTenantById } from "@/lib/tenant";
import { PROFILE_KEYS, type ProfileKey } from "@/lib/types/businessProfile";
import { EndReason, ONBOARDING_LIMITS, VoiceNoteSchema, VoiceTurnSchema, isConversationId, readLearned } from "@/lib/types/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Learning from the call can take up to about 30 seconds. */
export const maxDuration = 60;

type RouteParams = { params: Promise<{ id: string }> };

const END_LIMIT = { prefix: "onboarding_voice_end", burstLimit: 10, hourlyLimit: 60 };

const L = ONBOARDING_LIMITS;

/** The last words (as for .../turns, none needed) and why the call ended. */
const Body = z
  .object({
    from: z.number().int().min(0).max(L.MAX_TURNS).optional(),
    turns: z.array(VoiceTurnSchema).max(L.TURNS_PER_APPEND).optional(),
    notes: z.array(VoiceNoteSchema).max(8).optional(),
    reason: EndReason,
  })
  .strict()
  .refine((b) => !b.turns?.length || b.from !== undefined, { message: "from is needed with turns", path: ["from"] });

/**
 * End a Talk with Vizzy call (ONBOARDING_VOICE_ENABLED; admins; the admin who started it), then
 * learn from it. The call that ends it counts its seconds once and, when someone spoke, uses up
 * the brand's call for the day. Learning that gives nothing is 502; ending again tries it again,
 * up to 3 tries. Answers `{ lengthSec, covered, answers, learned, kept }`: the topics heard (what
 * was learned, else Vizzy's notes), so the screen can say what it heard. A call where the member
 * never spoke is counted, then deleted (`kept: false`): there is nothing to learn or keep.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const g = await onboardingAdmin(req, { need: "voice" });
  if (!g.ok) return g.response;
  const ctx = g.ctx;
  const { id } = await params;
  if (!isConversationId(id)) return badId("id");
  const body = await readJsonBody(req, L.MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = Body.safeParse(body.value);
  if (!parsed.success) return invalidInput(parsed.error.issues);
  const limited = await limitPerUser(ctx, END_LIMIT);
  if (limited) return limited;

  const { from, turns, notes, reason } = parsed.data;
  const final = turns?.length || notes?.length ? { from: from ?? 0, turns: turns ?? [], notes } : undefined;
  const ended = await endConversation(ctx, id, { reason, final });
  if (!ended.ok) return refused(ended);
  let conversation = ended.value.conversation;
  if (!ended.value.already) await afterCallEnded(ctx, conversation);
  if (await dropIfSilent(ctx, conversation)) {
    return ok({ lengthSec: conversation.lengthSec ?? 0, covered: [], answers: {}, learned: false, kept: false });
  }

  if (mayLearn(conversation)) {
    const tenant = await getTenantById(ctx.tenantId).catch(() => null);
    const learned = await learnFromConversation(
      { turns: conversation.turns ?? [], notes: conversation.notes ?? [], brandName: tenant?.tenantName ?? "" },
      aiUsage(ctx, "onboarding", { tenant }),
    );
    const saved = await saveLearned(ctx, id, learned);
    if (saved.ok) conversation = saved.value;
    if (!learned) return fail(502, "learn_failed");
    // What the call taught, counted made where it is kept (LOOPS_ENABLED, learning loops step 5).
    if (saved.ok) await countMade(ctx, "onboarding", (await learnedFor(ctx, "onboarding")).stamp, { type: "onboarding_conversation" });
  }

  const learned = readLearned(conversation.learned);
  const answers = heardAnswers(learned, conversation.notes ?? []);
  return ok({
    lengthSec: conversation.lengthSec ?? 0,
    covered: PROFILE_KEYS.filter((k): k is ProfileKey => answers[k] !== undefined),
    answers,
    learned: learned !== null,
    kept: true,
  });
}
