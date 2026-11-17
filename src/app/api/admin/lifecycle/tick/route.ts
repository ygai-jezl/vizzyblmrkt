import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { workerSecretMatches } from "@/lib/http/workerSecret";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { drainLifecycleTenant, runLifecycleTick } from "@/lib/lifecycle/runner";
import { isWaitlistEngineEnabled } from "@/lib/lifecycle/waitlist/flags";
import { runWaitlistTick } from "@/lib/lifecycle/waitlist/tick";
import { isPersonLinksEnabled } from "@/lib/audience/flags";
import { isCompetitorsEnabled } from "@/lib/competitors/flags";
import { runCompetitorChecks } from "@/lib/competitors/tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Run the lifecycle journeys (due enrolments + outbound webhooks). Two callers:
 *  - Cloud Scheduler, every 2 minutes, with `X-Worker-Secret:
 *    $LIFECYCLE_WORKER_SECRET` — fans out across every tenant and region;
 *  - a signed-in admin — runs their own tenant only.
 * Product journeys run while LIFECYCLE_ENABLED is on, and waitlist journeys
 * (engine move) while WAITLIST_ENGINE_ENABLED is on, and the person record sweep
 * while AUDIENCE_PERSON_LINKS_ENABLED is on. With all three off the scheduler gets
 * a no-op 200 (so it doesn't alarm on a dark deploy) and everyone else a 404.
 *
 * Competitors' weekly and monthly checks (COMPETITORS_ENABLED) ride the scheduler's call
 * too, after the journeys, with what is left of the request's time: never past 105s from
 * its start (the scheduler gives up at 120s). A signed-in admin's call never runs them.
 */
const SCHEDULER_LIMIT_MS = 105_000;
const COMPETITORS_BUDGET_MS = 25_000;

export async function POST(req: Request) {
  const started = Date.now();
  const machine = workerSecretMatches(req.headers.get("x-worker-secret"), process.env.LIFECYCLE_WORKER_SECRET);
  const product = isLifecycleEnabled();
  const waitlist = isWaitlistEngineEnabled();
  const people = isPersonLinksEnabled();
  const competitors = isCompetitorsEnabled();
  const journeys = product || waitlist || people;
  if (!journeys && !(machine && competitors)) {
    return machine
      ? NextResponse.json({ ok: true, skipped: "lifecycle_disabled" })
      : NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (machine) {
    const result = journeys ? await runLifecycleTick({}, { product, waitlist }) : {};
    let competitorChecks = null;
    if (competitors) {
      try {
        competitorChecks = await runCompetitorChecks({ deadlineMs: Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + COMPETITORS_BUDGET_MS) });
      } catch (err) {
        console.warn(`[competitors] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
      }
    }
    return NextResponse.json({ ok: true, mode: "all_tenants", ...result, ...(competitors ? { competitors: competitorChecks } : {}) });
  }

  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const admin = await getAdminContext();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = product ? await drainLifecycleTenant(admin) : {};
  const waitlistResult = waitlist ? await runWaitlistTick(admin) : null;
  return NextResponse.json({ ok: true, mode: "tenant", ...result, ...(waitlistResult ? { waitlist: waitlistResult } : {}) });
}
