import { NextResponse } from "next/server";
import { isPasswordSigninEnabled } from "@/lib/auth/flags";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { workerSecretMatches } from "@/lib/http/workerSecret";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { isWaitlistEngineEnabled } from "@/lib/lifecycle/waitlist/flags";
import { isPersonLinksEnabled } from "@/lib/audience/flags";
import { isCompetitorArticlesEnabled, isCompetitorsEnabled } from "@/lib/competitors/flags";
import { isSearchIndexEnabled } from "@/lib/search/flags";
import { isSignalsDataForSeoEnabled } from "@/lib/signals/flags";
import { isAutopilotEnabled } from "@/lib/autopilot/flags";
import { isBlogFreshnessEnabled, isBlogLiveWatchEnabled, isBlogRefreshEnabled } from "@/lib/brandMap/flags";
import { isConnectorsEnabled } from "@/lib/connectors/flags";
import { isSettingsEraseEnabled } from "@/lib/settings/flags";
import { logTickMemory, timedTickJob } from "@/lib/lifecycle/tickLog";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { isLoopsEnabled } from "@/lib/loops/flags";

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
 * so does collecting finished Google lookups (SIGNALS_DATAFORSEO_ENABLED). Connected data's lane
 * (CONNECTORS_ENABLED) runs about every 30 minutes, at a tick of its own: its housekeeping whatever
 * the collect switch says, and collecting with CONNECTORS_COLLECT_ENABLED (ADR-0012).
 *
 * Each job's code is loaded inside the branch that runs it, so a job whose switch is off never
 * loads (and never holds memory on the instance). Only the switches are read up front. A job's
 * deadline is set before its code loads, so loading counts against its own budget.
 *
 * The clean-up of unconfirmed password accounts (PASSWORD_SIGNIN_ENABLED) rides it beside them, at
 * most once an hour across instances (src/lib/auth/cleanup.ts).
 *
 * The learning loops lane (src/lib/loops/tick.ts) rides it too while image style versions are on
 * (IMAGE_STYLE_VERSIONS_ENABLED and the switches it needs) or the learning loops are
 * (LOOPS_ENABLED), every 5th tick at offset 1, within its own 20 second budget.
 * An owner's erase of an archived field's values (SETTINGS_ERASE_ENABLED, ADR-0023) moves on beside
 * them too, a page at a time from each running job's cursor; with the switch off a job waits.
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
/** Found live (BLOG_LIVE_WATCH_ENABLED): a few pages of the brands' own sites, every 10 minutes. */
const LIVE_WATCH_BUDGET_MS = 25_000;
/** Connected data's lane (CONNECTORS_ENABLED): every 15th tick, at offset 7. */
const CONNECTORS_BUDGET_MS = 25_000;
/** Article freshness (BLOG_FRESHNESS_ENABLED): each brand's live articles once a day, a few brands a tick. */
const FRESHNESS_BUDGET_MS = 20_000;
/** Article refresh reviews (BLOG_REFRESH_ENABLED): a step or two of running reviews; research can take a minute. */
const REFRESH_BUDGET_MS = 90_000;
/** Unconfirmed password accounts (PASSWORD_SIGNIN_ENABLED): once an hour, a short run. */
const AUTH_CLEANUP_BUDGET_MS = 10_000;
/** The learning loops lane (IMAGE_STYLE_VERSIONS_ENABLED or LOOPS_ENABLED): a page of brands, about every 10 minutes. */
const LOOPS_BUDGET_MS = 20_000;
/** Erasing archived fields' values (SETTINGS_ERASE_ENABLED): running jobs move on a page at a time. */
const FIELD_ERASE_BUDGET_MS = 20_000;

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
  const liveWatch = isBlogLiveWatchEnabled();
  const connectors = isConnectorsEnabled();
  const freshness = isBlogFreshnessEnabled();
  const refresh = isBlogRefreshEnabled();
  const authCleanup = isPasswordSigninEnabled();
  const loops = isImageStyleVersionsOn() || isLoopsEnabled();
  const fieldErase = isSettingsEraseEnabled();
  const journeys = product || waitlist || people;
  if (!journeys && !(machine && (competitors || search || signals || autopilot || liveWatch || connectors || freshness || refresh || authCleanup || loops || fieldErase))) {
    return machine
      ? NextResponse.json({ ok: true, skipped: "lifecycle_disabled" })
      : NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (machine) {
    // Each job logs "[tick] <job> <ms>ms" as it ends, and the instance's memory is logged once
    // the tick is done (tickLog.ts).
    try {
      const result = journeys
        ? await timedTickJob("journeys", async () => {
            const { runLifecycleTick } = await import("@/lib/lifecycle/runner");
            return runLifecycleTick({}, { product, waitlist });
          })
        : {};
      let competitorChecks = null;
      let articleReads = null;
      const searchSweep = search
        ? timedTickJob("search", async () => {
            const deadlineMs = Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + SEARCH_BUDGET_MS);
            const { runSearchSweeps } = await import("@/lib/search/sweep");
            return runSearchSweeps({ deadlineMs });
          }).catch((err: unknown) => {
            console.warn(`[search] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
            return null;
          })
        : Promise.resolve(null);
      const signalCollect = signals
        ? timedTickJob("signals", async () => {
            const deadlineMs = Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + SIGNALS_BUDGET_MS);
            const { runSignals } = await import("@/lib/signals/tick");
            return runSignals({ deadlineMs });
          }).catch((err: unknown) => {
            console.warn(`[signals] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
            return null;
          })
        : Promise.resolve(null);
      const autopilotRun = autopilot
        ? timedTickJob("autopilot", async () => {
            const deadlineMs = Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + AUTOPILOT_BUDGET_MS);
            const { runAutopilot } = await import("@/lib/autopilot/tick");
            return runAutopilot({ deadlineMs });
          }).catch((err: unknown) => {
            console.warn(`[autopilot] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
            return null;
          })
        : Promise.resolve(null);
      const liveWatchRun = liveWatch
        ? timedTickJob("live-watch", async () => {
            const deadlineMs = Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + LIVE_WATCH_BUDGET_MS);
            const { runLiveWatch } = await import("@/lib/content/blog/liveWatch");
            return runLiveWatch({ deadlineMs });
          }).catch((err: unknown) => {
            console.warn(`[live-watch] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
            return null;
          })
        : Promise.resolve(null);
      const freshnessRun = freshness
        ? timedTickJob("freshness", async () => {
            const deadlineMs = Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + FRESHNESS_BUDGET_MS);
            const { runFreshness } = await import("@/lib/content/blog/freshnessWatch");
            return runFreshness({ deadlineMs });
          }).catch((err: unknown) => {
            console.warn(`[freshness] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
            return null;
          })
        : Promise.resolve(null);
      const refreshRun = refresh
        ? timedTickJob("refresh", async () => {
            const deadlineMs = Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + REFRESH_BUDGET_MS);
            const { runRefreshReviews } = await import("@/lib/content/blog/refreshReview");
            return runRefreshReviews({ deadlineMs });
          }).catch((err: unknown) => {
            console.warn(`[refresh] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
            return null;
          })
        : Promise.resolve(null);
      const authCleanupRun = authCleanup
        ? timedTickJob("auth-cleanup", async () => {
            const deadlineMs = Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + AUTH_CLEANUP_BUDGET_MS);
            const { runAuthCleanup } = await import("@/lib/auth/cleanup");
            return runAuthCleanup({ deadlineMs });
          }).catch((err: unknown) => {
            console.warn(`[auth] clean-up failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
            return null;
          })
        : Promise.resolve(null);
      const fieldEraseRun = fieldErase
        ? timedTickJob("field-erase", async () => {
            const deadlineMs = Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + FIELD_ERASE_BUDGET_MS);
            const { runFieldErase } = await import("@/lib/settings/eraseArchived");
            return runFieldErase({ deadlineMs });
          }).catch((err: unknown) => {
            console.warn(`[erase] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
            return null;
          })
        : Promise.resolve(null);
      const connectorsRun = connectors
        ? timedTickJob("connectors", async () => {
            const deadlineMs = Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + CONNECTORS_BUDGET_MS);
            const { runConnectorsLane } = await import("@/lib/connectors/collect/tick");
            return runConnectorsLane({ deadlineMs });
          }).catch((err: unknown) => {
            console.warn(`[connectors] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
            return null;
          })
        : Promise.resolve(null);
      const loopsRun = loops
        ? timedTickJob(
            "loops",
            async () => {
              const deadlineMs = Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + LOOPS_BUDGET_MS);
              const { runLoopsLane } = await import("@/lib/loops/tick");
              return runLoopsLane({ deadlineMs });
            },
            Date.now,
            (r) => (r.skipped === "tick" ? "" : `brands=${r.brands} rows=${r.rows} heapDeltaMiB=${r.heapDeltaMiB}${r.skipped ? ` skipped=${r.skipped}` : ""}`),
          ).catch((err: unknown) => {
            console.warn(`[loops] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
            return null;
          })
        : Promise.resolve(null);
      if (competitors) {
        // The checks and the article reads run side by side, each within its own budget.
        const [checks, reads] = await Promise.all([
          timedTickJob("competitors", async () => {
            const deadlineMs = Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + COMPETITORS_BUDGET_MS);
            const { runCompetitorChecks } = await import("@/lib/competitors/tick");
            return runCompetitorChecks({ deadlineMs });
          }).catch((err: unknown) => {
            console.warn(`[competitors] tick failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
            return null;
          }),
          isCompetitorArticlesEnabled()
            ? timedTickJob("competitor-articles", async () => {
                const deadlineMs = Math.min(started + SCHEDULER_LIMIT_MS, Date.now() + ARTICLES_BUDGET_MS);
                const { runArticleReads } = await import("@/lib/competitors/articleTick");
                return runArticleReads({ deadlineMs });
              }).catch((err: unknown) => {
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
      const liveWatchResult = await liveWatchRun;
      const connectorsResult = await connectorsRun;
      const freshnessResult = await freshnessRun;
      const refreshResult = await refreshRun;
      const authCleanupResult = await authCleanupRun;
      const loopsResult = await loopsRun;
      const fieldEraseResult = await fieldEraseRun;
      return NextResponse.json({
        ok: true,
        mode: "all_tenants",
        ...result,
        ...(competitors ? { competitors: competitorChecks } : {}),
        ...(articleReads ? { competitorArticles: articleReads } : {}),
        ...(searchResult?.scanned ? { search: searchResult } : {}),
        ...(signalResult?.tenants ? { signals: signalResult } : {}),
        ...(autopilotResult?.tenants ? { autopilot: autopilotResult } : {}),
        ...(liveWatchResult?.brands ? { liveWatch: liveWatchResult } : {}),
        ...(connectorsResult?.brands ? { connectors: connectorsResult } : {}),
        ...(freshnessResult?.brands ? { freshness: freshnessResult } : {}),
        ...(refreshResult?.brands ? { refresh: refreshResult } : {}),
        ...(authCleanupResult ? { authCleanup: authCleanupResult } : {}),
        ...(loopsResult?.brands
          ? { loops: { brands: loopsResult.brands, idle: loopsResult.idle, learned: loopsResult.learned, verdicts: loopsResult.verdicts, ...(loopsResult.reported ? { reported: loopsResult.reported } : {}) } }
          : {}),
        ...(fieldEraseResult?.jobs ? { fieldErase: fieldEraseResult } : {}),
      });
    } finally {
      logTickMemory();
    }
  }

  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const admin = await getAdminContext();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let result = {};
  if (product) {
    const { drainLifecycleTenant } = await import("@/lib/lifecycle/runner");
    result = await drainLifecycleTenant(admin);
  }
  let waitlistResult = null;
  if (waitlist) {
    const { runWaitlistTick } = await import("@/lib/lifecycle/waitlist/tick");
    waitlistResult = await runWaitlistTick(admin);
  }
  return NextResponse.json({ ok: true, mode: "tenant", ...result, ...(waitlistResult ? { waitlist: waitlistResult } : {}) });
}
