import { forTenant } from "@/lib/tenant";
import { isAutopilotEnabled } from "@/lib/autopilot/flags";
import { readyToWrite, recentRuns } from "@/lib/autopilot/runs";
import { MAX_PER_WEEK, type AutopilotRun } from "@/lib/types/autopilot";
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
import type { AgentAction } from "@/lib/types/agentAction";
import { agentActionReviewItem, listOpenAgentActions } from "@/lib/ontology/agentActions";
import { canAddPeople, isVizzyAddPersonEnabled, isVizzyFieldsEnabled } from "@/lib/audience/peopleFlags";
import { PERSON_FIELDS_ACTION } from "@/lib/audience/fieldSuggestions";
import { NEW_PERSON_ACTION } from "@/lib/audience/personDrafts";
import { readFieldList } from "@/lib/audience/fieldList";
import { isConnectorsCollectEnabled } from "@/lib/connectors/flags";
import { dayWords } from "@/lib/connectors/period";
import { getConnector, knownConnector } from "@/lib/connectors/registry";
import type { DataConnection } from "@/lib/types/dataConnection";

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
  | "data_source"
  | "competitor_news"
  | "next_article"
  | "data_signal"
  | "person_suggestion";

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
  data_source: {
    title: "Data sources that need you",
    description: "A connection that can't be read, so no new numbers are collected for it.",
  },
  competitor_news: {
    title: "What your competitors changed",
    description: "New posts on their news pages and changes to their sites since you last looked. Open one to read it, or mark it seen.",
  },
  next_article: {
    title: "Your next article",
    description: "What the article autopilot found and sorted, the questions it asks your team, and runs that couldn't finish.",
  },
  data_signal: {
    title: "What your numbers suggest",
    description: "Searches and pages from Search Console worth an article. Plan one, or dismiss it.",
  },
  person_suggestion: {
    title: "Suggestions about people",
    description: "Changes to people's fields, and people to add, that Vizzy suggested. Nothing changes until someone on your team confirms.",
  },
};

/** Order of sections on the page (AI lines are time-bound, so they come first). */
export const REVIEW_ORDER: ReviewKind[] = ["ai_line", "failed_post", "connection", "data_source", "next_article", "agent_draft", "person_suggestion", "repo_results", "brand_map", "competitor_news", "content_hub"];

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

/** Collecting has failed this many days before a connection shows in Review. */
export const COLLECT_FAILED_DAYS = 3;
/** An admin's pause this many days old shows in Review. */
export const PAUSED_DAYS = 7;
const DAY_MS = 86_400_000;

/** The Connected view with this connection selected. */
export const connectedHref = (id: string) => `/admin/account/connections/connected?c=${encodeURIComponent(id)}`;

/** "19 Nov", from an instant. */
const dayOf = (iso: string) => dayWords(iso.slice(0, 10));

/**
 * A data source that needs someone (CONNECTORS_COLLECT_ENABLED, admins only): a connection its
 * provider turned down, one with no property chosen, one whose collecting has failed since 3 or
 * more days ago (collect.failedSince, as health counts calls, not days), or one an admin paused 7
 * or more days ago. Each links to the Connected view with that connection selected. A connection
 * whose connector this copy has turned off reads nothing on purpose, so it isn't listed.
 */
