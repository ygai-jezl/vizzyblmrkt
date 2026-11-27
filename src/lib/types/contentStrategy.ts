import { z } from "zod";
import { isHttpsUrl } from "./brandMap";
import { QuestionId, SubjectId } from "./brandMapRecords";

/**
 * The content strategy (CONTENT_STRATEGY_ENABLED): one record per brand,
 * `content_strategy/cst_<tenantId>` in the brand's region, approved by a person. It turns the
 * brand map and the approved brand strategy into a plan for the quarter:
 *
 *  1. slots: the brand map's decided questions merged by meaning into the articles they belong
 *     in, each with a stage of the buying journey, a kind of page and the live articles that
 *     already answer it;
 *  2. pillars: 3 to 6, each with a hub (a subject's home page, or a hub slot to write first);
 *  3. scores for each slot, worked out in code, each part kept so the reason can be shown;
 *  4. a 12 week roadmap: what to write, refresh or combine each week;
 *  5. the rules it was made with (3 of 4 Next up picks from the roadmap, the funnel mix).
 *
 * The record keeps the draft a person checks, the approved plan Next up and Vizzy read, short
 * summaries of the last 5 approved, and what people decided (slots split or joined, picks kept,
 * skipped or moved, pillars renamed), newest first, for the learning loops. Question ids and page
 * ids only, never their texts, so the record stays small. Pure and client safe.
 *
 * Rules for changing this file: additive only. A list is read one item at a time, so an item a
 * later build wrote that this one can't read is left out, never the whole plan.
 */

export const CONTENT_STRATEGY_LIMITS = {
  slots: 400,
  questionsPerSlot: 8,
  slotTitle: 120,
  /** Live articles kept on a slot: two are enough to say it should be combined. */
  coveredBy: 3,
  pillarsMin: 3,
  pillars: 6,
  pillarName: 80,
  pillarAbout: 160,
  weeks: 12,
  /** 12 weeks at the autopilot's most articles a week (10). */
  roadmap: 120,
  history: 5,
  decisions: 200,
  decisionText: 200,
  sources: 16,
  /** A save that would make the record bigger than this is refused (Firestore's limit is 1 MiB). */
  bytes: 500_000,
} as const;

const L = CONTENT_STRATEGY_LIMITS;
const isOneLine = (s: string) => !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(s);
const Line = (max: number) => z.string().trim().min(1).max(max).refine(isOneLine, "must be one line of text");
const OptionalLine = (max: number) => z.string().trim().max(max).refine(isOneLine, "must be one line of text");
const Stamp = z.string().max(40);
const Score = z.number().int().min(0).max(100).catch(0).default(0);
/** A list read one item at a time: an item that no longer parses is left out, never the whole list. */
const tolerantArray = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((rows) =>
      rows
        .flatMap((row) => {
          const parsed = item.safeParse(row);
          return parsed.success ? [parsed.data as z.output<T>] : [];
        })
        .slice(0, max),
    );

export const SlotId = z.string().regex(/^slt_[a-z0-9]{6,24}$/);
export const PillarId = z.string().regex(/^pil_[a-z0-9]{6,24}$/);
/** An ISO week: "2026-W49". */
export const IsoWeek = z.string().regex(/^\d{4}-W\d{2}$/);
/** A brand map page: an article written here (`p_<planId>`) or a page on the brand's site (`s_<hash>`). */
const PageId = z.string().min(1).max(200);

// ----- Stages and kinds of page ----------------------------------------------------------------

/** Where in the buying journey a slot's questions sit. */
export const CONTENT_STAGES = ["learn", "consider", "choose"] as const;
export const ContentStage = z.enum(CONTENT_STAGES);
export type ContentStage = z.infer<typeof ContentStage>;

export const STAGE_LABEL: Record<ContentStage, string> = { learn: "learn", consider: "consider", choose: "choose" };

/**
 * The kind of page a slot needs: a guide, a list ("best X"), a comparison, a tool page (a free
 * checker), a video, news, or a refresh or combine of a live one. Tool pages and videos aren't
 * articles: they are listed and done by hand for now.
 */
export const PAGE_KINDS = ["guide", "list", "comparison", "tool", "video", "news", "refresh", "combine"] as const;
export const PageKind = z.enum(PAGE_KINDS);
export type PageKind = z.infer<typeof PageKind>;

export const PAGE_KIND_LABEL: Record<PageKind, string> = {
  guide: "guide",
  list: "list",
  comparison: "comparison",
  tool: "tool page",
  video: "video",
  news: "news",
  refresh: "refresh",
  combine: "combine",
};

