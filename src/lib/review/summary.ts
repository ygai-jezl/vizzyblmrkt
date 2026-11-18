import { forTenant } from "@/lib/tenant";
import { isAutopilotEnabled } from "@/lib/autopilot/flags";
import { recentRuns } from "@/lib/autopilot/runs";
import type { AutopilotRun } from "@/lib/types/autopilot";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { listContentPlans } from "@/lib/tenant/workspaceContent";
import { countWaitingApprovals } from "@/lib/lifecycle/approvals";
import { listRepoAnalyses, readMap } from "@/lib/connect/repoAnalysis";
import type { ContentPlan } from "@/lib/types/contentPlan";
import type { Journey } from "@/lib/types/journey";
import type { LifecycleJourney } from "@/lib/types/lifecycle";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { RepoAnalysis } from "@/lib/types/repoAnalysis";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import type { InviteWave } from "@/lib/types/invite";
import { isInvitesEnabled, isInvitesUiEnabled } from "@/lib/invites/flags";
import { isWaitlistEngineUiEnabled } from "@/lib/lifecycle/waitlist/flags";
import type { BrandMap, BrandMapSuggestionFrom } from "@/lib/types/brandMap";
import { isBrandMapEnabled, isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { proposalsWaiting, suggestionsWaiting } from "@/lib/brandMap/waiting";
import { readBrandMap } from "@/lib/brandMap/store";
import { BRAND_KIT_COMPETITORS_ROUTE, BRAND_KIT_MAP_ROUTE } from "@/lib/content/brandKit";
import { isCompetitorsEnabled } from "@/lib/competitors/flags";
import { listCompetitors, unseenChanges } from "@/lib/competitors/store";
import { PROBLEM_TEXT } from "@/lib/competitors/view";
import { brandCanUse } from "@/lib/plans/brandAccess";
import type { Competitor, CompetitorChange } from "@/lib/types/competitor";

/**
 * Review (nav v2 phase 2): every decision waiting on a person, in one place,
 * each linking back to where it came from. AI lines keep their own queue (the
 * ApprovalQueue component, embedded on the page); everything else is listed here.
 *
 * The per-source rules are pure and unit-tested; loadReview gathers them. Content
 * hubs need a read of every plan (content plans are a per-workspace subcollection),
 * so the sidebar count caches that part — see countReview.
 */

export type ReviewKind =
  | "ai_line"
  | "repo_results"
  | "agent_draft"
  | "brand_map"
  | "content_hub"
  | "failed_post"
  | "connection"
  | "competitor_news"
  | "next_article";

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  title: string;
  detail: string;
  href: string;
  /** The link's verb, e.g. "Review" or "Connect". */
  action: string;
  /** A second button beside the link: mark one competitor's changes seen (admins only). */
  markSeen?: { competitorId: string };
}

export const REVIEW_SECTIONS: Record<ReviewKind, { title: string; description: string }> = {
  ai_line: {
    title: "AI lines for upcoming emails",
    description: "Personal lines for tomorrow's lifecycle emails. Anything you don't decide in time goes out as the standard version.",
  },
  repo_results: {
    title: "Learned from your repo",
    description: "Onboarding steps, events and facts found in your code, waiting for you to accept them into the catalog.",
  },
  agent_draft: {
    title: "Drafts from Vizzy",
    description: "Vizzy only saves drafts. Check them, then publish or turn them on when you're happy.",
  },
  brand_map: {
    title: "Brand map suggestions",
    description: "Names, subjects and questions found by research, your articles and Vizzy, waiting for you to accept or dismiss them.",
  },
  content_hub: {
    title: "Content waiting for approval",
    description: "Approve a hub to let its spokes be written.",
  },
  failed_post: {
    title: "Posts that need you",
    description: "Scheduled posts that couldn't publish.",
  },
  connection: {
    title: "Connection problems",
    description: "Your product's context endpoint keeps failing, so personal lines fall back to the standard version.",
  },
  competitor_news: {
    title: "What your competitors changed",
    description: "New posts on their news pages and changes to their sites since you last looked. Open one to read it, or mark it seen.",
  },
  next_article: {
    title: "Your next article",
    description: "What the article autopilot found and sorted, the questions it asks your team, and runs that couldn't finish.",
  },
};