export function dataSourceItem(c: DataConnection, now: Date = new Date()): ReviewItem | null {
  if (c.status !== "connected" || !getConnector(c.connectorId)) return null;
  const tool = knownConnector(c.connectorId)?.name ?? c.connectorId;
  const name = c.label && c.label !== tool ? `${tool} for ${c.label}` : tool;
  const base = { id: `data_source:${c.id}`, kind: "data_source" as const, href: connectedHref(c.id) };
  if (c.health.state === "broken") {
    const since = dayOf(c.health.since ?? c.health.lastCheckedAt ?? now.toISOString());
    const fix =
      c.method === "share_access"
        ? `It can't read its property since ${since}, so no new numbers are collected. Add YouGrow's address to the property again.`
        : c.method === "oauth_pkce"
          ? `It can't be read since ${since}, so no new numbers are collected. Reconnect it by signing in with Google again.`
          : `It can't be read since ${since}, so no new numbers are collected. Reconnect it with a new token.`;
    return { ...base, title: `${name} needs you`, detail: fix, action: "Fix" };
  }
  if (!c.account) return { ...base, title: `${name} needs you`, detail: "It reads nothing until a property is chosen, so no numbers are collected.", action: "Choose" };
  const failedSince = c.collect?.failedSince;
  if (failedSince && now.getTime() - Date.parse(failedSince) >= COLLECT_FAILED_DAYS * DAY_MS) {
    return { ...base, title: `${name} needs you`, detail: `Collecting its numbers has failed since ${dayOf(failedSince)}, so the newest are missing. Press Check now on it to see why.`, action: "Fix" };
  }
  if (c.pausedAt && now.getTime() - Date.parse(c.pausedAt) >= PAUSED_DAYS * DAY_MS) {
    return { ...base, title: `${name} is paused`, detail: `Paused since ${dayOf(c.pausedAt)}, so no new numbers are collected. Resume it, or disconnect it if you no longer need it.`, action: "Open" };
  }
  return null;
}

/** The brand's connected data sources that need someone: equality on status only. */
async function dataSourceItems(ctx: TenantContext, db?: FirestoreLike): Promise<ReviewItem[]> {
  const connections = await forTenant(ctx, db).dataConnections.find({ where: [["status", "==", "connected"]], limit: 50 });
  return connections.map((c) => dataSourceItem(c)).filter((i): i is ReviewItem => !!i);
}

/**
 * Vizzy's suggestion about one person (AUDIENCE_VIZZY_FIELDS_ENABLED), linking to their page. The
 * title and detail never hold the person's name, address or any value: only the brand's own field
 * names, by the field list as it is now.
 */
export function personSuggestionItem(a: AgentAction, labels: ReadonlyMap<string, string>): ReviewItem | null {
  // A New person form Vizzy filled in (AUDIENCE_VIZZY_ADD_PERSON_ENABLED): who it is stays in the form.
  if (a.action === NEW_PERSON_ACTION) {
    return agentActionReviewItem(a, {
      title: "Vizzy filled in New person for you",
      detail: "Check it, say how they agreed, and add them, or dismiss it. It goes after 7 days.",
      action: "Open",
    });
  }
  if (a.action !== PERSON_FIELDS_ACTION) return null;
  const names = a.fieldIds.map((id) => labels.get(id)).filter((l): l is string => !!l);
  const title =
    a.fieldIds.length === 1 && names.length === 1 ? `Vizzy suggests a change to ${names[0]}` : `Vizzy suggests changes to ${a.fieldIds.length} fields`;
  return agentActionReviewItem(a, {
    title,
    detail: `${names.length > 1 ? `${names.join(", ")} · ` : ""}On one person's page. Nothing changes until someone confirms.`,
    action: "Review",
  });
}

/**
 * Open field suggestions and New person drafts, each switch's own, newest first within each, field
 * suggestions labelled by the People field list (index: action, state, createdAt desc).
 */
