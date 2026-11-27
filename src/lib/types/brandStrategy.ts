import { z } from "zod";
import { isHttpsUrl } from "./brandMap";
import { SituationId } from "./brandMapRecords";
import { OUTCOME_KINDS } from "@/lib/metrics/outcomes";

/**
 * The brand strategy (BRAND_STRATEGY_ENABLED): one record per brand, `brand_strategy/bst_<tenantId>`
 * in the brand's region, approved by a person. Five parts, each backed by evidence:
 *
 *  1. who it's for: the brand map's audiences and 3 to 5 focus buying situations;
 *  2. who you compete with: competitors in groups, found by the competitor finder or watched;
 *  3. where you win, and where they do: claims, each with its proof (a page on the brand's site, a
 *     product fact shown on a public page or doc, or a competitor's page), or none: a gap to close;
 *  4. what you're not: proposals a person accepts into the brand map's identity;
 *  5. the quarter's goal: one line and how we'll know.
 *
 * The record keeps the draft a person edits, the approved strategy everything reads, the last 5
 * approved, and the decisions people made (stars, ticks, edits), newest first, for the learning
 * loops. Pure and client safe.
 *
 * Rules for changing this file: additive only. A list is read one item at a time, so an item a
 * later build wrote that this one can't read is left out, never the whole strategy.
 */

export const BRAND_STRATEGY_LIMITS = {
  focusMin: 3,
  focusMax: 5,
  audiences: 8,
  audienceText: 80,
  /** Competitors the finder adds to one group. */
  competitorsPerGroup: 8,
  /**
   * The most one group holds: the finder's 8, plus every competitor a person ticked or added and
   * every one the brand watches (10 at most), which are never pushed out by new finds.
   */
  keptPerGroup: 20,
  competitorName: 80,
  evidence: 3,
  evidenceTitle: 160,
  claims: 10,
  claimText: 160,
  isNot: 5,
  isNotText: 80,
  why: 160,
  goalText: 160,
  measureText: 80,
  /** Approved strategies kept before the current one. */
  history: 5,
  /** Decisions kept, newest first. */
  decisions: 200,
  decisionText: 200,
  /** Full finder runs remembered (for the monthly count). */
  finderRuns: 24,
  /** Names a person marked Not a competitor, newest first: the finder never suggests them again. */
  notCompetitors: 50,
  /** The finder's suggestions a person pressed Monitor on, newest first: once no longer watched, they don't come back as suggestions. */
  monitoredFinds: 50,
} as const;

const L = BRAND_STRATEGY_LIMITS;
const isOneLine = (s: string) => !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(s);
const Line = (max: number) => z.string().trim().min(1).max(max).refine(isOneLine, "must be one line of text");
const OptionalLine = (max: number) => z.string().trim().max(max).refine(isOneLine, "must be one line of text");
const Url = z.string().trim().max(300).refine(isHttpsUrl, "must be an https address");
const Stamp = z.string().max(40);
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

// ----- Who you compete with ------------------------------------------------------------------

/** The groups competitors fall into, in the order the tab shows them. */
export const COMPETITOR_GROUP_KINDS = ["most", "big", "open_source", "one_job", "instead"] as const;
export const CompetitorGroupKind = z.enum(COMPETITOR_GROUP_KINDS);
export type CompetitorGroupKind = z.infer<typeof CompetitorGroupKind>;

export const COMPETITOR_GROUP_LABEL: Record<CompetitorGroupKind, string> = {
  most: "Does most of what you do",
  big: "The big names",
  open_source: "Open source",
  one_job: "Does one part of what you do",
  instead: "What buyers do instead",
};

/** A web page a Google search returned that names a competitor: its title and domain only. */
export const StrategyEvidenceSchema = z.object({
  title: OptionalLine(L.evidenceTitle).catch("").default(""),
  domain: z.string().trim().min(1).max(253),
});
export type StrategyEvidence = z.infer<typeof StrategyEvidenceSchema>;