/** Order of sections on the page (AI lines are time-bound, so they come first). */
export const REVIEW_ORDER: ReviewKind[] = ["ai_line", "failed_post", "connection", "next_article", "agent_draft", "repo_results", "brand_map", "competitor_news", "content_hub"];

// ---------------------------------------------------------------------------
// Per-source rules (pure)

const MAP_SECTIONS = ["onboardingSteps", "events", "traits", "facts", "glossary"] as const;

/** A finished Learn-from-repo run nobody has accepted yet. */
export function repoResultsItem(
  connection: Pick<ProductConnection, "id" | "name">,
  latest: RepoAnalysis | undefined,
): ReviewItem | null {
  if (!latest || latest.acceptedAt || (latest.status !== "done" && latest.status !== "incomplete")) return null;
  const map = readMap(latest);
  if (!map) return null;
  const found = MAP_SECTIONS.reduce((n, key) => n + map[key].length, 0);
  if (found === 0) return null;
  const repos = latest.repos.map((r) => r.label).filter(Boolean).join(", ");
  return {
    id: `repo:${latest.id}`,
    kind: "repo_results",
    title: `${connection.name}: ${found} item${found === 1 ? "" : "s"} to review`,
    detail: repos ? `Learned from ${repos}` : "Learned from your repo",
    href: `/admin/products/${connection.id}?tab=learn`,
    action: "Review",
  };
}

/** A lifecycle journey Vizzy drafted that has never been published. */
export function agentJourneyItem(
  j: Pick<LifecycleJourney, "id" | "name" | "authoredBy" | "publishedVersion" | "status"> & Partial<Pick<LifecycleJourney, "audience">>,
  launchName?: string,
): ReviewItem | null {
  if (j.authoredBy !== "agent" || j.publishedVersion != null || j.status === "archived") return null;
  // A launch's welcome journey on the lifecycle engine (engine move) reads as the launch's.
  if (j.audience?.kind === "waitlist") {
    return {
      id: `lcj:${j.id}`,
      kind: "agent_draft",
      title: `Welcome emails for ${launchName ?? "a launch"}`,
      detail: "Drafted by Vizzy · not published",
      href: `/admin/lifecycle/${j.id}`,
      action: "Open",
    };
  }
  return {
    id: `lcj:${j.id}`,
    kind: "agent_draft",
    title: `“${j.name}”`,
    detail: "Lifecycle journey drafted by Vizzy · not published",
    href: `/admin/lifecycle/${j.id}`,
    action: "Open",
  };
}

/** A launch's welcome journey with Vizzy-written emails that isn't turned on yet. */
export function agentLaunchJourneyItem(
  j: Pick<Journey, "id" | "campaignId" | "status" | "graph">,
  launchName: string | undefined,
): ReviewItem | null {
  if (j.status !== "draft") return null;
  if (!j.graph?.nodes?.some((n) => n.data?.agentMeta?.source === "agent3")) return null;
  return {
    id: `journey:${j.id}`,
    kind: "agent_draft",
    title: `Welcome emails for ${launchName ?? "a launch"}`,
    detail: "Drafted by Vizzy · not turned on",
    href: `/admin/launches/${j.campaignId}/journey`,
    action: "Open",
  };
}

/** An invite wave Vizzy drafted that nobody has sent yet (nav v2 phase 4). */
export function agentInviteWaveItem(
  w: Pick<InviteWave, "id" | "campaignId" | "status" | "authoredBy" | "size">,
  launchName: string | undefined,
): ReviewItem | null {
  if (w.authoredBy !== "agent" || w.status !== "draft") return null;
  return {
    id: `wave:${w.id}`,
    kind: "agent_draft",
    title: `Invite ${w.size.toLocaleString("en-GB")} ${w.size === 1 ? "person" : "people"} from ${launchName ?? "a launch"}`,
    detail: "Waitlist invite drafted by Vizzy · not sent",
    href: `/admin/launches/${w.campaignId}/invites?wave=${w.id}`,
    action: "Open",
  };
}

