import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { workerSecretMatches } from "@/lib/http/workerSecret";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { drainLifecycleTenant, runLifecycleTick } from "@/lib/lifecycle/runner";
import { isWaitlistEngineEnabled } from "@/lib/lifecycle/waitlist/flags";
import { runWaitlistTick } from "@/lib/lifecycle/waitlist/tick";
import { isPersonLinksEnabled } from "@/lib/audience/flags";
import { isCompetitorArticlesEnabled, isCompetitorsEnabled } from "@/lib/competitors/flags";
import { runArticleReads } from "@/lib/competitors/articleTick";
import { runCompetitorChecks } from "@/lib/competitors/tick";
import { isSearchIndexEnabled } from "@/lib/search/flags";
import { runSearchSweeps } from "@/lib/search/sweep";
import { isSignalsDataForSeoEnabled } from "@/lib/signals/flags";
import { runSignals } from "@/lib/signals/tick";
import { isAutopilotEnabled } from "@/lib/autopilot/flags";
import { runAutopilot } from "@/lib/autopilot/tick";

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
 * Brand search's check (SEARCH_INDEX_ENABLED) rides it the same way, about every 10 minutes, and
 * so does collecting finished Google lookups (SIGNALS_DATAFORSEO_ENABLED).
 */
const SCHEDULER_LIMIT_MS = 105_000;
const COMPETITORS_BUDGET_MS = 25_000;
/** Competitor articles (COMPETITOR_ARTICLES_ENABLED) are read beside the checks: up to 3 reads of about 30s each. */
const ARTICLES_BUDGET_MS = 40_000;
/** Brand search's check runs beside them, within its own budget. */
const SEARCH_BUDGET_MS = 30_000;
/** Google lookups (SIGNALS_DATAFORSEO_ENABLED) finished by DataForSEO are collected beside them too. */
const SIGNALS_BUDGET_MS = 25_000;
/** The article autopilot (CREATE_ARTICLE_AUTOPILOT_ENABLED): one step of a run can take over a minute. */
const AUTOPILOT_BUDGET_MS = 90_000;

export async function POST(req: Request) {
  const started = Date.now();
  const machine = workerSecretMatches(req.headers.get("x-worker-secret"), process.env.LIFECYCLE_WORKER_SECRET);
  const product = isLifecycleEnabled();
  const waitlist = isWaitlistEngineEnabled();
  const people = isPersonLinksEnabled();
  const competitors = isCompetitorsEnabled();
  const search = isSearchIndexEnabled();
  const signals = isSignalsDataForSeoEnabled();
  const autopilot = isAutopilotEnabled();
  const journeys = product || waitlist || people;
  if (!journeys && !(machine && (competitors || search || signals || autopilot))) {
    return machine
      ? NextResponse.json({ ok: true, skipped: "lifecycle_disabled" })
      : NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (machine) {
    const result = journeys ? await runLifecycleTick({}, { product, waitlist }) : {};
    let competitorChecks = null;
    let articleReads = null;
    const searchSweep = search
      ? runSearchSweeps({ deadlineMs: Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + SEARCH_BUDGET_MS) }).catch((err: unknown) => {
          console.warn(`[search] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
          return null;
        })
      : Promise.resolve(null);
    const signalCollect = signals
      ? runSignals({ deadlineMs: Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + SIGNALS_BUDGET_MS) }).catch((err: unknown) => {
          console.warn(`[signals] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
          return null;
        })
      : Promise.resolve(null);
    const autopilotRun = autopilot
      ? runAutopilot({ deadlineMs: Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + AUTOPILOT_BUDGET_MS) }).catch((err: unknown) => {
          console.warn(`[autopilot] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
          return null;
        })
      : Promise.resolve(null);
    if (competitors) {
      // The checks and the article reads run side by side, each within its own budget.
      const [checks, reads] = await Promise.all([
        runCompetitorChecks({ deadlineMs: Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + COMPETITORS_BUDGET_MS) }).catch((err: unknown) => {
          console.warn(`[competitors] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
          return null;
        }),
        isCompetitorArticlesEnabled()
          ? runArticleReads({ deadlineMs: Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + ARTICLES_BUDGET_MS) }).catch((err: unknown) => {
              console.warn(`[competitors] article reads failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
              return null;
            })
          : Promise.resolve(null),
      ]);
      competitorChecks = checks;
      articleReads = reads;
    }
    const searchResult = await searchSweep;
    const signalResult = await signalCollect;
    const autopilotResult = await autopilotRun;
    return NextResponse.json({
      ok: true,
      mode: "all_tenants",
      ...result,
      ...(competitors ? { competitors: competitorChecks } : {}),
      ...(articleReads ? { competitorArticles: articleReads } : {}),
      ...(searchResult?.scanned ? { search: searchResult } : {}),
      ...(signalResult?.tenants ? { signals: signalResult } : {}),
      ...(autopilotResult?.tenants ? { autopilot: autopilotResult } : {}),
    });
  }

  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const admin = await getAdminContext();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = product ? await drainLifecycleTenant(admin) : {};
  const waitlistResult = waitlist ? await runWaitlistTick(admin) : null;
  return NextResponse.json({ ok: true, mode: "tenant", ...result, ...(waitlistResult ? { waitlist: waitlistResult } : {}) });
}
