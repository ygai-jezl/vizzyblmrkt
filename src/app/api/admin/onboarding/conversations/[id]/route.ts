import { badId, limitPerUser, ok, onboardingAdmin, refused } from "@/lib/onboarding/api";
import { deleteConversation, getConversation } from "@/lib/onboarding/store";
import { isConversationId } from "@/lib/types/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/** Reading a transcript is a click; this only stops a loop. */
const READ_LIMIT = { prefix: "onboarding_read", burstLimit: 30, hourlyLimit: 300 };
const DELETE_LIMIT = { prefix: "onboarding_delete", burstLimit: 20, hourlyLimit: 200 };

/**
 * One kept conversation with its words, for "Read the conversation" (admins). Works with the
 * switch off too, so words kept while it was on can always be read. The brand is the session's.
 */
export async function GET(req: Request, { params }: RouteParams) {
  const g = await onboardingAdmin(req, { need: "none" });
  if (!g.ok) return g.response;
  const { id } = await params;
  if (!isConversationId(id)) return badId("id");
  const limited = await limitPerUser(g.ctx, READ_LIMIT);
  if (limited) return limited;
  const c = await getConversation(g.ctx, id);
  if (!c) return refused({ status: 404, error: "not_found" });
  return ok({
    conversation: {
      id: c.id,
      source: c.source,
      startedAt: c.startedAt,
      lengthSec: c.lengthSec ?? 0,
      turns: (c.turns ?? []).map((t) => ({ who: t.who, text: t.text, atSec: t.atSec })),
    },
  });
}

/**
 * Delete a kept conversation (admins): its words and what was learned from it go for good. Facts
 * already kept from it stay until removed. Works with the switch off too.
 */
export async function DELETE(req: Request, { params }: RouteParams) {
  const g = await onboardingAdmin(req, { need: "none" });
  if (!g.ok) return g.response;
  const { id } = await params;
  if (!isConversationId(id)) return badId("id");
  const limited = await limitPerUser(g.ctx, DELETE_LIMIT);
  if (limited) return limited;
  const r = await deleteConversation(g.ctx, id);
  return r.ok ? ok({ ok: true }) : refused(r);
}
