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
 * Brand search's check (SEARCH_INDEX_ENABLED) rides it the same way, about every 10 minutes.
 */
const SCHEDULER_LIMIT_MS = 105_000;
const COMPETITORS_BUDGET_MS = 25_000;
/** Competitor articles (COMPETITOR_ARTICLES_ENABLED) are read beside the checks: up to 3 reads of about 30s each. */
const ARTICLES_BUDGET_MS = 40_000;
/** Brand search's check runs beside them, within its own budget. */
const SEARCH_BUDGET_MS = 30_000;

export async function POST(req: Request) {
  const started = Date.now();
  const machine = workerSecretMatches(req.headers.get("x-worker-secret"), process.env.LIFECYCLE_WORKER_SECRET);
  const product = isLifecycleEnabled();
  const waitlist = isWaitlistEngineEnabled();
  const people = isPersonLinksEnabled();
  const competitors = isCompetitorsEnabled();
  const search = isSearchIndexEnabled();
  const journeys = product || waitlist || people;
  if (!journeys && !(machine && (competitors || search))) {
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
    return NextResponse.json({
      ok: true,
      mode: "all_tenants",
      ...result,
      ...(competitors ? { competitors: competitorChecks } : {}),
      ...(articleReads ? { competitorArticles: articleReads } : {}),
      ...(searchResult?.scanned ? { search: searchResult } : {}),
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
