import { z } from "zod";
import { isHttpsUrl } from "./brandMap";
import { SituationId } from "./brandMapRecords";

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
    })
    .prefault({}),
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