export const StrategyCompetitorSchema = z.object({
  name: Line(L.competitorName),
  /** Their site's domain, only when a search result came from it; null when none did (or for a way of working, such as a spreadsheet). */
  site: z.string().trim().max(253).nullable().catch(null).default(null),
  /** How many of the finder's answers named them (a full run asks three times); 0 for one the gap search or a person added. */
  foundTimes: z.number().int().min(0).max(10).catch(0).default(0),
  evidence: tolerantArray(StrategyEvidenceSchema, L.evidence),
  /** A person ticked them to monitor (Brand › Competitors watches them). */
  ticked: z.boolean().catch(false).default(false),
  /** The finder found them, the brand already watched them, or a person added them. */
  from: z.enum(["finder", "watched", "person"]).catch("finder").default("finder"),
});
export type StrategyCompetitor = z.infer<typeof StrategyCompetitorSchema>;

export const StrategyCompetitorGroupSchema = z.object({
  kind: CompetitorGroupKind,
  competitors: tolerantArray(StrategyCompetitorSchema, L.keptPerGroup),
});
export type StrategyCompetitorGroup = z.infer<typeof StrategyCompetitorGroupSchema>;

/** A name the finder found that a person marked Not a competitor (STRATEGY_COMPETITORS_ENABLED). */
export const NotCompetitorSchema = z.object({
  name: Line(L.competitorName),
  site: z.string().trim().max(253).nullable().catch(null).default(null),
});
export type NotCompetitor = z.infer<typeof NotCompetitorSchema>;

/** The words for a watched competitor nobody has put in a group yet. */
export const NOT_GROUPED_LABEL = "Not grouped yet";

// ----- Where you win, and where they do -------------------------------------------------------

/**
 * What a claim stands on: a page on the brand's own site (`site`), a fact about its product shown
 * on a public page or doc (`product`: never code), or a competitor's own page (`competitor`).
 */
export const ProofKind = z.enum(["site", "product", "competitor"]);
export type ProofKind = z.infer<typeof ProofKind>;

export const StrategyProofSchema = z.object({
  kind: ProofKind,
  url: Url,
  title: OptionalLine(L.evidenceTitle).catch("").default(""),
});
export type StrategyProof = z.infer<typeof StrategyProofSchema>;

export const ClaimId = z.string().regex(/^cl_[a-z0-9]{6,24}$/);

export const StrategyClaimSchema = z.object({
  id: ClaimId,
  /** Where the brand wins (`you`), or where a competitor does (`them`). */
  side: z.enum(["you", "them"]).catch("you").default("you"),
  text: Line(L.claimText),
  /** The competitor a `them` claim is about. */
  competitor: OptionalLine(L.competitorName).nullable().catch(null).default(null),
  /** Null: no proof yet. Shown as a gap to close, never as fact. */
  proof: StrategyProofSchema.nullable().catch(null).default(null),
  /** The words as proposed, kept when a person edits them; null for one a person wrote. */
  proposed: OptionalLine(L.claimText).nullable().catch(null).default(null),
});
export type StrategyClaim = z.infer<typeof StrategyClaimSchema>;

/** What a claim shows as: its proof's kind, or a gap. */
export type ClaimShown = "site" | "docs" | "them" | "gap";
export function claimShown(c: Pick<StrategyClaim, "proof">): ClaimShown {
  if (!c.proof) return "gap";
  return c.proof.kind === "product" ? "docs" : c.proof.kind === "competitor" ? "them" : "site";
}

// ----- What you say, and what you're not -------------------------------------------------------

export const IsNotProposalSchema = z.object({
  text: Line(L.isNotText),
  why: OptionalLine(L.why).catch("").default(""),
  /** The competitor it sets the brand apart from, when it names one. */
  competitor: OptionalLine(L.competitorName).nullable().catch(null).default(null),
  /** Accepted: added to the brand map's identity. Declined: not proposed again. */
  state: z.enum(["proposed", "accepted", "declined"]).catch("proposed").default("proposed"),
});
export type IsNotProposal = z.infer<typeof IsNotProposalSchema>;

