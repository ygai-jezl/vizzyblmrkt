import { forTenant } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import { selectBranch } from "@/lib/journey/conditions";
import { resolveNextStep } from "@/lib/email/delivery";
import { enqueueEmailJob } from "@/lib/email/jobs";
import { computeRanks } from "@/lib/waitlist/rank";

/**
 * Recover recipients whose journey silently dead-ended at a condition node (the
 * invalid-field / missing-default-edge bug): their `condition` journey_step job
 * is `done` with `emailSentAt:null` and no successor was ever enqueued.
 *
 * MUST be run AFTER the graph is fixed (see graphFix.ts / fix-journey-graph.ts):
 * it re-evaluates the condition on the CURRENT (fixed) graph and enqueues the
 * resolved next step. Idempotent — the next step's dedupeKey is fresh, and a
 * pre-existing successor short-circuits — so a re-run is a safe no-op.
 */
export type RecoverDecision =
  | "enqueued"
  | "duplicate"
  | "would_enqueue"
  | "skip_recipient" // gone / not verified_active / no email / no campaign
  | "skip_exists" // successor already present
  | "skip_not_condition"
  | "still_no_next"; // even the fixed graph routes nowhere (shouldn't happen)

export interface RecoverItem {
  signupId: string;
  nodeId: string;
  decision: RecoverDecision;
  handle?: string;
  nextNodeId?: string;
  delayHours?: number;
}

export interface RecoverResult {
  campaignId: string;
  journeyId: string;
  status: string;
  strandedFound: number;
  items: RecoverItem[];
}

export async function recoverDeadEnds(
  ctx: TenantContext,
  campaignId: string,
  journeyId: string,
  opts: { apply?: boolean; db?: FirestoreLike } = {},
): Promise<RecoverResult> {
  const { apply = false, db } = opts;
  const repo = forTenant(ctx, db);

  const journey = await repo.journeys.getById(journeyId);
  if (!journey) {
    return { campaignId, journeyId, status: "journey_not_found", strandedFound: 0, items: [] };
  }
  // Don't recover a paused/draft journey — its steps would be skipped anyway.
  if (journey.status !== "active") {
    return { campaignId, journeyId, status: `journey_${journey.status}`, strandedFound: 0, items: [] };
  }

  const conditionNodeIds = new Set(
    journey.graph.nodes.filter((n) => n.type === "condition").map((n) => n.id),
  );

  // Query by campaignId only (single-field, always indexed); filter the rest in
  // code so we never depend on an undeployed composite index. A stranded
  // condition job is type journey_step, status done, emailSentAt null, on a
  // condition node.
  const all = await repo.emailJobs.find({ where: [["campaignId", "==", campaignId]] });
  const stranded = all.filter(
    (j) =>
      j.type === "journey_step" &&
      j.status === "done" &&
      j.emailSentAt == null &&
      conditionNodeIds.has(String((j.payload as Record<string, unknown>).nodeId ?? "")),
  );

  const campaign = await repo.campaigns.getById(campaignId);
  let ranks: Map<string, number> | null = null;
  const items: RecoverItem[] = [];

  for (const job of stranded) {
    const payload = job.payload as Record<string, unknown>;
    const nodeId = String(payload.nodeId ?? "");
    const signupId = String(payload.signupId ?? "");

    const node = journey.graph.nodes.find((n) => n.id === nodeId);
    if (!node || node.type !== "condition") {
      items.push({ signupId, nodeId, decision: "skip_not_condition" });
      continue;
    }

    const signup = await repo.signups.getById(signupId);
    if (!signup || signup.status !== "verified_active" || !signup.email || !campaign) {
      items.push({ signupId, nodeId, decision: "skip_recipient" });
      continue;
    }

    if (!ranks) ranks = await computeRanks(ctx, campaignId, db);
    const handle = selectBranch(node.data.branches, {
      signup,
      campaign,
      rank: ranks.get(signupId),
    });
    const next = resolveNextStep(journey.graph, nodeId, handle);
    if (!next) {
      items.push({ signupId, nodeId, decision: "still_no_next", handle });
      continue;
    }

    const dedupeKey = `journey:${journeyId}:${next.nodeId}:${signupId}`;
    const existing = await repo.emailJobs.getById(dedupeKey);
    if (existing) {
      items.push({ signupId, nodeId, decision: "skip_exists", handle, nextNodeId: next.nodeId });
      continue;
    }

    if (!apply) {
      items.push({
        signupId,
        nodeId,
        decision: "would_enqueue",
        handle,
        nextNodeId: next.nodeId,
        delayHours: next.delayHours,
      });
      continue;
    }

    const r = await enqueueEmailJob(
      ctx,
      {
        type: "journey_step",
        campaignId,
        dedupeKey,
        payload: { journeyId, nodeId: next.nodeId, signupId },
        scheduledAt: new Date(Date.now() + next.delayHours * 3600_000).toISOString(),
      },
      db,
    );
    items.push({
      signupId,
      nodeId,
      decision: r === "enqueued" ? "enqueued" : "duplicate",
      handle,
      nextNodeId: next.nodeId,
      delayHours: next.delayHours,
    });
  }

  return { campaignId, journeyId, status: "active", strandedFound: stranded.length, items };
}
