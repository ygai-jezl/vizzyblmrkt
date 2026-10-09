import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { PlanBodySchema, type PersonPlan, type PlanBody } from "@/lib/types/personPlan";
import type { ProductUser } from "@/lib/types/productUser";
import { zodReason } from "@/lib/connect/protocol";
import { identityScrubber } from "./personBrief";
import { personReach } from "./personStage";

/**
 * A plan for one person (LIFECYCLE_PERSON_PLANS): Vizzy or staff save a DRAFT, and
 * only staff approve it. An approved plan steers that person's AI line
 * (lifecycle/prepare.ts); it sends nothing by itself.
 *
 * A plan is words about a person's situation, never about who they are: a save
 * whose text names them, or holds anything shaped like an email address, is
 * refused — so the plan can go into a prompt without their identity going with it.
 */

export type PlanResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; detail?: string };

const fail = (status: number, error: string, detail?: string): PlanResult<never> => ({ ok: false, status, error, ...(detail ? { detail } : {}) });

export function personPlanDocId(personId: string): string {
  return `pp_${personId}`;
}

export async function getPersonPlan(ctx: TenantContext, personId: string, db?: FirestoreLike): Promise<PersonPlan | null> {
  return forTenant(ctx, db).personPlans.getById(personPlanDocId(personId));
}

/** The plan in force for a person: what steers their AI line. Null = none approved. */
export async function approvedPlanFor(ctx: TenantContext, personId: string, db?: FirestoreLike): Promise<PersonPlan["approved"]> {
  return (await getPersonPlan(ctx, personId, db))?.approved ?? null;
}

/** A plan as one paragraph for the AI line's prompt: the goal, then how to put it. */
export function planGuidance(plan: Pick<PlanBody, "goal" | "angle">): string {
  return `Goal: ${plan.goal}\nHow to put it: ${plan.angle}`;
}

const NAMES_THEM = "names_the_person";

function parseBody(input: unknown, user: Pick<ProductUser, "firstName" | "lastName" | "email">): PlanResult<PlanBody> {
  const parsed = PlanBodySchema.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_plan", zodReason(parsed.error));
  const scrub = identityScrubber({ name: [user.firstName, user.lastName].filter(Boolean).join(" "), email: user.email });
  const text = [parsed.data.goal, parsed.data.angle, ...parsed.data.next];
  if (text.some((t) => scrub(t) !== t)) return fail(422, NAMES_THEM);
  return { ok: true, value: parsed.data };
}

/**
 * Save a draft plan for a person, replacing any draft already waiting. `by: "agent"` is Vizzy,
 * who is refused for someone who can't be emailed at all: there is nothing to plan.
 */
export async function savePlanDraft(
  ctx: TenantContext,
  personId: string,
  input: unknown,
  deps: { db?: FirestoreLike; nowMs?: number; by?: "agent" | "human" } = {},
): Promise<PlanResult<PersonPlan>> {
  const repo = forTenant(ctx, deps.db);
  const user = await repo.productUsers.getById(personId);
  if (!user || user.status !== "active") return fail(404, "person_not_found");
  const body = parseBody(input, user);
  if (!body.ok) return body;
  const by = deps.by ?? "human";
  if (by === "agent") {
    const [connection, optOuts] = await Promise.all([
      repo.productConnections.getById(user.connectionId),
      user.emailNormalized ? repo.emailSuppressions.find({ where: [["normalizedEmail", "==", user.emailNormalized]], limit: 50 }) : Promise.resolve([]),
    ]);
    if (!connection) return fail(404, "person_not_found");
    if (personReach(user, connection.consentPolicy, optOuts).can === "no") return fail(409, "cannot_email");
  }
  const now = new Date(deps.nowMs ?? Date.now()).toISOString();
  const draft = { ...body.value, by, at: now };
  const { doc } = await repo.personPlans.upsert(
    personPlanDocId(personId),
    () => ({ connectionId: user.connectionId, productUserId: user.id, draft, approved: null, createdAt: now, updatedAt: now }),
    () => ({ draft, updatedAt: now }),
  );
  return { ok: true, value: doc };
}

/** Approve the draft: it becomes the plan in force. Staff only (the route checks the role). */
export async function approvePlan(ctx: TenantContext, personId: string, deps: { db?: FirestoreLike; nowMs?: number } = {}): Promise<PlanResult<PersonPlan>> {
  const now = new Date(deps.nowMs ?? Date.now()).toISOString();
  const saved = await forTenant(ctx, deps.db).personPlans.claim(personPlanDocId(personId), (cur) => {
    if (!cur.draft) return null;
    const { at: _draftedAt, ...body } = cur.draft;
    return { approved: { ...body, approvedBy: ctx.email ?? ctx.userId ?? null, at: now }, draft: null, updatedAt: now };
  });
  return saved ? { ok: true, value: saved } : fail(409, "no_draft");
}

/** Throw the draft away (`draft`), or end the plan in force (`approved`). The other half stays. */
export async function dropPlan(
  ctx: TenantContext,
  personId: string,
  which: "draft" | "approved",
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<PlanResult<PersonPlan>> {
  const now = new Date(deps.nowMs ?? Date.now()).toISOString();
  const saved = await forTenant(ctx, deps.db).personPlans.claim(personPlanDocId(personId), (cur) => {
    if (!cur[which]) return null;
    return which === "draft" ? { draft: null, updatedAt: now } : { approved: null, updatedAt: now };
  });
  return saved ? { ok: true, value: saved } : fail(409, which === "draft" ? "no_draft" : "no_plan");
}