// ----- The quarter's goal --------------------------------------------------------------------

export const StrategyGoalSchema = z.object({
  text: Line(L.goalText),
  /** How we'll know, in plain words ("sign-ups", "Search Console clicks"). */
  measure: OptionalLine(L.measureText).catch("").default(""),
  /** The number's meaning, when the measure is one YouGrow knows (a key of src/lib/metrics/meanings.ts). */
  measureKey: z.string().max(60).nullable().catch(null).default(null),
  /** Started from the brand's profile (onboarding), proposed by Vizzy, or set by a person. */
  from: z.enum(["onboarding", "vizzy", "person"]).catch("person").default("person"),
  setAt: Stamp.catch("").default(""),
});
export type StrategyGoal = z.infer<typeof StrategyGoalSchema>;

// ----- The strategy ----------------------------------------------------------------------------

/** The kinds of data a strategy was made from, by kind, never by vendor. */
export const STRATEGY_SOURCES = [
  "identity",
  "situations",
  "coverage",
  "competitors",
  "competitor_articles",
  "finder",
  "site_pages",
  "knowledge",
  "product_map",
  "profile",
  "goal_facts",
] as const;
export const StrategySource = z.enum(STRATEGY_SOURCES);
export type StrategySource = z.infer<typeof StrategySource>;

export const STRATEGY_SOURCE_LABEL: Record<StrategySource, string> = {
  identity: "Who you are",
  situations: "Buying situations",
  coverage: "Questions and live articles",
  competitors: "Competitors you watch",
  competitor_articles: "What your competitors write",
  finder: "The competitor finder",
  site_pages: "Your site's pages",
  knowledge: "Your knowledge",
  product_map: "What your product does",
  profile: "About your business",
  goal_facts: "Goals you told Vizzy",
};

/** What made a proposal: the prompt and its version, and the model. */
export const StrategyMadeSchema = z.object({
  promptId: z.string().max(80),
  version: z.number().int().min(0),
  model: z.string().max(80),
});
export type StrategyMade = z.infer<typeof StrategyMadeSchema>;

export const StrategySchema = z.object({
  focusSituationIds: z.array(SituationId).max(L.focusMax).catch([]).default([]),
  /** The focus situations Vizzy proposed last, so a star kept or removed can be told apart. */
  proposedFocusIds: z.array(SituationId).max(L.focusMax).catch([]).default([]),
  audiences: z.array(Line(L.audienceText)).max(L.audiences).catch([]).default([]),
  competitorGroups: tolerantArray(StrategyCompetitorGroupSchema, COMPETITOR_GROUP_KINDS.length),
  /**
   * Watched competitors nobody had put in a group, as approved (STRATEGY_COMPETITORS_ENABLED): the
   * approved copy keeps the whole list. Always empty in a draft, and while it is off.
   */
  ungrouped: tolerantArray(StrategyCompetitorSchema, L.keptPerGroup),
  /**
   * An approved copy made while the strategy was joined to Competitors: its competitor lists are
   * the live list as it was then, so they are never compared with the draft's, whatever the switch
   * says now. False on every draft. Records stored before these fields read with it false, with
   * `ungrouped: []` and `finder.notCompetitors: []`: those defaults are right, nothing needs moving.
   */
  competitorsLive: z.boolean().catch(false).default(false),
  claims: tolerantArray(StrategyClaimSchema, L.claims),
  isNotProposals: tolerantArray(IsNotProposalSchema, L.isNot),
  goal: StrategyGoalSchema.nullable().catch(null).default(null),
  sources: tolerantArray(StrategySource, STRATEGY_SOURCES.length),
  made: StrategyMadeSchema.nullable().catch(null).default(null),
  /** The draft: when it last changed. The approved one: when it was approved. */
  at: Stamp,
  by: z.string().max(254).nullable().catch(null).default(null),
});
export type Strategy = z.infer<typeof StrategySchema>;