/** Kinds that aren't articles: done by hand for now. */
export const NOT_ARTICLE_KINDS: ReadonlySet<PageKind> = new Set<PageKind>(["tool", "video"]);

// ----- Slots -----------------------------------------------------------------------------------

/** Each part of a slot's score, 0 to 100, worked out in code. */
export const SlotScoresSchema = z.object({
  /** Its questions sit on the brand strategy's focus situations. */
  fit: Score,
  /** Search Console impressions for its questions, or what Google shows for it. */
  demand: Score,
  /** Competitors write on it, and nothing live of the brand's answers it. */
  gap: Score,
  /** It fills a pillar the brand has already started. */
  depth: Score,
  /** Its stage is short against the funnel mix. */
  balance: Score,
  total: Score,
});
export type SlotScores = z.infer<typeof SlotScoresSchema>;

/** What the scores stand on, kept so the reason can be shown. */
export const SlotFactsSchema = z.object({
  /** Of its questions, how many sit on a focus situation. */
  focus: z.number().int().min(0).catch(0).default(0),
  /** Search Console impressions for its questions, when connected and shared. */
  impressions: z.number().int().min(0).nullable().catch(null).default(null),
  /** People also ask questions Google showed for its first question, when looked up. */
  paa: z.number().int().min(0).nullable().catch(null).default(null),
  /** Competitor articles in the last 90 days on its subjects or a topic like it. */
  theirs: z.number().int().min(0).catch(0).default(0),
  /** Google's check of its top questions: they share 3 or more of the top 10 results (same), or were split for sharing fewer. */
  serp: z.enum(["same", "split"]).nullable().catch(null).default(null),
});
export type SlotFacts = z.infer<typeof SlotFactsSchema>;

export const ContentSlotSchema = z.object({
  id: SlotId,
  /** What the article is called in the plan: its first question, or a name Vizzy gave the merged questions. */
  title: Line(L.slotTitle),
  /** The decided map questions it answers, the first one first. */
  questionIds: z.array(QuestionId).min(1).max(L.questionsPerSlot),
  /** The subjects those questions are on, for its pillar and its competitor flag. */
  subjectIds: z.array(SubjectId).max(L.questionsPerSlot).catch([]).default([]),
  stage: ContentStage.catch("learn").default("learn"),
  kind: PageKind.catch("guide").default("guide"),
  pillarId: PillarId.nullable().catch(null).default(null),
  /** The live articles that answer it (page ids), first the furthest along; none: nothing live covers it. */
  coveredBy: z.array(PageId).max(L.coveredBy).catch([]).default([]),
  /** An article for it is planned or being written. */
  inProgress: z.boolean().catch(false).default(false),
  /** The hub of its pillar: written first. */
  hub: z.boolean().catch(false).default(false),
  scores: SlotScoresSchema.prefault({}),
  facts: SlotFactsSchema.prefault({}),
  /** Made by the plan, or by a person splitting or joining slots. */
  from: z.enum(["plan", "person"]).catch("plan").default("plan"),
});
export type ContentSlot = z.infer<typeof ContentSlotSchema>;

// ----- Pillars ---------------------------------------------------------------------------------

/** A pillar's hub: a subject's home page on the brand's site, or a slot to write first. */
export const PillarHubSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("home"), url: z.string().trim().max(300).refine(isHttpsUrl, "must be an https address"), subjectId: SubjectId.nullable().catch(null).default(null) }),
  z.object({ kind: z.literal("slot"), slotId: SlotId }),
]);
export type PillarHub = z.infer<typeof PillarHubSchema>;

export const ContentPillarSchema = z.object({
  id: PillarId,
  name: Line(L.pillarName),
  about: OptionalLine(L.pillarAbout).catch("").default(""),
  /** From the brand map's groups, named by Vizzy, from its biggest subjects, or renamed by a person. */
  from: z.enum(["groups", "vizzy", "subjects", "person"]).catch("vizzy").default("vizzy"),
  /** The brand map group it is, when it came from the groups. */
  groupId: z.string().max(64).nullable().catch(null).default(null),
  hub: PillarHubSchema.nullable().catch(null).default(null),
});
export type ContentPillar = z.infer<typeof ContentPillarSchema>;

// ----- The roadmap -----------------------------------------------------------------------------

export const ROADMAP_ACTIONS = ["write", "refresh", "combine"] as const;
export const RoadmapAction = z.enum(ROADMAP_ACTIONS);
export type RoadmapAction = z.infer<typeof RoadmapAction>;

export const RoadmapEntrySchema = z.object({
  week: IsoWeek,
  slotId: SlotId,
  action: RoadmapAction,
});
export type RoadmapEntry = z.infer<typeof RoadmapEntrySchema>;

