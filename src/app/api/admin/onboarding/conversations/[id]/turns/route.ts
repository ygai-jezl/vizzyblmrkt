import { z } from "zod";
import { badId, invalidInput, limitPerUser, ok, onboardingAdmin, readJsonBody, refused } from "@/lib/onboarding/api";
import { appendTurns } from "@/lib/onboarding/store";
import { ONBOARDING_LIMITS, VoiceNoteSchema, VoiceTurnSchema, isConversationId } from "@/lib/types/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/** About one upload every 5 seconds per call, with room for retries. */
const TURNS_LIMIT = { prefix: "onboarding_voice_turns", burstLimit: 30, hourlyLimit: 240 };

const L = ONBOARDING_LIMITS;

/** Finished lines from offset `from` (how many the server already has), and Vizzy's notes. */
const Body = z
  .object({
    from: z.number().int().min(0).max(L.MAX_TURNS),
    turns: z.array(VoiceTurnSchema).min(1).max(L.TURNS_PER_APPEND),
    notes: z.array(VoiceNoteSchema).max(8).default([]),
  })
  .strict();

/**
 * Words from a Talk with Vizzy call while it runs (ONBOARDING_VOICE_ENABLED; admins). Only the
 * admin who started it, while it is live: a gap is refused with the length kept, a repeat adds
 * nothing, and a full conversation takes no more. The brand is the session's; another brand's id
 * is not found.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const g = await onboardingAdmin(req, { need: "voice" });
  if (!g.ok) return g.response;
  const { id } = await params;
  if (!isConversationId(id)) return badId("id");
  const body = await readJsonBody(req, L.MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = Body.safeParse(body.value);
  if (!parsed.success) return invalidInput(parsed.error.issues);
  const limited = await limitPerUser(g.ctx, TURNS_LIMIT);
  if (limited) return limited;

  const r = await appendTurns(g.ctx, id, parsed.data);
  return r.ok ? ok({ ok: true, length: r.value.length }) : refused(r);
}