// ----- Decisions -------------------------------------------------------------------------------

/** What a person decided, kept as signals for the learning loops (nothing learns from them yet). */
export const STRATEGY_DECISION_KINDS = [
  "star_added",
  "star_removed",
  "star_kept",
  "competitor_ticked",
  "competitor_unticked",
  "competitor_left_out",
  /** A person put a watched competitor in a group, or took it out of one (before and after). */
  "competitor_grouped",
  "claim_added",
  "claim_edited",
  "claim_removed",
  "is_not_accepted",
  "is_not_declined",
  "goal_set",
  "approved",
  /** A Propose with Vizzy made while the weekly check had a row open (STRATEGY_CHECK_ENABLED). */
  "check_acted",
  /** An admin dismissed the weekly check's row: it stays quiet 30 days. */
  "check_dismissed",
] as const;
export const StrategyDecisionKind = z.enum(STRATEGY_DECISION_KINDS);
export type StrategyDecisionKind = z.infer<typeof StrategyDecisionKind>;

export const StrategyDecisionSchema = z.object({
  kind: StrategyDecisionKind,
  /** What it was about: a situation or claim id, a competitor's name, a line. */
  ref: OptionalLine(L.decisionText).catch("").default(""),
  before: OptionalLine(L.decisionText).nullable().catch(null).default(null),
  after: OptionalLine(L.decisionText).nullable().catch(null).default(null),
  at: Stamp,
  by: z.string().max(254).nullable().catch(null).default(null),
});
export type StrategyDecision = z.infer<typeof StrategyDecisionSchema>;

// ----- The weekly check (STRATEGY_CHECK_ENABLED) -----------------------------------------------

export const STRATEGY_CHECK_LIMITS = {
  /** A look a week. */
  everyDays: 7,
  /** Dismiss keeps the row away this long. */
  dismissDays: 30,
  /** New articles of theirs on one focus situation that make a row. */
  newArticles: 3,
  /** Their articles naming one alternative on the brand map the brand doesn't watch that make a row. */
  namedArticles: 3,
  focus: 5,
  named: 5,
  reasons: 8,
  /** Alternatives already raised once, newest first: not raised again. */
  raisedNames: 20,
  /** Competitors named beside a count. */
  by: 3,
  text: 120,
} as const;

const C = STRATEGY_CHECK_LIMITS;
const Count = z.number().int().min(0).max(100_000);
const CoverageFlagSchema = z.enum(["gap", "open", "crowded", "you_lead", "even"]);
const ByCompetitorSchema = z.object({ name: Line(L.competitorName), count: Count });

/** One focus situation as the check last saw it: their articles in 90 days, the new ones, and the brand's answers. */
export const CheckFocusSchema = z.object({
  id: SituationId,
  text: Line(C.text),
  they: Count,
  /** Their articles on it published since the check's `since` (by publish date only). */
  newSince: Count,
  by: tolerantArray(ByCompetitorSchema, C.by),
  questions: Count,
  answered: Count,
  flag: CoverageFlagSchema,
});
export type CheckFocus = z.infer<typeof CheckFocusSchema>;

/**
 * Why the check asks for a look: new articles of theirs on a focus situation, a focus situation
 * newly a gap (they write on it and no live article of the brand's answers it), or an alternative on
 * the brand map they keep naming that the brand doesn't watch. `ref` is the situation's id or the name.
 */
export const CheckReasonSchema = z.object({
  kind: z.enum(["new_articles", "new_gap", "named"]),
  ref: Line(L.competitorName + 40),
  text: Line(C.text),
  count: Count,
  by: tolerantArray(ByCompetitorSchema, C.by),
});
export type CheckReason = z.infer<typeof CheckReasonSchema>;

/**
 * The weekly check on the approved strategy, kept on the record (under 4 KB) and written without
 * moving `rev`. At most one row is open. Approving starts it again; Dismiss keeps it quiet 30 days.
 */
