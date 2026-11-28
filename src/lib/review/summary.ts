import { forTenant, getTenantById, organisationContextFor } from "@/lib/tenant";
import { readDueArticles } from "@/lib/content/blog/freshnessPages";
import { refreshHref } from "@/lib/content/blog/freshnessHref";
import type { FreshnessDueItem } from "@/lib/types/freshness";
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
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { ideaWord } from "@/lib/nav/terms";
import type { BrandMap, BrandMapSuggestionFrom } from "@/lib/types/brandMap";
import { isBlogFreshnessEnabled, isBlogRefreshEnabled, isBrandMapEnabled, isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { proposalsWaiting, suggestionsWaiting } from "@/lib/brandMap/waiting";
import { readBrandMap } from "@/lib/brandMap/store";
import { BRAND_KIT_COMPETITORS_ROUTE, BRAND_KIT_EMAIL_STYLE_ROUTE, BRAND_KIT_IMAGE_STYLE_ROUTE, BRAND_KIT_MAP_ROUTE, BRAND_KIT_NOTES_ROUTE } from "@/lib/content/brandKit";
import { isAgentRecordEnabled } from "@/lib/agentRecord/flags";
import { isEmailStyleEnabled } from "@/lib/email/flags";
import { isBrandImageStyleEnabled } from "@/lib/content/imageStyle/flags";
import { isBrandNotesEnabled } from "@/lib/brandNotes/flags";
import type { BrandNote } from "@/lib/types/brandNote";
import type { Tenant } from "@/lib/types/tenant";
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
import { isOnboardingEnabled } from "@/lib/onboarding/flags";
import { BUSINESS_FACT_ACTION, businessFactReviewItem } from "@/lib/onboarding/factSuggestions";
import { canPaste } from "@/lib/crm/paste/flags";
import { pasteBatchItems } from "@/lib/crm/paste/review";
import { readFieldList } from "@/lib/audience/fieldList";
import { isConnectorsCollectEnabled, isConnectorSignalsEnabled } from "@/lib/connectors/flags";
import { signalReviewItems } from "@/lib/connectors/signals/review";
import { dayWords } from "@/lib/connectors/period";
import { getConnector, knownConnector } from "@/lib/connectors/registry";
import { COLLECT_FAILED_DAYS } from "@/lib/connectors/health";
import { productName } from "@/lib/connectors/messages";
import { PartCache, partFactsOf, type PartFacts, type SourceDeps } from "@/lib/connectors/sources";
import type { DataConnection } from "@/lib/types/dataConnection";
import type { LoopKind } from "@/lib/loops/registry";
import { isWorkEnabled } from "@/lib/work/flags";
import { workReviewItems } from "@/lib/work/review";
import type { WorkReviewPayload } from "@/lib/work/reviewCards";
import { isStrategyCheckEnabled, isStrategySuggestEnabled } from "@/lib/brandStrategy/flags";
import { readBrandStrategyDoc } from "@/lib/brandStrategy/store";
import { reasonLine } from "@/lib/brandStrategy/checkRules";
import { isReviewSuggestion, sourcesLine, SUGGEST_WORDS, suggestionAction, suggestionLines } from "@/lib/brandStrategy/suggestRules";
import type { BrandStrategyDoc, StrategyCheck, StrategySuggestion } from "@/lib/types/brandStrategy";
import { isRaiseFollowupsEnabled } from "@/lib/raise/pipeline/flags";
import { isAssetTranslationsEnabled, isPageLanguagesEnabled } from "@/lib/i18n/flags";
import { REVIEW_WORDS } from "@/lib/raise/pipeline/words";

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
  | "strategy_check"
  | "strategy_suggest"
  | "next_article"
  | "data_signal"
  | "content_refresh"
  | "person_suggestion"
  | "work_check"
  | "work_ready"
  | "work_suggestion"
  | "raise_followup"
  | "paste_batch"
  | "business_fact"
  | "translation_check"
  | "page_translation";

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
  /** A suggestion from collected numbers: Plan an article and Dismiss instead of the link (admins only). */
  signal?: { id: string };
  /** The detail as lines, each shown in full (a suggestion's numbers). */
  details?: string[];
  /** A Work row's buttons (WORK_ENABLED): a check's read or Done and Tomorrow, Start, or a suggestion's Add to Work, Edit then add and Dismiss. */
  work?: WorkReviewPayload;
  /** The weekly strategy check's row: Dismiss beside the link (admins only). */
  dismissCheck?: true;
  /** The strategy's month row (STRATEGY_SUGGEST_ENABLED): Not now, with why, beside the link (admins only). */
  notNow?: { key: string };
  /** A follow-up from the investor or funding board: I followed up today (quiet ones) and Dismiss beside the link (admins only). */
  followUp?: { id: string; rev: number; quiet: boolean };
  /** A journey's translations to check (ASSET_TRANSLATIONS_ENABLED): Approve all languages beside the link (admins only). */
  approveLanguages?: { endpoint: string; revs: Record<string, number> };
}

