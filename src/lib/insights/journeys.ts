import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { counterDocId } from "@/lib/lifecycle/enrol";
import { loadWaitlistJourneys } from "@/lib/journey/waitlistJourneys";
import type { WaitlistJourneyRow } from "@/lib/journey/waitlistJourneyRows";

/**
 * Insights › Journeys (nav v2 phase 4): both engines side by side — each launch's
 * welcome journey (and how many people are part-way through it) and each lifecycle
 * journey (who's in it, who finished, sends in the last 7 days). Equality-only
 * count() reads and the exact daily counters; no new indexes.
 */

export interface WelcomeJourneyInsight extends WaitlistJourneyRow {
  /** People with a step still to come. */
  inProgress: number | null;
  /** People waiting while the journey is paused or the launch archived (engine move D1). */
  waiting: number | null;
}

export interface LifecycleJourneyInsight {
  id: string;
  name: string;
  status: string;
  deliveryMode: string;
  href: string;
  active: number | null;
  completed: number | null;
  exited: number | null;
  sends7d: number | null;
}

const DAY = 86_400_000;

export async function loadJourneyInsights(
  ctx: TenantContext,
  opts: { lifecycle: boolean; now?: Date },
  db?: FirestoreLike,
): Promise<{ welcome: WelcomeJourneyInsight[]; lifecycle: LifecycleJourneyInsight[] }> {
  const repos = forTenant(ctx, db);
  const now = (opts.now ?? new Date()).getTime();
  const [rows, journeys] = await Promise.all([
    loadWaitlistJourneys(ctx, db).catch(() => [] as WaitlistJourneyRow[]),
    opts.lifecycle ? repos.lifecycleJourneys.find({ limit: 100 }).catch(() => []) : [],
  ]);
  const welcome = await Promise.all(
    rows
      .filter((r) => r.status !== "not_started" && !r.archived)
      .slice(0, 30)
      .map(async (r) => {
        const steps = (status: string) =>
          repos.emailJobs
            .count([["campaignId", "==", r.campaignId], ["type", "==", "journey_step"], ["status", "==", status]])
            .catch(() => null);
        const [inProgress, waiting] = await Promise.all([steps("pending"), steps("held")]);
        return { ...r, inProgress, waiting };
      }),
  );
  const lifecycle = await Promise.all(
    journeys
      .filter((j) => j.status !== "archived")
      .slice(0, 30)
      .map(async (j) => {
        const n = (status: string) =>
          repos.lifecycleEnrolments.count([["journeyId", "==", j.id], ["status", "==", status]]).catch(() => null);
        const days = Array.from({ length: 7 }, (_, i) => counterDocId(j.id, now - i * DAY));
        const [active, completed, exited, counters] = await Promise.all([
          n("active"),
          n("completed"),
          n("exited"),
          Promise.all(days.map((id) => repos.lifecycleCounters.getById(id).catch(() => null))),
        ]);
        return {
          id: j.id,
          name: j.name,
          status: j.status,
          deliveryMode: j.deliveryMode,
          href: `/admin/lifecycle/${j.id}`,
          active,
          completed,
          exited,
          sends7d: counters.reduce((sum, c) => sum + (c?.sends ?? 0), 0),
        };
      }),
  );
  return { welcome, lifecycle };
}