export const StrategyCheckSchema = z.object({
  lookedAt: Stamp.nullable().catch(null).default(null),
  /** When it looks next; null: at the next check tick. */
  nextAt: Stamp.nullable().catch(null).default(null),
  /** The day new articles count from: the day after the later of approval, a dismissal, or a row that closed itself. */
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The focus situations that were a gap when a row last could be raised; null until the first look. */
  gapIds: z.array(SituationId).max(C.focus).nullable().catch(null).default(null),
  raisedNames: z.array(Line(L.competitorName)).max(C.raisedNames).catch([]).default([]),
  focus: tolerantArray(CheckFocusSchema, C.focus),
  /** Alternatives on the brand map they name that the brand doesn't watch, with how many articles name each. */
  named: tolerantArray(ByCompetitorSchema, C.named),
  open: z
    .object({
      /** Changes when the reasons do, so Review counts a changed row as new. */
      key: z.string().max(40),
      raisedAt: Stamp,
      reasons: tolerantArray(CheckReasonSchema, C.reasons),
      /** When a Propose with Vizzy was made while it was open. */
      actedAt: Stamp.nullable().catch(null).default(null),
    })
    .nullable()
    .catch(null)
    .default(null),
  dismissedUntil: Stamp.nullable().catch(null).default(null),
});
export type StrategyCheck = z.infer<typeof StrategyCheckSchema>;

// ----- How it went (STRATEGY_RESULTS_ENABLED) ---------------------------------------------------

export const STRATEGY_MONTH_LIMITS = {
  /** Months kept, newest first. */
  months: 12,
  /** Fewer are kept when 12 would pass this many bytes. */
  bytes: 12_000,
  /** The focus situations (5 at most) and the rest of the map. */
  rows: L.focusMax + 1,
} as const;

/** The row for every decided situation that isn't a focus one, and every live article on none of them. */
export const MONTH_REST_ID = "rest";

const M = STRATEGY_MONTH_LIMITS;
/** A plain count: articles, questions, decisions. */
const MonthCount = z.number().int().min(0).max(100_000).catch(0).default(0);
/** A result's number, which can be large (impressions). */
const Result = z.number().min(0).max(1_000_000_000_000);
const OutcomeKindSchema = z.enum(OUTCOME_KINDS);

/** The numbers a month kept for a row, by meaning, only for the kinds it measured. */
export const MonthNumbersSchema = z
  .object({
    searchClicks: Result.optional(),
    searchImpressions: Result.optional(),
    ga4Sessions: Result.optional(),
    ga4KeyEvents: Result.optional(),
    aiCitations: Result.optional(),
  })
  .catch({})
  .default({});
export type MonthNumbers = z.infer<typeof MonthNumbersSchema>;

/**
 * One focus situation, or the rest of the map, as a month saw it. Its words aren't kept, to keep
 * twelve months small: they are read from the brand map when shown.
 */
export const MonthRowSchema = z.object({
  /** A focus situation's id, or MONTH_REST_ID. */
  id: z.string().min(1).max(64),
  questions: MonthCount,
  answered: MonthCount,
  /** Live articles on it at the end of the month, and how many went live in it. */
  live: MonthCount,
  newLive: MonthCount,
  /** Their articles on it published in the month; null when their articles aren't read for the brand. */
  theirs: z.number().int().min(0).max(100_000).nullable().catch(null).default(null),
  m: MonthNumbersSchema,
});
export type MonthRow = z.infer<typeof MonthRowSchema>;

/** Where a month's numbers for one kind came from. */
export const MonthSourceSchema = z.object({
  connectionId: z.string().max(64),
  connector: z.string().max(80),
  /** The number shown, by meaning. */
  measure: z.string().max(60),
  siteOnly: z.boolean().catch(false).default(false),
});
export type MonthSource = z.infer<typeof MonthSourceSchema>;

/**
 * One month of How it went, added up once, early the next month, and never changed after. Each says
 * where its numbers came from and what it couldn't measure, so two months are compared only where
 * they had the same source. Stored without the values its defaults give back (a zero count, false,
 * null, an empty list), so it reads the same and stays small.
 */