/**
 * One Review section. `from` names the choices YouGrow made that the section shows
 * (src/lib/loops/registry.ts), so a new section says which choice it is about and a new rule behind
 * one needs its own line there. null only for a section that shows no choice YouGrow made, such as
 * a failure or a broken connection, with a comment saying so.
 */
export interface ReviewSection {
  title: string;
  description: string;
  from: readonly [LoopKind, ...LoopKind[]] | null;
}

export const REVIEW_SECTIONS: Record<ReviewKind, ReviewSection> = {
  ai_line: {
    title: "AI lines for upcoming emails",
    description: "Personal lines for tomorrow's lifecycle emails. Anything you don't decide in time goes out as the standard version.",
    from: ["lifecycle_lines"],
  },
  repo_results: {
    title: "Learned from your repo",
    description: "Onboarding steps, events and facts found in your code, waiting for you to accept them into the catalog.",
    from: ["product_map"],
  },
  agent_draft: {
    title: "Drafts from Vizzy",
    description: "Vizzy only saves drafts. Check them, then publish or turn them on when you're happy.",
    // With the agent record on (AGENT_RECORD_ENABLED), admins also see Vizzy's email and image style
    // suggestions and the notes it suggested in chats.
    from: ["canvas.journey", "canvas.lifecycle", "canvas.journey_style", "canvas.invite_wave", "canvas.content_plan", "autopilot", "email_copy", "email_hero", "canvas.email_style", "canvas.image_style", "vizzy_chat"],
  },
  brand_map: {
    title: "Brand map suggestions",
    description: "Names, subjects and questions found by research, your articles and Vizzy, waiting for you to accept or dismiss them.",
    from: ["brand_map_research", "situations", "situation_questions", "canvas.brand_map", "blog_research", "autopilot_research", "competitor_topics", "judge", "rising_search"],
  },
  content_hub: {
    title: "Content waiting for approval",
    description: "Approve a hub to let its spokes be written.",
    from: ["content_hub", "blog_write", "ebook", "blog_refresh"],
  },
  failed_post: {
    title: "Posts that need you",
    description: "Scheduled posts that couldn't publish.",
    // a post that could not publish: a delivery problem, not a choice YouGrow made
    from: null,
  },
  connection: {
    title: "Connection problems",
    description: "Your product's context endpoint keeps failing, so personal lines fall back to the standard version.",
    // a product's context endpoint failing: health, not a choice YouGrow made
    from: null,
  },
  data_source: {
    title: "Data sources that need you",
    description: "A connection that can't be read, so no new numbers are collected for it.",
    // a connected source that can't be read: health, not a choice YouGrow made
    from: null,
  },
  competitor_news: {
    title: "What your competitors changed",
    description: "New posts on their news pages and changes to their sites since you last looked. Open one to read it, or mark it seen.",
    from: ["competitor_analysis"],
  },
  strategy_check: {
    title: "Your strategy against competitors",
    description: "Once a week your approved strategy is set against what your competitors publish. It asks for a look only when something material changed: review the strategy, or dismiss it for 30 days.",
    from: ["strategy_check"],
  },
  strategy_suggest: {
    title: SUGGEST_WORDS.title,
    description:
      "Once a month, after How it went is added up, one change worth a look: your plan falling behind, a focus situation that stalled, a claim still without proof, or a tool to connect. Review the strategy, or say Not now and why.",
    from: ["strategy_suggest"],
  },
  next_article: {
    title: "Your next article",
    description: "What the article autopilot found and sorted, the questions it asks your team, and runs that couldn't finish.",
    from: ["next_up", "autopilot", "judge", "seen_notes"],
  },
  data_signal: {
    title: "What your numbers suggest",
    description: "Searches and pages from Search Console worth an article. Plan one, or dismiss it.",
    from: ["rising_search", "losing_page", "within_reach"],
  },
  content_refresh: {
    title: "Articles due a refresh",
    description: "Live articles past their refresh clock, or with a reason to look again. Open one to see why, or mark it checked.",
    from: ["blog_refresh", "refresh_due", "freshness_clock"],
  },
  person_suggestion: {
    title: "Suggestions about people",
    description: "Changes to people's fields, and people to add, that Vizzy suggested. Nothing changes until someone on your team confirms.",
    from: ["canvas.person_fields", "canvas.new_person"],
  },
  work_check: {
    title: "Checks due today",
    description:
      "Tasks in Work to look at again today: on a date you set, when another task is done, or when a task's measure says to look. A measure's check asks if it worked.",
    from: ["work_check_due"],
  },
  work_ready: {
    title: "Ready to start",
    description: "To do tasks with nothing in their way. Start the one you want next, and Work keeps which you picked.",
    from: ["work_ready"],
  },
  work_suggestion: {
    title: "Tasks Vizzy suggests",
    description: "From your log, your numbers and the stage you're in. Nothing goes on the list until someone adds it, as written or edited.",
    from: ["vizzy_chat"],
  },
  raise_followup: {
    title: REVIEW_WORDS.title,
    description: REVIEW_WORDS.description,
    from: ["investor_quiet"],
  },
  paste_batch: {
    title: "Pasted lists",
    description: "Lists your team pasted on People, waiting for an admin to add them. Nobody is added until then.",
    from: ["paste_columns"],
  },
  page_translation: {
    title: "Pages in other languages",
    description: "Articles and sign-up pages in other languages, one row each. Each stays out of sight until you approve it.",
    from: ["translation"],
  },
  translation_check: {
    title: "Emails in other languages",
    description: "Translations of your journey emails, one row per journey. Readers of each language get the default until you approve theirs.",
    from: ["translation"],
  },
  business_fact: {
    title: "About your business",
    description: "Things Vizzy heard about your business in a chat. Vizzy uses one only once an admin keeps it in Settings, About your business.",
    from: ["vizzy_chat"],
  },
};

