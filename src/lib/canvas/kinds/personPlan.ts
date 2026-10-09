import { z } from "zod";
import { isRateLimited } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { isPersonPlansEnabled } from "@/lib/audience/flags";
import { personHref } from "@/lib/audience/paths";
import { savePlanDraft } from "@/lib/audience/personPlans";
import { PLAN_LIMITS } from "@/lib/types/personPlan";
import type { CanvasAuthorArgs, CanvasAuthorOutcome, CanvasKind } from "../types";

/**
 * The `person_plan` canvas kind — Vizzy drafts a plan for ONE product user from
 * the chat (LIFECYCLE_PERSON_PLANS): a goal, how to put it to them, the next few
 * steps and when to look again. Always a DRAFT: someone on the team approves it
 * on the person's page, and only then does it steer that person's AI line.
 *
 * The person is named by our id for them and found only in the token's tenant.
 * A plan that holds an email address or their full name is refused, and a person
 * who can't be emailed at all gets no plan from Vizzy.
 */

const PersonPlanInput = z.object({
  scope: z.object({ personId: z.string().min(1).max(128) }),
  goal: z.string().max(PLAN_LIMITS.goal * 2),
  angle: z.string().max(PLAN_LIMITS.angle * 2),
  next: z.array(z.string().max(PLAN_LIMITS.step * 2)).max(PLAN_LIMITS.steps * 2).optional(),
  /** Look at them again this many days from now. */
  reviewInDays: z.number().int().min(1).max(90).nullish(),
});

const AUTHOR_LIMIT = { prefix: "person_plan_author", burstLimit: 10, hourlyLimit: 60 };

export async function authorPersonPlan(
  { ctx, input }: CanvasAuthorArgs,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<CanvasAuthorOutcome> {
  if (!isPersonPlansEnabled()) return { ok: false, status: 503, error: "person_plans_unavailable" };
  // Writing a plan is admin-only on the person's page, so drafting one through Vizzy is too. A token without a role fails closed.
  if (ctx.role !== "admin") return { ok: false, status: 403, error: "forbidden" };
  const req = PersonPlanInput.safeParse(input);
  if (!req.success) {
    return { ok: false, status: 400, error: "invalid_input", issues: req.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  if (await isRateLimited(`tenant:${ctx.tenantId}`, AUTHOR_LIMIT, { db: deps.db })) return { ok: false, status: 429, error: "rate_limited" };

  const nowMs = deps.nowMs ?? Date.now();
  const { personId } = req.data.scope;
  const reviewOn = req.data.reviewInDays ? new Date(nowMs + req.data.reviewInDays * 86_400_000).toISOString().slice(0, 10) : null;
  const saved = await savePlanDraft(ctx, personId, { goal: req.data.goal, angle: req.data.angle, next: req.data.next ?? [], reviewOn }, { db: deps.db, nowMs, by: "agent" });
  if (!saved.ok) return { ok: false, status: saved.status, error: saved.error, ...(saved.detail ? { issues: [saved.detail] } : {}) };

  const steps = saved.value.draft?.next.length ?? 0;
  const url = personHref(personId);
  return {
    ok: true,
    id: saved.value.id,
    status: "draft",
    url,
    summary: "Saved as a draft plan for this person. Nothing changes until someone on your team approves it on their page.",
    warnings: [],
    card: {
      kind: "person_plan",
      id: saved.value.id,
      title: "A plan for this person",
      url,
      stats: [{ label: steps === 1 ? "next step" : "next steps", value: steps }],
      warnings: 0,
      note: "Draft: nothing changes until you approve it on their page.",
      cta: "Open their page",
    },
  };
}

export const personPlanCanvasKind: CanvasKind = {
  kind: "person_plan",
  label: "plan for one person",
  authorDraft: (args) => authorPersonPlan(args),
};