async function personSuggestionItems(ctx: TenantContext, opts: { fields: boolean; drafts: boolean }, db?: FirestoreLike): Promise<ReviewItem[]> {
  const [drafts, open] = await Promise.all([
    opts.drafts ? listOpenAgentActions(ctx, { action: NEW_PERSON_ACTION, limit: 50, db }) : ([] as AgentAction[]),
    opts.fields ? listOpenAgentActions(ctx, { action: PERSON_FIELDS_ACTION, limit: 50, db }) : ([] as AgentAction[]),
  ]);
  const labels = open.length ? new Map((await readFieldList(ctx, "person", db)).items.map((f) => [f.key, f.label])) : new Map<string, string>();
  return [...drafts, ...open].map((a) => personSuggestionItem(a, labels)).filter((i): i is ReviewItem => !!i);
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
  // Every question sorted and waiting to be written (several a week), Draft runs past their cap too.
  for (const ready of readyToWrite(runs, nowMs)) {
    out.push({
      id: `next_article:${ready.id}`,
      kind: "next_article",
      title: `Next article ready to write: “${ready.question!.text}”`,
      detail:
        ready.error === "monthly_limit"
          ? "This month's drafts are used up, so autopilot found and sorted it for you to write. Open Next up to write it."
          : `${ready.trays?.use.length ?? 0} questions buyers ask go in it. Open Next up to sort them and write it.`,
      href: "/admin/brand-kit/map",
      action: "Review",
    });
  }
  for (const r of recent.filter((x) => x.mode === "draft" && x.step === "done" && x.askedIds.length && x.planId && x.workspaceId).slice(0, MAX_PER_WEEK)) {
    out.push({
      id: `next_article_asks:${r.id}`,
      kind: "next_article",
      title: `${r.askedIds.length} question${r.askedIds.length === 1 ? "" : "s"} for your next article`,
      detail: `For “${r.question?.text ?? r.planId}”: answers from your team make the draft speak from experience.`,
      href: `/admin/workspace/${r.workspaceId}/create/${r.planId}`,
      action: "Open",
    });
  }
  for (const r of recent.filter((x) => x.mode === "draft" && x.answersIn && x.planId && x.workspaceId).slice(0, MAX_PER_WEEK)) {
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

  const autopilotRuns = isAutopilotEnabled() ? await soft("autopilot runs", recentRuns(ctx, 60, { db }), [] as AutopilotRun[]) : [];
  // New person drafts only where this user can open the form: admins, who alone add someone
  // (decision 28), with the People list on screen. Field suggestions show to everyone, since the
  // person's page tells a member that an admin confirms.
  const people = { fields: isVizzyFieldsEnabled(), drafts: isVizzyAddPersonEnabled() && canAddPeople(ctx.role) };
  const personSuggestions = people.fields || people.drafts ? await soft("person suggestions", personSuggestionItems(ctx, people, db), [] as ReviewItem[]) : [];
  // Data sources that need someone: admins only, while collected numbers are on.
  const dataSources = isConnectorsCollectEnabled() && ctx.role === "admin" ? await soft("data sources", dataSourceItems(ctx, db), [] as ReviewItem[]) : [];
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
    ...dataSources,
    ...agentJourneys.map((j) => agentJourneyItem(j, j.audience?.kind === "waitlist" ? launchNames.get(j.audience.campaignId) : undefined)),
    ...launchJourneys.map((j) => agentLaunchJourneyItem(j, launchNames.get(j.campaignId))),
    ...agentWaves.map((w) => agentInviteWaveItem(w, launchNames.get(w.campaignId))),
    ...personSuggestions,
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

/** The count's cache key: per brand, and per role, since some items are for admins only. */
function countKey(tenantId: string, role: TenantContext["role"]): string {
  return `${tenantId}|${role === "admin" ? "admin" : "member"}`;
}

export async function countReview(
  ctx: TenantContext,
  opts: { lifecycle: boolean; now?: number },
  db?: FirestoreLike,
): Promise<number> {
  const now = opts.now ?? Date.now();
  const key = countKey(ctx.tenantId, ctx.role);
  const hit = countCache.get(key);
  if (hit && now - hit.at < COUNT_TTL_MS) return hit.total;
  const review = await loadReview(ctx, { lifecycle: opts.lifecycle, includeContent: !db }, db);
  const total = review.aiLines + review.items.length;
  countCache.set(key, { at: now, total });
  return total;
}

/** Forget one brand's cached count, after something that changes it (a change marked seen). */
export function forgetReviewCount(tenantId: string): void {
  countCache.delete(countKey(tenantId, "admin"));
  countCache.delete(countKey(tenantId, "member"));
}

/** Test hook: forget cached counts. */
export function resetReviewCountCache(): void {
  countCache.clear();
}