/** A content plan Vizzy drafted that nobody has approved any of yet (nav v2 phase 4). */
export function agentContentPlanItem(
  workspace: { id: string; name: string },
  plan: Pick<ContentPlan, "id" | "name" | "graph" | "status" | "authoredBy">,
): ReviewItem | null {
  if (plan.authoredBy !== "agent" || plan.status === "archived" || plan.status === "scheduled") return null;
  if (plan.graph?.nodes?.some((n) => n.status === "approved")) return null;
  const hubWritten = plan.graph?.nodes?.some((n) => n.type === "hub" && n.status === "generated");
  return {
    id: `plan:${workspace.id}:${plan.id}`,
    kind: "agent_draft",
    title: `“${plan.name}”`,
    detail: `${workspace.name} · content plan drafted by Vizzy${hubWritten ? " · approve the hub to continue" : ""}`,
    href: `/admin/workspace/${workspace.id}/create/${plan.id}`,
    action: "Open",
  };
}

/** A hub-and-spoke plan whose hub is written but not approved (its spokes wait on it). */
export function contentHubItem(
  workspace: { id: string; name: string },
  plan: Pick<ContentPlan, "id" | "name" | "graph">,
): ReviewItem | null {
  const hub = plan.graph?.nodes?.find((n) => n.type === "hub");
  if (!hub || hub.status !== "generated" || !hub.body?.trim()) return null;
  return {
    id: `hub:${workspace.id}:${plan.id}`,
    kind: "content_hub",
    title: `Approve the hub of “${plan.name}”`,
    detail: `${workspace.name} · its spokes are waiting`,
    href: `/admin/workspace/${workspace.id}/create/${plan.id}`,
    action: "Review",
  };
}

const FROM: Record<BrandMapSuggestionFrom, string> = { research: "research", article: "your articles", vizzy: "Vizzy", competitors: "Competitors", autopilot: "Next up" };

/**
 * Suggestions waiting on the brand map: one row, however many (BRAND_MAP_ENABLED). With the
 * map at any size, the subjects, questions and buying situations proposed for it count too.
 */
export function brandMapItem(map: Pick<BrandMap, "suggestions"> | null, proposals = 0): ReviewItem | null {
  const waiting = map ? suggestionsWaiting(map) : [];
  const n = waiting.length + proposals;
  if (!map || n === 0) return null;
  const from = (["research", "article", "vizzy", "competitors"] as const).filter((f) => waiting.some((s) => s.from === f)).map((f) => FROM[f]);
  const said = from.length > 1 ? `${from.slice(0, -1).join(", ")} and ${from.at(-1)}` : (from[0] ?? "");
  if (proposals) {
    return {
      id: "brand_map",
      kind: "brand_map",
      title: `${n} waiting on your brand map`,
      detail: said ? `From ${said}, and new subjects and questions` : "New subjects and questions to look at",
      href: BRAND_KIT_MAP_ROUTE,
      action: "Review",
    };
  }
  return {
    id: "brand_map",
    kind: "brand_map",
    title: `${n} suggestion${n === 1 ? "" : "s"} for your brand map`,
    detail: said ? `From ${said}` : "Waiting for you",
    href: BRAND_KIT_MAP_ROUTE,
    action: "Review",
  };
}

/**
 * A competitor with changes nobody has marked seen (COMPETITORS_ENABLED): one row per competitor,
 * its newest change first. A competitor that needs a person is a row of its own.
 */
export function competitorItems(competitors: Array<Pick<Competitor, "id" | "name" | "status" | "problem">>, unseen: Array<Pick<CompetitorChange, "competitorId" | "headline" | "at">>): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const c of competitors) {
    const href = `${BRAND_KIT_COMPETITORS_ROUTE}/${c.id}`;
    if (c.status === "needs_you") {
      items.push({
        id: `cmp_needs:${c.id}`,
        kind: "competitor_news",
        title: `${c.name} needs you`,
        detail: c.problem ? PROBLEM_TEXT[c.problem] : "We couldn't carry on watching this site without you.",
        href,
        action: "Open",
      });
    }
    const mine = unseen.filter((u) => u.competitorId === c.id).sort((a, b) => b.at.localeCompare(a.at));
    if (!mine.length) continue;
    items.push({
      id: `cmp:${c.id}`,
      kind: "competitor_news",
      title: `${c.name}: ${mine[0]!.headline}`,
      detail: mine.length > 1 ? `And ${mine.length - 1} more change${mine.length === 2 ? "" : "s"} since you last looked` : "Since you last looked",
      href,
      action: "Open",
      markSeen: { competitorId: c.id },
    });
  }
  return items;
}