export const StrategyMonthSchema = z.object({
  /** "2026-11". */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  /** When it was added up. */
  at: Stamp,
  /** The approved strategy it looked at, and whether that was approved partway through the month. */
  strategyAt: Stamp.nullable().catch(null).default(null),
  partway: z.boolean().catch(false).default(false),
  /** The approved content plan, when there was one. */
  planAt: Stamp.nullable().catch(null).default(null),
  rows: tolerantArray(MonthRowSchema, M.rows),
  /** Totals for kinds measured for the whole site only (Cloudflare's visits). */
  site: z.object({ cfVisits: Result.optional() }).catch({}).default({}),
  /** The plan's roadmap entries to write that were due in the month, and how many of them are answered by a live article. */
  roadmap: z.object({ due: MonthCount, done: MonthCount }).nullable().catch(null).default(null),
  /** What people did in the month, counted from the strategy's and the plan's decisions. */
  did: z
    .object({
      starsKept: MonthCount,
      starsRemoved: MonthCount,
      claimsEdited: MonthCount,
      picksSkipped: MonthCount,
      checksActed: MonthCount,
      checksDismissed: MonthCount,
      /** A log was full and its oldest entry was in the month, so some may have dropped off. */
      capped: z.boolean().catch(false).default(false),
    })
    .prefault({}),
  sources: z
    .object({ search: MonthSourceSchema.optional(), visits: MonthSourceSchema.optional(), key_actions: MonthSourceSchema.optional(), ai_answers: MonthSourceSchema.optional() })
    .catch({})
    .default({}),
  /** The kinds not measured, and why. */
  missing: tolerantArray(z.object({ kind: OutcomeKindSchema, why: z.enum(["not_shared", "failed", "not_connected"]) }), OUTCOME_KINDS.length),
  /** Kinds whose read had more rows than were read, so their numbers may be low. */
  more: z.array(OutcomeKindSchema).max(OUTCOME_KINDS.length).catch([]).default([]),
  /**
   * The days the connected results cover (YYYY-MM-DD, the tools' own zones): the 28 days to the
   * day the month was added up, not the calendar month. Null when nothing was measured.
   */
  resultsFor: z
    .object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
    .nullable()
    .catch(null)
    .default(null),
});
export type StrategyMonth = z.infer<typeof StrategyMonthSchema>;

// ----- The record ------------------------------------------------------------------------------

export const BrandStrategyDocSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** Moves on every change, so a person saving over someone else's is refused. */
  rev: z.number().int().min(0).catch(0).default(0),
  draft: StrategySchema.nullable().catch(null).default(null),
  approved: StrategySchema.nullable().catch(null).default(null),
  /** The approved strategies before the current one, newest first. */
  history: tolerantArray(StrategySchema, L.history),
  decisions: tolerantArray(StrategyDecisionSchema, L.decisions),
  /** The competitor finder's runs: the quick one a brand without the feature gets, and full runs. */
  finder: z
    .object({
      quickAt: Stamp.nullable().catch(null).default(null),
      fullRuns: z.array(Stamp).max(L.finderRuns).catch([]).default([]),
      /** Not a competitor, newest first (STRATEGY_COMPETITORS_ENABLED): kept out of every later run. */
      notCompetitors: tolerantArray(NotCompetitorSchema, L.notCompetitors),
      /**
       * Suggestions a person pressed Monitor on, newest first (STRATEGY_COMPETITORS_ENABLED): one they
       * stop watching later leaves the list rather than coming back as a suggestion. Older records
       * read with it empty, which is right for them.
       */
      monitoredFinds: tolerantArray(NotCompetitorSchema, L.monitoredFinds),
    })
    .prefault({}),
  /** The weekly check (STRATEGY_CHECK_ENABLED); null until it first looks, and on records stored before it. */
  check: StrategyCheckSchema.nullable().catch(null).default(null),
  /** How it went (STRATEGY_RESULTS_ENABLED), newest first; empty until the first month, and on records stored before it. */
  months: tolerantArray(StrategyMonthSchema, STRATEGY_MONTH_LIMITS.months),
  /** After a monthly look failed: not tried again before this. */
  monthsRetryAt: Stamp.nullable().catch(null).default(null),
  /** Looks held back because a connected tool couldn't be read (2 at most, then the month is kept with it marked failed); 0 once a month is kept. */
  monthsRetries: z.number().int().min(0).max(10).catch(0).default(0),
  createdAt: Stamp.catch("").default(""),
  updatedAt: Stamp.catch("").default(""),
});
export type BrandStrategyDoc = z.infer<typeof BrandStrategyDocSchema>;