/** Order of sections on the page (AI lines are time-bound, so they come first). */
export const REVIEW_ORDER: ReviewKind[] = [
  "ai_line",
  "work_check",
  "work_ready",
  "failed_post",
  "connection",
  "data_source",
  "next_article",
  "data_signal",
  "content_refresh",
  "work_suggestion",
  "agent_draft",
  "translation_check",
  "page_translation",
  "person_suggestion",
  "raise_followup",
  "paste_batch",
  "business_fact",
  "repo_results",
  "brand_map",
  "competitor_news",
  "strategy_check",
  "strategy_suggest",
  "content_hub",
];

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

/** A launch with no name left: "a launch", or "an idea" while the words are on (isIdeaWordsEnabled(); Review is built on the server). */
const unnamedLaunch = (): string => ideaWord(isIdeaWordsEnabled()).a;

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
      title: `Welcome emails for ${launchName ?? unnamedLaunch()}`,
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
    title: `Welcome emails for ${launchName ?? unnamedLaunch()}`,
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
    title: `Invite ${w.size.toLocaleString("en-GB")} ${w.size === 1 ? "person" : "people"} from ${launchName ?? unnamedLaunch()}`,
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

/** The words for a style Vizzy suggested: which page, by the kind of style. */
const STYLE_WORDS = {
  email: { title: "Email style Vizzy suggested", page: "Brand › Email style", href: BRAND_KIT_EMAIL_STYLE_ROUTE },
  image: { title: "Image style Vizzy suggested", page: "Brand › Image style", href: BRAND_KIT_IMAGE_STYLE_ROUTE },
} as const;

/**
 * A style Vizzy suggested that no admin has saved or dismissed (agent record, admins only), read
 * from the brand's record, where it lives: one row, opening the page that saves it.
 */
export function agentStyleItem(kind: "email" | "image", suggestion: { suggestedAt: string } | null | undefined): ReviewItem | null {
  if (!suggestion?.suggestedAt) return null;
  const words = STYLE_WORDS[kind];
  const day = /^\d{4}-\d{2}-\d{2}/.test(suggestion.suggestedAt) ? ` on ${dayOf(suggestion.suggestedAt)}` : "";
  return {
    id: `${kind}_style:${suggestion.suggestedAt}`,
    kind: "agent_draft",
    title: words.title,
    detail: `Suggested in a chat${day} · Nothing changes until an admin saves it on ${words.page}.`,
    href: words.href,
    action: "Review",
  };
}