const CHANNEL: Record<string, string> = {
  blog: "Blog",
  newsletter: "Newsletter",
  linkedin: "LinkedIn",
  x: "X",
  instagram: "Instagram",
};

/** A publish job that failed, with the fix it needs. */
export function failedPostItem(
  post: Pick<ScheduledPost, "id" | "workspaceId" | "channel" | "lastError" | "scheduledAt">,
  workspaceName: string | undefined,
): ReviewItem {
  const err = post.lastError ?? "";
  const distribute = `/admin/workspace/${post.workspaceId}/distribute`;
  const connect = "/admin/account/connections";
  const due = post.scheduledAt ? new Date(post.scheduledAt) : null;
  const when =
    due && !Number.isNaN(due.getTime())
      ? ` · was due ${due.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
      : "";
  const detail = `${CHANNEL[post.channel] ?? post.channel}${workspaceName ? ` · ${workspaceName}` : ""}${when}`;
  const base = { id: `post:${post.id}`, kind: "failed_post" as const, detail };
  if (err === "x_not_connected") return { ...base, title: "Connect X to publish this post", href: connect, action: "Connect" };
  if (err === "linkedin_not_connected")
    return { ...base, title: "Connect LinkedIn to publish this post", href: connect, action: "Connect" };
  if (err === "linkedin_page_not_connected")
    return { ...base, title: "Connect your LinkedIn page to publish this post", href: connect, action: "Connect" };
  if (err.startsWith("x_publish:")) return { ...base, title: "X rejected this post", href: distribute, action: "Open" };
  return { ...base, title: "A post couldn't publish", href: distribute, action: "Open" };
}

/** Consecutive context-endpoint failures before it's worth a person's attention. */
export const CONTEXT_FAILURE_ALERT = 3;

export function connectionItem(
  c: Pick<ProductConnection, "id" | "name" | "kind" | "status" | "health">,
): ReviewItem | null {
  if (c.kind !== "custom" || c.status !== "active") return null;
  const failures = c.health?.consecutiveContextFailures ?? 0;
  if (failures < CONTEXT_FAILURE_ALERT) return null;
  return {
    id: `conn:${c.id}`,
    kind: "connection",
    title: `${c.name}: context endpoint failing`,
    detail: `${failures} failures in a row${c.health?.lastContextError ? ` · ${c.health.lastContextError}` : ""}`,
    href: `/admin/products/${c.id}`,
    action: "Open",
  };
}

// ---------------------------------------------------------------------------
// Loading

export interface Review {
  /** Waiting AI lines (listed by the embedded ApprovalQueue, counted here). */
  aiLines: number;
  items: ReviewItem[];
}

async function soft<T>(label: string, p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (err) {
    console.warn(`[review] ${label} unavailable:`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

const RUN_FAILED: Record<string, string> = {
  no_programme: "Choose the programme it writes into, in Autopilot on Brand › Brand map.",
  nothing_to_pick: "Every question on your brand map is answered or planned.",
  judge_failed: "Sorting what buyers ask didn't finish. It tries again next time.",
  research_failed: "Research didn't finish. It tries again next time.",
  write_failed: "Writing didn't finish. It tries again next time.",
  architect_failed: "Planning the workflow didn't finish. It tries again next time.",
};

/**
 * The article autopilot's rows (CREATE_ARTICLE_AUTOPILOT_ENABLED), from the brand's recent runs: the
 * newest question sorted and ready to write (Suggest mode), questions a draft asks the team, and
 * the newest run that couldn't finish. The drafts themselves show as Vizzy's drafts, once done.
 */
export function nextArticleItems(runs: AutopilotRun[], nowMs = Date.now()): ReviewItem[] {
  const recent = runs.filter((r) => nowMs - Date.parse(r.updatedAt) < 14 * 86_400_000).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const out: ReviewItem[] = [];
  const ready = recent.find((r) => r.trigger === "schedule" && r.mode === "suggest" && r.step === "sorted" && r.question);
  if (ready) {
    out.push({
      id: `next_article:${ready.id}`,
      kind: "next_article",
      title: `Next article ready to write: “${ready.question!.text}”`,
      detail: `${ready.trays?.use.length ?? 0} questions buyers ask go in it. Open Next up to sort them and write it.`,
      href: "/admin/brand-kit/map",
      action: "Review",
    });
  }
  for (const r of recent.filter((x) => x.mode === "draft" && x.step === "done" && x.askedIds.length && x.planId && x.workspaceId).slice(0, 3)) {
    out.push({
      id: `next_article_asks:${r.id}`,
      kind: "next_article",
      title: `${r.askedIds.length} question${r.askedIds.length === 1 ? "" : "s"} for your next article`,
      detail: `For “${r.question?.text ?? r.planId}”: answers from your team make the draft speak from experience.`,
      href: `/admin/workspace/${r.workspaceId}/create/${r.planId}`,
      action: "Open",
    });
  }
  for (const r of recent.filter((x) => x.mode === "draft" && x.answersIn && x.planId && x.workspaceId).slice(0, 3)) {
    out.push({
      id: `next_article_answers:${r.id}`,
      kind: "next_article",
      title: `Your team's answers are in for “${r.question?.text ?? r.planId}”`,
      detail: "The draft was changed since autopilot wrote it, so it wasn't rewritten. Press Look again in its Brief to use the answers.",
      href: `/admin/workspace/${r.workspaceId}/create/${r.planId}`,
      action: "Open",
    });
  }
  const failed = recent.find((r) => r.trigger === "schedule" && r.step === "failed");
  if (failed) {
    out.push({
      id: `next_article_failed:${failed.id}`,
      kind: "next_article",
      title: `Autopilot couldn't finish${failed.question ? `: “${failed.question.text}”` : ""}`,
      detail: RUN_FAILED[failed.error ?? ""] ?? "It tries again with the next run.",
      href: "/admin/brand-kit/map",
      action: "Open",
    });
  }
  return out;
}