/** The raw stored document, as the tenant layer hands it over (parsed by brandStrategy/store.ts). */
export type BrandStrategyRecord = { id: string; tenantId: string } & Record<string, unknown>;

export function brandStrategyDocId(tenantId: string): string {
  return `bst_${encodeURIComponent(tenantId)}`;
}

/** An empty strategy, to start a draft from. */
export function emptyStrategy(at: string, by: string | null): Strategy {
  return StrategySchema.parse({ at, by });
}

/** Every competitor in a strategy, in group order. */
export function competitorsOf(s: Pick<Strategy, "competitorGroups">): Array<StrategyCompetitor & { group: CompetitorGroupKind }> {
  return COMPETITOR_GROUP_KINDS.flatMap((kind) => (s.competitorGroups.find((g) => g.kind === kind)?.competitors ?? []).map((c) => ({ ...c, group: kind })));
}

/** A competitor a person ticked or added, or one the brand watches: never pushed out by new finds. */
export const isKeptCompetitor = (c: Pick<StrategyCompetitor, "ticked" | "from">) => c.ticked || c.from !== "finder";

/**
 * Competitors back into their groups, in group order, leaving out empty ones. In each group the
 * kept ones come first and all stay; the finder's own finds fill at most 8 places after them.
 */
export function groupsOf(list: Array<StrategyCompetitor & { group: CompetitorGroupKind }>): StrategyCompetitorGroup[] {
  return COMPETITOR_GROUP_KINDS.flatMap((kind) => {
    const inGroup = list.filter((c) => c.group === kind);
    const competitors = [...inGroup.filter(isKeptCompetitor), ...inGroup.filter((c) => !isKeptCompetitor(c)).slice(0, L.competitorsPerGroup)]
      .slice(0, L.keptPerGroup)
      .map(({ group: _g, ...c }) => {
        void _g;
        return c;
      });
    return competitors.length ? [{ kind, competitors }] : [];
  });
}

// ----- What a person sends ---------------------------------------------------------------------

/**
 * A person's edit of the draft (Strategy tab, admins): the parts it names change, the rest stay.
 * Claims come back whole: a claim keeps its proof by its id, one without an id is new (a gap).
 */
export const StrategyEditSchema = z
  .object({
    baseRev: z.number().int().min(0),
    focusSituationIds: z.array(SituationId).max(L.focusMax).optional(),
    audiences: z.array(Line(L.audienceText)).max(L.audiences).optional(),
    ticked: z
      .array(z.object({ name: Line(L.competitorName), ticked: z.boolean() }))
      .max(COMPETITOR_GROUP_KINDS.length * L.keptPerGroup)
      .optional(),
    claims: z
      .array(
        z.object({
          id: ClaimId.optional(),
          side: z.enum(["you", "them"]).default("you"),
          text: Line(L.claimText),
          competitor: OptionalLine(L.competitorName).nullable().optional(),
        }),
      )
      .max(L.claims)
      .optional(),
    goal: z.object({ text: Line(L.goalText), measure: OptionalLine(L.measureText).default("") }).nullable().optional(),
  })
  .strict();
export type StrategyEdit = z.infer<typeof StrategyEditSchema>;
