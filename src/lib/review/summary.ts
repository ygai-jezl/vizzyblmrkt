import { forTenant } from "@/lib/tenant";
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

/**
 * Review (nav v2 phase 2): every decision waiting on a person, in one place,
 * each linking back to where it came from. AI lines keep their own queue (the
 * ApprovalQueue component, embedded on the page); everything else is listed here.
 *
 * The per-source rules are pure and unit-tested; loadReview gathers them. Content
 * hubs need a read of every plan (content plans are a per-workspace subcollection),
 * so the sidebar count caches that part — see countReview.
 */

export type ReviewKind = "ai_line" | "repo_results" | "agent_draft" | "content_hub" | "failed_post" | "connection";

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  title: string;
  detail: string;
  href: string;
  /** The link's verb, e.g. "Review" or "Connect". */
  action: string;
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
};

/** Order of sections on the page (AI lines are time-bound, so they come first). */
export const REVIEW_ORDER: ReviewKind[] = ["ai_line", "failed_post", "connection", "agent_draft", "repo_results", "content_hub"];

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
  j: Pick<LifecycleJourney, "id" | "name" | "authoredBy" | "publishedVersion" | "status">,
): ReviewItem | null {
  if (j.authoredBy !== "agent" || j.publishedVersion != null || j.status === "archived") return null;
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

/** Content hubs waiting for approval — a read of recent plans in each workspace. */
export async function loadContentHubItems(ctx: TenantContext, workspaces: Array<{ id: string; name: string }>) {
  const perWorkspace = await Promise.all(
    workspaces.slice(0, 20).map(async (ws) => {
      const plans = await soft(`plans in ${ws.id}`, listContentPlans(ctx, ws.id, 100), [] as ContentPlan[]);
      return plans.map((p) => contentHubItem(ws, p)).filter((i): i is ReviewItem => !!i);
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
  const [aiLines, connections, agentJourneys, launchJourneys, campaigns, workspaces, failedPosts] = await Promise.all([
    opts.lifecycle ? soft("ai lines", countWaitingApprovals(ctx, db), 0) : 0,
    opts.lifecycle ? soft("connections", repos.productConnections.find({ limit: 100 }), []) : [],
    opts.lifecycle
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
  ]);

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
    ...agentJourneys.map(agentJourneyItem),
    ...launchJourneys.map((j) => agentLaunchJourneyItem(j, launchNames.get(j.campaignId))),
    ...liveConnections.map((c, i) => repoResultsItem(c, latestRuns[i]?.[0])),
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

/** Test hook: forget cached counts. */
export function resetReviewCountCache(): void {
  countCache.clear();
}
