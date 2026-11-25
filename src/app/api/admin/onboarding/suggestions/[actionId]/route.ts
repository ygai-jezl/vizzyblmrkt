import { z } from "zod";
import { aboutConversation, aboutFacts } from "@/lib/onboarding/aboutYourBusiness";
import { badId, fail, invalidInput, limitPerUser, ok, onboardingAdmin } from "@/lib/onboarding/api";
import { decideBusinessFact } from "@/lib/onboarding/factSuggestions";
import { isAgentActionId } from "@/lib/types/agentAction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ actionId: string }> };

const Body = z.object({ decision: z.enum(["keep", "remove"]) }).strict();
const DECIDE_LIMIT = { prefix: "onboarding_suggestion_decide", burstLimit: 20, hourlyLimit: 200 };

const STATUS: Record<string, number> = { not_found: 404, already_decided: 409, too_many_facts: 409, no_user: 401 };

/**
 * Keep or remove something Vizzy heard about the business in a chat (admins, ONBOARDING_ENABLED),
 * from About your business. Keep writes the fact and the chat's lines from the suggestion as
 * stored, never from this request, and answers with them as the section lists them. The brand is
 * the session's: another brand's suggestion is not found.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const g = await onboardingAdmin(req, { need: "onboarding" });
  if (!g.ok) return g.response;
  const { actionId } = await params;
  if (!isAgentActionId(actionId)) return badId("actionId");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidInput(parsed.error.issues);
  const limited = await limitPerUser(g.ctx, DECIDE_LIMIT);
  if (limited) return limited;
  const r = await decideBusinessFact(g.ctx, actionId, parsed.data.decision);
  if (!r.ok) return fail(STATUS[r.error] ?? 409, r.error);
  if (r.decision === "remove") return ok({ ok: true });
  return ok({
    ok: true,
    fact: aboutFacts([r.fact])[0],
    ...(r.conversation ? { conversation: aboutConversation(r.conversation) } : {}),
  });
}