/** Content hubs waiting for approval — a read of recent plans in each workspace. */
export async function loadContentHubItems(ctx: TenantContext, workspaces: Array<{ id: string; name: string }>) {
  const perWorkspace = await Promise.all(
    workspaces.slice(0, 20).map(async (ws) => {
      const plans = await soft(`plans in ${ws.id}`, listContentPlans(ctx, ws.id, 100), [] as ContentPlan[]);
      // A plan Vizzy drafted shows once, as its draft (which says to approve the hub). One the
      // article autopilot is still writing shows only once it is done.
      return plans
        .filter((p) => p.autopilot?.state !== "working")
        .map((p) => agentContentPlanItem(ws, p) ?? contentHubItem(ws, p))
        .filter((i): i is ReviewItem => !!i);
    }),
  );
  return perWorkspace.flat();
}

export async function loadReview(
  ctx: TenantContext,
  opts: { lifecycle: boolean; includeContent: boolean },
  db?: FirestoreLike,
): Promise<Review> {
  const repos = forTenant(ctx, db);
  const invites = isInvitesUiEnabled() && isInvitesEnabled();
  const competitorsOn = isCompetitorsEnabled() && (await soft("competitors access", brandCanUse(ctx, "competitors"), false));
  const [aiLines, connections, agentJourneys, launchJourneys, campaigns, workspaces, failedPosts, agentWaves, brandMap, brandMapProposals, competitors, competitorNews] = await Promise.all([
    opts.lifecycle ? soft("ai lines", countWaitingApprovals(ctx, db), 0) : 0,
    opts.lifecycle ? soft("connections", repos.productConnections.find({ limit: 100 }), []) : [],
    opts.lifecycle || isWaitlistEngineUiEnabled()
      ? soft("agent journeys", repos.lifecycleJourneys.find({ where: [["authoredBy", "==", "agent"]], limit: 50 }), [])
      : [],
    soft("launch journeys", repos.journeys.find({ where: [["status", "==", "draft"]], limit: 50 }), []),
    soft("launches", repos.campaigns.find({ orderBy: [["createdAt", "desc"]], limit: 100 }), []),
    soft("workspaces", repos.workspaces.find({ where: [], limit: 200 }), []),
    soft(
      "failed posts",
      repos.scheduledPosts.find({
        where: [
          ["status", "==", "failed"],
          ["jobKind", "==", "publish"],
        ],
        limit: 50,
      }),
      [],
    ),
    invites
      ? soft(
          "invite waves",
          repos.inviteWaves.find({
            where: [
              ["status", "==", "draft"],
              ["authoredBy", "==", "agent"],
            ],
            limit: 50,
          }),
          [],
        )
      : [],
    isBrandMapEnabled() ? soft("brand map", readBrandMap(ctx, db).then((r) => (r.state === "ok" ? r.map : null)), null) : null,
    isBrandMapScaleEnabled() ? soft("brand map proposals", proposalsWaiting(ctx, { db }), 0) : 0,
    competitorsOn ? soft("competitors", listCompetitors(ctx, { db }), [] as Competitor[]) : ([] as Competitor[]),
    competitorsOn ? soft("competitor changes", unseenChanges(ctx, { db }), [] as CompetitorChange[]) : ([] as CompetitorChange[]),
  ]);

  const autopilotRuns = isAutopilotEnabled() ? await soft("autopilot runs", recentRuns(ctx, 20, { db }), [] as AutopilotRun[]) : [];
  const liveConnections = connections.filter((c) => c.kind === "custom" && c.status !== "revoked");
  const latestRuns = await Promise.all(
    liveConnections.map((c) => soft("repo analyses", listRepoAnalyses(ctx, c.id, db), [] as RepoAnalysis[])),
  );
  const launchNames = new Map(campaigns.map((c) => [c.id, c.waitlistName]));
  const activeWorkspaces = workspaces.filter((w) => !w.archivedAt).map((w) => ({ id: w.id, name: w.name }));
  const workspaceNames = new Map(workspaces.map((w) => [w.id, w.name]));

  const items: ReviewItem[] = [
    ...[...failedPosts]
      .sort((a, b) => (b.scheduledAt ?? "").localeCompare(a.scheduledAt ?? ""))
      .map((p) => failedPostItem(p, workspaceNames.get(p.workspaceId))),
    ...connections.map(connectionItem),
    ...agentJourneys.map((j) => agentJourneyItem(j, j.audience?.kind === "waitlist" ? launchNames.get(j.audience.campaignId) : undefined)),
    ...launchJourneys.map((j) => agentLaunchJourneyItem(j, launchNames.get(j.campaignId))),
    ...agentWaves.map((w) => agentInviteWaveItem(w, launchNames.get(w.campaignId))),
    ...liveConnections.map((c, i) => repoResultsItem(c, latestRuns[i]?.[0])),
    brandMapItem(brandMap, brandMapProposals),
    ...competitorItems(competitors, competitorNews),
    ...nextArticleItems(autopilotRuns),
    ...(opts.includeContent ? await loadContentHubItems(ctx, activeWorkspaces) : []),
  ].filter((i): i is ReviewItem => !!i);

  return { aiLines, items };
}

// The sidebar polls the count every minute; one read of every source per tenant
// per two minutes is plenty (the Review page itself always reads fresh).
const COUNT_TTL_MS = 2 * 60 * 1000;
const countCache = new Map<string, { at: number; total: number }>();

export async function countReview(
  ctx: TenantContext,
  opts: { lifecycle: boolean; now?: number },
  db?: FirestoreLike,
): Promise<number> {
  const now = opts.now ?? Date.now();
  const hit = countCache.get(ctx.tenantId);
  if (hit && now - hit.at < COUNT_TTL_MS) return hit.total;
  const review = await loadReview(ctx, { lifecycle: opts.lifecycle, includeContent: !db }, db);
  const total = review.aiLines + review.items.length;
  countCache.set(ctx.tenantId, { at: now, total });
  return total;
}

/** Forget one brand's cached count, after something that changes it (a change marked seen). */
export function forgetReviewCount(tenantId: string): void {
  countCache.delete(tenantId);
}

/** Test hook: forget cached counts. */
export function resetReviewCountCache(): void {
  countCache.clear();
}
