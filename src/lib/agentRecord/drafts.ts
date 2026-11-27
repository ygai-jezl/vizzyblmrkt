import type { TenantContext } from "@/lib/tenant";
import type { ContentPlan } from "@/lib/types/contentPlan";
import type { LifecycleJourney } from "@/lib/types/lifecycle";
import type { Made } from "@/lib/types/loopStamp";
import { lifecycleDraftPrint, planPrint } from "./fingerprints";
import { closeDraft, memberOf, recordDraft, type RecordDeps, type RecordOutcome } from "./record";
import { RECORD_SYSTEM } from "./sources";

/**
 * Agent record (ADR-0026): the drafts more than one path records or closes, each in one place.
 */

/** A content plan's draft ref: its programme and its id (plans are a programme's subcollection). */
export const planRef = (workspaceId: string, planId: string): string => `${workspaceId}:${planId}`;

/** The plan's page. */
export const planHref = (workspaceId: string, planId: string): string => `/admin/workspace/${workspaceId}/create/${planId}`;

/** A lifecycle journey's page. */
export const journeyHref = (journeyId: string): string => `/admin/lifecycle/${journeyId}`;

type PlanView = Pick<ContentPlan, "status" | "graph">;

const approvedIds = (p: Pick<ContentPlan, "graph">) => new Set((p.graph?.nodes ?? []).filter((n) => n.status === "approved").map((n) => n.id));

/**
 * A content plan Vizzy drafted or rewrote (the canvas), or the autopilot finished: recorded beside
 * the save. Only a plan an agent made: a refill of a person's plan stays theirs. The record keeps
 * the ids of the pieces already approved, and whether the plan was already scheduled, so a refill
 * of a plan whose hub was approved before waits for a new approval.
 */
export function recordPlanDraft(
  ctx: TenantContext,
  workspaceId: string,
  plan: Pick<ContentPlan, "id" | "name" | "graph" | "authoredBy"> & Partial<Pick<ContentPlan, "status">>,
  by: "vizzy" | "autopilot",
  deps: RecordDeps = {},
): Promise<RecordOutcome> {
  if (by === "vizzy" && plan.authoredBy !== "agent") return Promise.resolve("same");
  return recordDraft(
    ctx,
    {
      action: by === "autopilot" ? "autopilot.draft" : "content_plan.draft",
      draft: { kind: "content_plan", ref: planRef(workspaceId, plan.id) },
      href: planHref(workspaceId, plan.id),
      label: plan.name,
      fingerprint: planPrint(plan),
      approved: [...approvedIds(plan)].sort(),
      scheduled: plan.status === "scheduled",
      ...(by === "autopilot" ? { requestedBy: { type: "system" as const, id: "autopilot" } } : {}),
    },
    deps,
  );
}

/**
 * Whether a plan was kept since its record was made: a piece approved that wasn't approved then,
 * or the plan scheduled since (the catch-up's rule, for Found live's approvals).
 */
export function approvedSince(proposal: Record<string, unknown> | null | undefined, plan: PlanView): boolean {
  const was = new Set(Array.isArray(proposal?.approved) ? proposal.approved.filter((x): x is string => typeof x === "string") : []);
  if ([...approvedIds(plan)].some((id) => !was.has(id))) return true;
  return plan.status === "scheduled" && proposal?.scheduled !== true;
}

/** A save that approves a piece (Review's rule for a draft that is no longer waiting), or schedules the plan. */
export function approvesAPiece(before: PlanView, after: PlanView): boolean {
  const was = approvedIds(before);
  if ([...approvedIds(after)].some((id) => !was.has(id))) return true;
  return after.status === "scheduled" && before.status !== "scheduled";
}

/**
 * A content plan saved on the canvas: acted when the save approves a piece (edited if the pieces
 * changed since the agent's draft), declined when it archives the plan; null after = deleted.
 * By the member who saved it, or the system (Found live's approval).
 */
export async function closePlanDraft(
  ctx: TenantContext,
  workspaceId: string,
  before: PlanView & Pick<ContentPlan, "id">,
  after: (PlanView & Pick<ContentPlan, "id" | "name">) | null,
  deps: RecordDeps & { system?: boolean } = {},
): Promise<number> {
  const draft = { kind: "content_plan" as const, ref: planRef(workspaceId, before.id) };
  const by = deps.system ? RECORD_SYSTEM : memberOf(ctx);
  if (!after || (after.status === "archived" && before.status !== "archived")) {
    return closeDraft(ctx, draft, { to: "declined", reason: "dismissed", by }, deps);
  }
  if (!approvesAPiece(before, after)) return 0;
  return closeDraft(ctx, draft, { to: "acted", by, fingerprint: planPrint(after) }, deps);
}

/** A lifecycle journey Vizzy drafted or styled: recorded beside its save, with the canvas's stamp (`made`). */
export function recordJourneyDraft(
  ctx: TenantContext,
  action: "lifecycle_journey.draft" | "journey_style.suggest" | "launch_journey.draft",
  journey: Pick<LifecycleJourney, "id" | "name" | "draft" | "audience">,
  deps: RecordDeps & { label?: string; made?: Made } = {},
): Promise<RecordOutcome> {
  const launchId = journey.audience?.kind === "waitlist" ? journey.audience.campaignId : null;
  return recordDraft(
    ctx,
    {
      action,
      draft: { kind: "lifecycle_journey", ref: journey.id },
      launchId,
      href: journeyHref(journey.id),
      label: deps.label ?? journey.name,
      fingerprint: lifecycleDraftPrint(journey.draft),
      ...(deps.made ? { made: deps.made } : {}),
    },
    deps,
  );
}