/**
 * The notes Vizzy suggested in chats that nobody has kept or removed (agent record, admins only):
 * one row. `more`: the read was full, so there may be more than it counted.
 */
export function agentNotesItem(waiting: number, more = false): ReviewItem | null {
  if (waiting <= 0) return null;
  return {
    id: "brand_notes:suggested",
    kind: "agent_draft",
    title: more ? `${waiting} or more notes Vizzy suggested` : `${waiting} note${waiting === 1 ? "" : "s"} Vizzy suggested`,
    detail: "From your chats · Keep the right ones on What we've seen. Articles use only the notes you keep.",
    href: BRAND_KIT_NOTES_ROUTE,
    action: "Review",
  };
}

/** Most suggested notes read for the row. */
const NOTES_READ = 50;

/**
 * What Review lists that only the agent record added (AGENT_RECORD_ENABLED, admins only), each
 * read where it lives: the brand record's style suggestions, and the notes from chats waiting
 * (equality on status and source only, up to 50: a full read says "or more").
 */
async function agentRecordItems(ctx: TenantContext, db?: FirestoreLike): Promise<ReviewItem[]> {
  const styles = isEmailStyleEnabled() || isBrandImageStyleEnabled();
  const [tenant, notes] = await Promise.all([
    styles ? soft("style suggestions", getTenantById(ctx.tenantId, db), null as Tenant | null) : (null as Tenant | null),
    isBrandNotesEnabled()
      ? soft(
          "suggested notes",
          forTenant(ctx, db).brandNotes.find({
            where: [
              ["status", "==", "suggested"],
              ["source", "==", "chat"],
            ],
            limit: NOTES_READ,
          }),
          [] as BrandNote[],
        )
      : ([] as BrandNote[]),
  ]);
  return [
    isEmailStyleEnabled() ? agentStyleItem("email", tenant?.emailStyleSuggestion) : null,
    isBrandImageStyleEnabled() ? agentStyleItem("image", tenant?.imageStyleSuggestion) : null,
    agentNotesItem(notes.length, notes.length >= NOTES_READ),
  ].filter((i): i is ReviewItem => !!i);
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

/**
 * The weekly strategy check's open row (STRATEGY_CHECK_ENABLED): one at most, each reason a line.
 * Review the strategy opens the Strategy tab.
 */
export function strategyCheckItem(check: StrategyCheck | null, nowIso: string = new Date().toISOString()): ReviewItem | null {
  const open = check?.open;
  if (!check || !open?.reasons.length) return null;
  const lines = open.reasons.map((r) => reasonLine(r, check.since, nowIso));
  const moved = open.reasons.some((r) => r.kind !== "named");
  return {
    id: `strategy_check:${open.key}`,
    kind: "strategy_check",
    title: moved ? "Your competitors moved on your focus situations" : "Your competitors name an alternative you don't watch",
    detail: lines.length > 1 ? `${lines[0]} And ${lines.length - 1} more.` : lines[0]!,
    details: lines,
    href: `${BRAND_KIT_MAP_ROUTE}?tab=strategy`,
    action: "Review the strategy",
    dismissCheck: true,
  };
}

/**
 * The month's strategy suggestion (STRATEGY_SUGGEST_ENABLED): one row at most, while one is open,
 * and never for Working (a line on How it went only). Its lines, then what it was based on and what
 * it couldn't see. Review the strategy opens the Strategy tab; on Measure more the link is Connect or
 * Share it. Members see it; Not now is for admins.
 */
export function strategySuggestItem(s: StrategySuggestion | null | undefined): ReviewItem | null {
  if (!isReviewSuggestion(s)) return null;
  const lines = suggestionLines(s);
  const sources = sourcesLine(s);
  const action = suggestionAction(s, `${BRAND_KIT_MAP_ROUTE}?tab=strategy`);
  return {
    id: `strategy_suggest:${s.key}`,
    kind: "strategy_suggest",
    title: SUGGEST_WORDS.title,
    detail: lines.join(" "),
    details: [...lines, ...(sources ? [sources] : [])],
    href: action.href,
    action: action.label,
    notNow: { key: s.key },
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

/** Collecting has failed this many days before a connection shows in Review (the Connected view's own rule). */
export { COLLECT_FAILED_DAYS };
/** An admin's pause this many days old shows in Review. */
export const PAUSED_DAYS = 7;
const DAY_MS = 86_400_000;

/** The Connected view with this connection selected. */
export const connectedHref = (id: string) => `/admin/account/connections/connected?c=${encodeURIComponent(id)}`;
/** Settings › Organisation, where an owner fixes a connection the organisation shares. */
export const ORGANISATION_HREF = "/admin/account/organisation";

/** "19 Nov", from an instant. */
const dayOf = (iso: string) => dayWords(iso.slice(0, 10));

/**
 * A data source that needs someone (CONNECTORS_COLLECT_ENABLED, admins only): a connection its
 * provider turned down, one with no property chosen, one whose collecting has failed since 3 or
 * more days ago (collect.failedSince, as health counts calls, not days), or one an admin paused 7
 * or more days ago. Each links to the Connected view with that connection selected. A connection
 * whose connector this copy has turned off reads nothing on purpose, so it isn't listed.
 */
export function dataSourceItem(c: DataConnection, now: Date = new Date(), part?: PartReview | null): ReviewItem | null {
  if (c.status !== "connected" || !getConnector(c.connectorId)) return null;
  // A brand's part is fixed by its organisation's owners: never "sign in again" here.
  if (c.source) return partSourceItem(c, part ?? null, now);
  const full = knownConnector(c.connectorId)?.name ?? c.connectorId;
  // The product people name: "Google Analytics", "Search Console".
  const tool = productName(full);
  const name = c.label && c.label !== full && c.label !== tool ? `${tool} for ${c.label}` : tool;
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

/** A brand's part as Review reads it: what partFactsOf found, and whether this person owns its organisation. */
export interface PartReview {
  facts: PartFacts;
  /** An owner of the brand's organisation (read live), who fixes it on Settings › Organisation. */
  owner: boolean;
}

/**
 * A brand's part of its organisation's connection that needs someone (Connectors 3): its
 * organisation's sign in needing attention, or its own part that can't be read, naming the
 * organisation and who can fix it, as the approved Review screen; one failing to collect for 3
 * days, or that the brand's admins paused a week ago, as any connection. An owner gets Fix, to
 * Settings › Organisation; any other admin See it, to the part on Connected. A part that reads
 * nothing on purpose (sharing or plans off, a give not finished, no longer given) or that couldn't
 * be checked is skipped quietly, and so is one its owners paused.
 */
export function partSourceItem(c: DataConnection, part: PartReview | null, now: Date = new Date()): ReviewItem | null {
  if (!part) return null;
  const { facts } = part;
  if (facts.reads !== "live" && facts.reads !== "source" && facts.reads !== "paused") return null;
  const full = knownConnector(c.connectorId)?.name ?? c.connectorId;
  // As the approved screen names it: "Google Analytics 4", "Search Console", "Cloudflare".
  const tool = full.replace(/^Google (Search Console)$/, "$1");
  const org = facts.organisation ?? "your organisation";
  const base = { id: `data_source:${c.id}`, kind: "data_source" as const };
  const fix = part.owner ? { href: ORGANISATION_HREF, action: "Fix" } : { href: connectedHref(c.id), action: "See it" };
  const cantRead = (since: string) => ({ ...base, ...fix, title: `${tool} from ${org} can't be read since ${dayOf(since)}`, detail: `An owner of ${org} can fix it.` });
  if (facts.reads === "source") return cantRead(facts.since ?? now.toISOString());
  if (c.health.state === "broken") return cantRead(c.health.since ?? c.health.lastCheckedAt ?? now.toISOString());
  if (facts.reads === "paused") return null;
  const failedSince = c.collect?.failedSince;
  if (failedSince && now.getTime() - Date.parse(failedSince) >= COLLECT_FAILED_DAYS * DAY_MS) {
    return { ...base, href: connectedHref(c.id), title: `${tool} from ${org} needs you`, detail: `Collecting its numbers has failed since ${dayOf(failedSince)}, so the newest are missing. Press Check now on it to see why.`, action: "Fix" };
  }
  if (c.pausedAt && now.getTime() - Date.parse(c.pausedAt) >= PAUSED_DAYS * DAY_MS) {
    return { ...base, href: connectedHref(c.id), title: `${tool} from ${org} is paused`, detail: `Paused since ${dayOf(c.pausedAt)}, so no new numbers are collected. Resume it, or stop using it if you no longer need it.`, action: "Open" };
  }
  return null;
}

export interface DataSourceDeps extends Pick<SourceDeps, "controlDb" | "regionDb"> {
  db?: FirestoreLike;
  now?: Date;
}

/**
 * The brand's connected data sources that need someone: equality on status only. A brand's part is
 * checked live first (partLive, then its source's state, one cache for the read), and whether this
 * person owns the brand's organisation is read live only when a part needs someone.
 */
export async function dataSourceItems(ctx: TenantContext, deps: DataSourceDeps = {}): Promise<ReviewItem[]> {
  const now = deps.now ?? new Date();
  const connections = await forTenant(ctx, deps.db).dataConnections.find({ where: [["status", "==", "connected"]], limit: 50 });
  const facts = new Map<string, PartFacts>();
  const shared = { db: deps.db, controlDb: deps.controlDb, regionDb: deps.regionDb, partCache: new PartCache() };
  for (const c of connections) {
    if (!c.source) continue;
    const f = await partFactsOf(ctx, c, shared).catch(() => null);
    if (f) facts.set(c.id, f);
  }
  const items = (owner: boolean) =>
    connections.map((c) => dataSourceItem(c, now, c.source ? (facts.has(c.id) ? { facts: facts.get(c.id)!, owner } : null) : undefined)).filter((i): i is ReviewItem => !!i);
  const first = items(false);
  if (!first.some((i) => i.action === "See it")) return first;
  const control = deps.controlDb ?? deps.db;
  const owner = await organisationContextFor(ctx, control)
    .then((o) => o?.isOwner === true)
    .catch(() => false);
  return owner ? items(true) : first;
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

/**
 * What Vizzy heard about the business in a chat, waiting for an admin (ONBOARDING_ENABLED): one
 * item each, opening About your business. Admins only: only they keep or remove one.
 */
async function businessFactItems(ctx: TenantContext, db?: FirestoreLike): Promise<ReviewItem[]> {
  const open = await listOpenAgentActions(ctx, { action: BUSINESS_FACT_ACTION, limit: 50, db });
  return open
    .filter((a) => a.target.type === "brand" && a.target.id === ctx.tenantId)
    .map(businessFactReviewItem)
    .filter((i): i is ReviewItem => !!i);
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
/** Most articles due a refresh listed in Review. */
const MAX_REFRESH_ITEMS = 10;

/** A finished refresh review waiting for a person (BLOG_REFRESH_ENABLED): its article, and how many changes. */
export interface ReadyReview {
  planId: string;
  workspaceId: string;
  title: string;
  changes: number;
  by: "person" | "autopilot" | "vizzy";
}

/**
 * Live articles with a refresh ready to look at (BLOG_REFRESH_ENABLED) first, then those due a
 * refresh (BLOG_FRESHNESS_ENABLED), from the freshness watch: one item each, an article once.
 */
export function refreshItems(due: FreshnessDueItem[], ready: ReadyReview[] = []): ReviewItem[] {
  const readyItems = ready.slice(0, MAX_REFRESH_ITEMS).map((r) => ({
    id: `content_refresh_ready:${r.planId}`,
    kind: "content_refresh" as const,
    title: `Refresh ready: ${r.changes} change${r.changes === 1 ? "" : "s"} to look at`,
    detail: `${r.title}${r.by === "autopilot" ? " · the autopilot ran the review" : r.by === "vizzy" ? " · Vizzy ran the review" : ""}`,
    href: refreshHref({ planId: r.planId, workspaceId: r.workspaceId }),
    action: "Look at changes",
  }));
  const readyPlans = new Set(ready.map((r) => r.planId));
  return [...readyItems, ...due
    .filter((d) => d.state === "due" && !readyPlans.has(d.planId))
    .slice(0, MAX_REFRESH_ITEMS)
    .map((d) => ({
      id: `content_refresh:${d.planId}`,
      kind: "content_refresh" as const,
      title: `Due a refresh: ${d.title}`,
      detail: d.reasons.map((r) => r.detail).join(". "),
      details: d.reasons.map((r) => r.detail),
      href: refreshHref(d),
      action: "Open article",
    }))];
}

/** Reviews finished and waiting for a person, newest first, with their article's title from the watch's list or the plan. */
async function readyReviews(ctx: TenantContext, due: FreshnessDueItem[], db?: FirestoreLike): Promise<ReadyReview[]> {
  const rows = await forTenant(ctx, db).articleReviews.find({ where: [["state", "==", "ready"]], limit: MAX_REFRESH_ITEMS });
  const titles = new Map(due.map((d) => [d.planId, d.title] as const));
  return rows
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
    .map((r) => ({ planId: r.planId, workspaceId: r.workspaceId, title: titles.get(r.planId) ?? "A live article", changes: r.proposals.length, by: r.by }));
}

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
          : ready.error === "search_limit"
            ? "This month's web searches for research are used up, so autopilot found and sorted it for you to write. Open Next up to write it."
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
  opts: { lifecycle: boolean; includeContent: boolean; /** Count a due measure's check as it shows (the page; not the sidebar's count). */ workCount?: boolean },
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
  // The weekly strategy check's open row (STRATEGY_CHECK_ENABLED) and the month's suggestion
  // (STRATEGY_SUGGEST_ENABLED): one read of the strategy record for both. The check needs their
  // articles too, as the tick does, so a row left from before a change of plan doesn't stay.
  const checkOn = competitorsOn && isStrategyCheckEnabled() && (await soft("competitor articles access", brandCanUse(ctx, "competitor_articles"), false));
  const suggestOn = isStrategySuggestEnabled();
  const strategyDoc = checkOn || suggestOn ? await soft("strategy check", readBrandStrategyDoc(ctx, { db }), null as BrandStrategyDoc | null) : null;
  const strategyCheck = checkOn && strategyDoc?.approved ? strategyDoc.check : null;
  const strategySuggestion = suggestOn && strategyDoc?.approved ? strategyDoc.suggestion : null;
  // Articles due a refresh (BLOG_FRESHNESS_ENABLED): the freshness watch's list, one read.
  const dueArticles = isBlogFreshnessEnabled()
    ? await soft("articles due a refresh", readDueArticles(ctx, { db }), [] as FreshnessDueItem[])
    : [];
  // Refresh reviews done and waiting for a person (BLOG_REFRESH_ENABLED).
  const readyArticles = isBlogRefreshEnabled() ? await soft("refreshes ready", readyReviews(ctx, dueArticles, db), [] as ReadyReview[]) : [];
  // New person drafts only where this user can open the form: admins, who alone add someone
  // (decision 28), with the People list on screen. Field suggestions show to everyone, since the
  // person's page tells a member that an admin confirms.
  const people = { fields: isVizzyFieldsEnabled(), drafts: isVizzyAddPersonEnabled() && canAddPeople(ctx.role) };
  const personSuggestions = people.fields || people.drafts ? await soft("person suggestions", personSuggestionItems(ctx, people, db), [] as ReviewItem[]) : [];
  // Follow-ups from the investor or funding board: everyone on the team sees them, only admins decide one.
  const raiseFollowUps = isRaiseFollowupsEnabled()
    ? await soft(
        "board follow-ups",
        import("@/lib/raise/pipeline/followups").then((m) => m.followUpReviewItems(ctx, db)),
        [] as ReviewItem[],
      )
    : [];
  // Articles and sign-up pages in other languages waiting to be checked (PAGE_LANGUAGES_ENABLED).
  const pageTranslations = isPageLanguagesEnabled()
    ? await soft(
        "page translations",
        import("@/lib/i18n/pageReview").then((m) => m.pageTranslationReviewItems(ctx, db)),
        [] as ReviewItem[],
      )
    : [];
  // Journey emails in other languages waiting to be checked (ASSET_TRANSLATIONS_ENABLED): one row a journey.
  const translationChecks = isAssetTranslationsEnabled()
    ? await soft(
        "translations",
        import("@/lib/i18n/translationsAdmin").then((m) => m.translationReviewItems(ctx, db)),
        [] as ReviewItem[],
      )
    : [];
  // What Vizzy heard about the business in a chat: admins only, while getting to know you is on.
  const businessFacts = isOnboardingEnabled() && ctx.role === "admin" ? await soft("business facts", businessFactItems(ctx, db), [] as ReviewItem[]) : [];
  // The drafts only the agent record adds: Vizzy's styles and notes, admins only (who save them).
  const recordItems = isAgentRecordEnabled() && ctx.role === "admin" ? await soft("agent record", agentRecordItems(ctx, db), [] as ReviewItem[]) : [];
  // Lists pasted on People, waiting for an admin to add them: admins only, who alone add people.
  const pastedLists = canPaste(ctx.role) ? await soft("pasted lists", pasteBatchItems(ctx, db), [] as ReviewItem[]) : [];
  // Data sources that need someone: admins only, while collected numbers are on.
  const dataSources = isConnectorsCollectEnabled() && ctx.role === "admin" ? await soft("data sources", dataSourceItems(ctx, { db }), [] as ReviewItem[]) : [];
  // What collected numbers suggest: admins only, while signals are on, from planning connections.
  const numberSuggestions = isConnectorSignalsEnabled() && ctx.role === "admin" ? await soft("number suggestions", signalReviewItems(ctx, { db }), [] as ReviewItem[]) : [];
  // Work (WORK_ENABLED): checks due, tasks ready to start and Vizzy's task suggestions, for members
  // too, as Work's view shows them. One fake database stands for every database in tests.
  const work = isWorkEnabled()
    ? await soft("work", workReviewItems(ctx, { ...(db ? { controlDb: db, regionDb: () => db } : {}), count: opts.workCount !== false }), [] as ReviewItem[])
    : [];
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
    ...work,
    ...raiseFollowUps,
    ...translationChecks,
    ...pageTranslations,
    ...businessFacts,
    ...pastedLists,
    ...liveConnections.map((c, i) => repoResultsItem(c, latestRuns[i]?.[0])),
    brandMapItem(brandMap, brandMapProposals),
    ...competitorItems(competitors, competitorNews),
    strategyCheckItem(strategyCheck),
    strategySuggestItem(strategySuggestion),
    ...nextArticleItems(autopilotRuns),
    ...numberSuggestions,
    ...refreshItems(dueArticles, readyArticles),
    ...(opts.includeContent ? await loadContentHubItems(ctx, activeWorkspaces) : []),
    ...recordItems,
  ].filter((i): i is ReviewItem => !!i);

  return { aiLines, items };
}

// The sidebar polls the count every minute; one read of every source per tenant
// per two minutes is plenty (the Review page itself always reads fresh).
const COUNT_TTL_MS = 2 * 60 * 1000;
const countCache = new Map<string, { at: number; total: number }>();

/**
 * The count's cache key: per brand, per role (some items are for admins only) and, while Work is
 * on, whether the person owns the brand's organisation, since owners count the whole
 * organisation's Work and everyone else in a multi brand organisation only their brand's.
 */
export function countKey(tenantId: string, role: TenantContext["role"], owner?: boolean): string {
  return `${tenantId}|${role === "admin" ? "admin" : "member"}${owner === undefined ? "" : owner ? "|owner" : "|not_owner"}`;
}

/** Whether the person owns the brand's organisation, read live: undefined while Work is off, "unread" when it can't be read. */
async function ownerFlag(ctx: TenantContext, db?: FirestoreLike): Promise<boolean | undefined | "unread"> {
  if (!isWorkEnabled()) return undefined;
  try {
    const o = await organisationContextFor(ctx, db);
    return o?.isOwner === true;
  } catch {
    return "unread";
  }
}

export async function countReview(
  ctx: TenantContext,
  opts: { lifecycle: boolean; now?: number },
  db?: FirestoreLike,
): Promise<number> {
  const now = opts.now ?? Date.now();
  const owner = await ownerFlag(ctx, db);
  // Who the person is couldn't be read: count fresh, and keep it for no one else.
  const key = owner === "unread" ? null : countKey(ctx.tenantId, ctx.role, owner);
  const hit = key ? countCache.get(key) : undefined;
  if (hit && now - hit.at < COUNT_TTL_MS) return hit.total;
  const review = await loadReview(ctx, { lifecycle: opts.lifecycle, includeContent: !db, workCount: false }, db);
  const total = review.aiLines + review.items.length;
  if (key) countCache.set(key, { at: now, total });
  return total;
}

/** Forget one brand's cached counts, every role and owner flag, after something that changes them (a change marked seen). */
export function forgetReviewCount(tenantId: string): void {
  for (const key of [...countCache.keys()]) if (key.startsWith(`${tenantId}|`)) countCache.delete(key);
}

/** Test hook: forget cached counts. */
export function resetReviewCountCache(): void {
  countCache.clear();
}