/** The focus pillars of one four week block of the roadmap, named by the month it starts in. */
export const FocusBlockSchema = z.object({
  /** "2026-12". */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  weeks: z.array(IsoWeek).max(4).catch([]).default([]),
  pillarIds: z.array(PillarId).max(2).catch([]).default([]),
});
export type FocusBlock = z.infer<typeof FocusBlockSchema>;

// ----- The rules -------------------------------------------------------------------------------

export const FunnelSchema = z.object({
  learn: z.number().int().min(0).max(100),
  consider: z.number().int().min(0).max(100),
  choose: z.number().int().min(0).max(100),
});
export type Funnel = z.infer<typeof FunnelSchema>;

/** The default funnel mix: half to learn, almost a third to consider, a fifth to choose. */
export const DEFAULT_FUNNEL: Funnel = { learn: 50, consider: 30, choose: 20 };
/** 3 of 4 Next up picks come from the roadmap; 1 is free for new questions and news (decision 5). */
export const ROADMAP_SHARE = 0.75;

export const PlanRulesSchema = z.object({
  /** The share of Next up's picks that come from the roadmap. */
  roadmapShare: z.number().min(0).max(1).catch(ROADMAP_SHARE).default(ROADMAP_SHARE),
  funnel: FunnelSchema.catch(DEFAULT_FUNNEL).default(DEFAULT_FUNNEL),
  /** Roadmap entries a week: the autopilot's articles a week. */
  perWeek: z.number().int().min(1).max(10).catch(1).default(1),
  /** The share of roadmap entries that refresh or combine a live article. */
  refreshShare: z.number().min(0).max(1).catch(0).default(0),
  /** One article per slot, the hub first (decision 4). Always true today; kept so a plan says what it followed. */
  oneArticlePerSlot: z.boolean().catch(true).default(true),
  hubFirst: z.boolean().catch(true).default(true),
});
export type PlanRules = z.infer<typeof PlanRulesSchema>;

// ----- The plan --------------------------------------------------------------------------------

/** The kinds of data a plan was made from, by kind, never by vendor. */
export const PLAN_SOURCES = [
  "brand_map",
  "groups",
  "brand_strategy",
  "coverage",
  "meaning",
  "search_demand",
  "google_results",
  "competitors",
  "freshness",
  "repeats",
  "autopilot",
] as const;
export const PlanSource = z.enum(PLAN_SOURCES);
export type PlanSource = z.infer<typeof PlanSource>;

export const PLAN_SOURCE_LABEL: Record<PlanSource, string> = {
  brand_map: "Your brand map's questions",
  groups: "Your brand map's groups",
  brand_strategy: "Your approved strategy",
  coverage: "Your articles",
  meaning: "Questions matched by meaning",
  search_demand: "Search Console",
  google_results: "Google's results",
  competitors: "Competitor articles",
  freshness: "Articles due a refresh",
  repeats: "Live articles that repeat each other",
  autopilot: "Your autopilot's articles a week",
};

export const PlanMadeSchema = z.object({
  promptId: z.string().max(80),
  version: z.number().int().min(0),
  model: z.string().max(80),
});
export type PlanMade = z.infer<typeof PlanMadeSchema>;

/** How the brand's decided questions split across the stages when the plan was made, as percentages. */
export const StageMixSchema = z.object({
  learn: z.number().int().min(0).max(100).catch(0).default(0),
  consider: z.number().int().min(0).max(100).catch(0).default(0),
  choose: z.number().int().min(0).max(100).catch(0).default(0),
});
export type StageMix = z.infer<typeof StageMixSchema>;

export const ContentPlanSchema = z.object({
  slots: tolerantArray(ContentSlotSchema, L.slots),
  pillars: tolerantArray(ContentPillarSchema, L.pillars),
  roadmap: tolerantArray(RoadmapEntrySchema, L.roadmap),
  blocks: tolerantArray(FocusBlockSchema, 3),
  rules: PlanRulesSchema.prefault({}),
  /** The decided questions it read, and how they split across the stages. */
  questions: z.number().int().min(0).catch(0).default(0),
  stageMix: StageMixSchema.prefault({}),
  /** Slots left out past the limit (the least focused and smallest go first). */
  leftOut: z.number().int().min(0).catch(0).default(0),
  sources: tolerantArray(PlanSource, L.sources),
  /** What named the pillars, when a model did; null when they came from the brand map's groups or subjects. */
  made: PlanMadeSchema.nullable().catch(null).default(null),
  /** The draft: when it last changed. The approved one: when it was approved. */
  at: Stamp,
  by: z.string().max(254).nullable().catch(null).default(null),
});
export type ContentPlan = z.infer<typeof ContentPlanSchema>;

