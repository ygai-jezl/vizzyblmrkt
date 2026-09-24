import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { EmailJob } from "@/lib/types/emailJob";
import { journeyIdFor } from "./service";
import { recoverDeadEnds } from "./recover";
import { RELEASE_PER_TICK } from "./hold";

/**
 * Find — and with `apply`, recover — people stranded by pauses and archives
 * BEFORE engine move D1. While a journey was paused (or its launch archived) the
 * worker marked each person's due step "done" without sending it, and nothing
 * came after it, so they never got the rest of their sequence.
 *
 * - Email steps: "done", never sent (no emailSentAt, variant or ambiguous send),
 *   not a D1 exit (endedReason), and the person's sequence didn't carry on after
 *   it. Recovery puts that same job back in the queue (its dedupe key stays), so
 *   they get the missed email and the rest follows.
 * - Condition steps: the existing dead-end recovery (a condition step marked done
 *   with no successor), which re-evaluates the branch on the current graph.
 *
 * Only journeys that are sending are recovered; a paused one is reported so it
 * can be run again after it's turned back on. Recovered emails are spread across
 * worker ticks like a resume. Reports counts and dates only, never a person.
 */

export interface StrandedReport {
  campaignId: string;
  journeyId: string;
  journeyStatus: string | null;
  /** People stranded at an email (only those who can still be emailed). */
  emailSteps: number;
  /** People stranded at a condition that routed nowhere. */
  conditionSteps: number;
  /** When the earliest and latest of them were stranded. */
  oldest: string | null;
  newest: string | null;
  /** With apply: steps put back in the queue, plus successors enqueued. */
  recovered: number;
  /** Stranded people exist but the journey isn't sending: resume it, then run again. */
  waitingForResume: boolean;
}

const TICK_MS = 2 * 60_000;

const strandedAt = (j: EmailJob) => j.processedAt ?? j.scheduledAt;

export async function recoverPausedJourney(
  ctx: TenantContext,
  campaignId: string,
  opts: { apply?: boolean; now?: number; db?: FirestoreLike } = {},
): Promise<StrandedReport> {
  const repo = forTenant(ctx, opts.db);
  const journeyId = journeyIdFor(campaignId);
  const journey = await repo.journeys.getById(journeyId);
  const report: StrandedReport = {
    campaignId,
    journeyId,
    journeyStatus: journey?.status ?? null,
    emailSteps: 0,
    conditionSteps: 0,
    oldest: null,
    newest: null,
    recovered: 0,
    waitingForResume: false,
  };
  if (!journey) return report;

  const emailSteps = new Set(journey.graph.nodes.filter((n) => n.type === "email").map((n) => n.id));
  const jobs = (await repo.emailJobs.find({ where: [["campaignId", "==", campaignId]] })).filter(
    (j) => j.type === "journey_step" && String(j.payload.journeyId ?? "") === journeyId,
  );
  // A person whose sequence carried on after a step isn't stranded at it.
  const latest = new Map<string, string>();
  for (const j of jobs) {
    const who = String(j.payload.signupId ?? "");
    if ((latest.get(who) ?? "") < j.createdAt) latest.set(who, j.createdAt);
  }
  const candidates = jobs.filter(
    (j) =>
      j.status === "done" &&
      !j.emailSentAt &&
      !j.variantId &&
      !j.sendAmbiguous &&
      !j.endedReason &&
      emailSteps.has(String(j.payload.nodeId ?? "")) &&
      latest.get(String(j.payload.signupId ?? "")) === j.createdAt,
  );
  // Only people who'd still be emailed (unsubscribes are re-checked at send time).
  const stranded: EmailJob[] = [];
  for (const j of candidates) {
    const signup = await repo.signups.getById(String(j.payload.signupId ?? ""));
    if (signup?.status === "verified_active" && signup.email) stranded.push(j);
  }
  stranded.sort((a, b) => strandedAt(a).localeCompare(strandedAt(b)));
  report.emailSteps = stranded.length;
  report.oldest = stranded[0] ? strandedAt(stranded[0]) : null;
  report.newest = stranded.at(-1) ? strandedAt(stranded.at(-1)!) : null;

  // Condition dead-ends (the existing recovery only runs on a sending journey).
  const dry = await recoverDeadEnds(ctx, campaignId, journeyId, { apply: false, db: opts.db });
  report.conditionSteps = dry.items.filter((i) => i.decision === "would_enqueue").length;

  if (journey.status !== "active") {
    report.waitingForResume = report.emailSteps > 0;
    return report;
  }
  if (!opts.apply) return report;

  const now = opts.now ?? Date.now();
  for (let i = 0; i < stranded.length; i += 1) {
    const job = stranded[i]!;
    // Re-checked in a transaction, so a job that changed meanwhile is left alone.
    const put = await repo.emailJobs.claim(job.id, (cur) =>
      cur.status === "done" && !cur.emailSentAt && !cur.endedReason
        ? {
            status: "pending" as const,
            scheduledAt: new Date(now + Math.floor(i / RELEASE_PER_TICK) * TICK_MS).toISOString(),
            attempts: 0,
            claimedAt: null,
            processedAt: null,
            lastError: null,
          }
        : null,
    );
    if (put) report.recovered += 1;
  }
  if (report.conditionSteps > 0) {
    const applied = await recoverDeadEnds(ctx, campaignId, journeyId, { apply: true, db: opts.db });
    report.recovered += applied.items.filter((i) => i.decision === "enqueued").length;
  }
  return report;
}