/** What history keeps of an approved plan: enough to trace a pick back to the plan that made it. */
export const PlanSummarySchema = z.object({
  at: Stamp,
  by: z.string().max(254).nullable().catch(null).default(null),
  made: PlanMadeSchema.nullable().catch(null).default(null),
  rules: PlanRulesSchema.prefault({}),
  pillars: tolerantArray(z.object({ id: PillarId, name: Line(L.pillarName) }), L.pillars),
  /** Each roadmap entry with its slot's first question, since slot ids are made again with each plan. */
  roadmap: tolerantArray(RoadmapEntrySchema.extend({ questionId: QuestionId.nullable().catch(null).default(null) }), L.roadmap),
  slots: z.number().int().min(0).catch(0).default(0),
});
export type PlanSummary = z.infer<typeof PlanSummarySchema>;

// ----- Decisions -------------------------------------------------------------------------------

/** What a person decided, kept as signals for the learning loops (only skipped picks are read back today). */
export const PLAN_DECISION_KINDS = ["slot_split", "slot_joined", "pick_kept", "pick_skipped", "pick_moved", "pillar_renamed", "approved"] as const;
export const PlanDecisionKind = z.enum(PLAN_DECISION_KINDS);
export type PlanDecisionKind = z.infer<typeof PlanDecisionKind>;

export const PlanDecisionSchema = z.object({
  kind: PlanDecisionKind,
  /** What it was about: a slot, pillar or question id. */
  ref: OptionalLine(L.decisionText).catch("").default(""),
  before: OptionalLine(L.decisionText).nullable().catch(null).default(null),
  after: OptionalLine(L.decisionText).nullable().catch(null).default(null),
  at: Stamp,
  by: z.string().max(254).nullable().catch(null).default(null),
});
export type PlanDecision = z.infer<typeof PlanDecisionSchema>;

// ----- The record ------------------------------------------------------------------------------

export const ContentStrategyDocSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** Moves on every change, so a person saving over someone else's is refused. */
  rev: z.number().int().min(0).catch(0).default(0),
  /** The plan a person checks. Null once approved, until it is made again or edited. */
  draft: ContentPlanSchema.nullable().catch(null).default(null),
  approved: ContentPlanSchema.nullable().catch(null).default(null),
  /** The approved plans before the current one, newest first, in short. */
  history: tolerantArray(PlanSummarySchema, L.history),
  decisions: tolerantArray(PlanDecisionSchema, L.decisions),
  createdAt: Stamp.catch("").default(""),
  updatedAt: Stamp.catch("").default(""),
});
export type ContentStrategyDoc = z.infer<typeof ContentStrategyDocSchema>;

/** The raw stored document, as the tenant layer hands it over (parsed by contentStrategy/store.ts). */
export type ContentStrategyRecord = { id: string; tenantId: string } & Record<string, unknown>;

export function contentStrategyDocId(tenantId: string): string {
  return `cst_${encodeURIComponent(tenantId)}`;
}

/** The slot a pick of Next up came from (CONTENT_STRATEGY_NEXT_UP_ENABLED). */
export interface PickSlot {
  id: string;
  title: string;
  pillar: string | null;
  kind: PageKind;
  stage: ContentStage;
  action: RoadmapAction;
  week: string;
}

// ----- What a person sends ---------------------------------------------------------------------

/** A person's change to the draft (admins): one at a time, naming the revision they started from. */
export const PlanEditSchema = z.discriminatedUnion("op", [
  /** Take one question out of a slot into a slot of its own. */
  z.object({ op: z.literal("split"), baseRev: z.number().int().min(0), slotId: SlotId, questionId: QuestionId }).strict(),
  /** Merge the second slot into the first. */
  z.object({ op: z.literal("join"), baseRev: z.number().int().min(0), slotId: SlotId, intoSlotId: SlotId }).strict(),
  z.object({ op: z.literal("rename_pillar"), baseRev: z.number().int().min(0), pillarId: PillarId, name: Line(L.pillarName) }).strict(),
  /** Take a roadmap entry off, with why when they said. */
  z.object({ op: z.literal("skip"), baseRev: z.number().int().min(0), slotId: SlotId, reason: OptionalLine(L.decisionText).default("") }).strict(),
  /** Move a roadmap entry to another week of the plan. */
  z.object({ op: z.literal("move"), baseRev: z.number().int().min(0), slotId: SlotId, week: IsoWeek }).strict(),
]);
export type PlanEdit = z.infer<typeof PlanEditSchema>;
