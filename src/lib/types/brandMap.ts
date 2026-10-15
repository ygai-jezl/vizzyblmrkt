import { z } from "zod";
import { BlogIntent } from "./contentPlan";

/**
 * The brand map (BRAND_MAP_ENABLED): ONE record per brand (tenant) that every blog article
 * is written from. What the brand is, the names it uses and avoids, the subjects it wants
 * to be known for (each with the questions people ask), its profile links, and the page on
 * its own site that is the home of each subject and name.
 *
 * Two halves on one document (regional `brand_maps`, id `bm_<tenantId>`):
 *  - DECIDED (`identity`, `subjects`, `names`): changed only by a person saving the page.
 *    `rev` moves only when this half changes; articles read it only once `rev` ≥ 1.
 *  - SUGGESTIONS: proposed changes from research, from articles and from Vizzy. They wait
 *    for a person to accept or dismiss them; a dismissed one never comes back
 *    (`dismissed` holds its key). Appending one never moves `rev`, so a suggestion can
 *    never make a person's save fail.
 *
 * Rules for changing this file: additive only. Never tighten a cap, remove an enum value
 * or make a field required: a stored map that no longer parses is unreadable, and an
 * unreadable map stops every article from reading it until a person fixes it.
 *
 * Pure + client-safe (the editor validates with it before saving).
 */

export const BRAND_MAP_LIMITS = {
  name: 80,
  category: 80,
  statement: 300,
  isNot: 8,
  isNotText: 120,
  avoid: 20,
  avoidTerm: 60,
  profiles: 12,
  categorySameAs: 2,
  subjects: 8,
  subjectName: 80,
  questions: 20,
  questionText: 200,
  names: 80,
  nameText: 80,
  aliases: 6,
  aliasText: 60,
  nameSameAs: 3,
  /** Waiting suggestions per source; the oldest of that source goes first. */
  suggestions: { research: 100, article: 40, vizzy: 30 },
  reason: 200,
  dismissed: 300,
  researchNotes: 5,
  researchNote: 200,
  /** A write that would make the document bigger than this is refused (Firestore's limit is 1 MiB). */
  bytes: 700_000,
} as const;

/** One line of plain text: no line breaks or control characters (each goes into a prompt as one line). */
const isOneLine = (s: string) => !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(s);
const Line = (max: number) => z.string().trim().min(1).max(max).refine(isOneLine, "must be one line of text");
const OptionalLine = (max: number) => z.string().trim().max(max).refine(isOneLine, "must be one line of text");

export const isHttpsUrl = (u: string) => /^https:\/\/[^\s<>"'`]+$/i.test(u);
const Url = z.string().trim().max(300).refine(isHttpsUrl, "must be an https address");

const Id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{6,24}$`), `must be a ${prefix}_ id`);

/** Where an identifier or profile link came from. A person confirms every one before it is kept. */
export const BrandMapLinkSource = z.enum(["site", "wikidata", "wikipedia", "manual"]);
export type BrandMapLinkSource = z.infer<typeof BrandMapLinkSource>;

export const BrandMapLinkSchema = z.object({
  url: Url,
  source: BrandMapLinkSource.default("manual"),
  /** When a person confirmed it (stamped by the server on save). */
  confirmedAt: z.string().max(40).default(""),
});
export type BrandMapLink = z.infer<typeof BrandMapLinkSchema>;

export const BrandMapAvoidSchema = z.object({
  /** A name the brand does not use ("GEO tool"). */
  term: Line(BRAND_MAP_LIMITS.avoidTerm),
  /** What to say instead ("AI visibility tracking"); "" = just don't use it. */
  useInstead: OptionalLine(BRAND_MAP_LIMITS.avoidTerm).default(""),
});
export type BrandMapAvoid = z.infer<typeof BrandMapAvoidSchema>;

export const BrandMapIdentitySchema = z.object({
  name: OptionalLine(BRAND_MAP_LIMITS.name).default(""),
  /** The one name for the brand's category, as buyers say it. */
  category: OptionalLine(BRAND_MAP_LIMITS.category).default(""),
  /** Identifiers for the category itself (a Wikidata item, a Wikipedia page). */
  categorySameAs: z.array(BrandMapLinkSchema).max(BRAND_MAP_LIMITS.categorySameAs).default([]),
  /** One sentence: what the brand is, and who it is for. */
  statement: OptionalLine(BRAND_MAP_LIMITS.statement).default(""),
  /** What the brand is not, one line each. */
  isNot: z.array(Line(BRAND_MAP_LIMITS.isNotText)).max(BRAND_MAP_LIMITS.isNot).default([]),
  avoid: z.array(BrandMapAvoidSchema).max(BRAND_MAP_LIMITS.avoid).default([]),
  /** The brand's own site, e.g. https://example.com; "" = not set. */
  site: z.union([Url, z.literal("")]).default(""),
  /** Profile pages and identifiers for the brand itself: its schema.org `sameAs`. */
  profiles: z.array(BrandMapLinkSchema).max(BRAND_MAP_LIMITS.profiles).default([]),
});
export type BrandMapIdentity = z.infer<typeof BrandMapIdentitySchema>;

export const BrandMapQuestionSchema = z.object({
  id: Id("q"),
  text: Line(BRAND_MAP_LIMITS.questionText),
  intent: BlogIntent.catch("other").default("other"),
});
export type BrandMapQuestion = z.infer<typeof BrandMapQuestionSchema>;

export const BrandMapSubjectSchema = z.object({
  id: Id("sub"),
  name: Line(BRAND_MAP_LIMITS.subjectName),
  /** The page on the brand's own site that is this subject's home. */
  home: Url.optional(),
  questions: z.array(BrandMapQuestionSchema).max(BRAND_MAP_LIMITS.questions).default([]),
});
export type BrandMapSubject = z.infer<typeof BrandMapSubjectSchema>;

/** What a name is to the brand. The brand itself and its category live in `identity`. */
export const BrandMapNameKind = z.enum(["product", "alternative", "integration", "audience", "use_case"]);
export type BrandMapNameKind = z.infer<typeof BrandMapNameKind>;

export const BrandMapNameSchema = z.object({
  id: Id("n"),
  name: Line(BRAND_MAP_LIMITS.nameText),
  kind: BrandMapNameKind,
  /** Other spellings that mean the same thing. They help recognise the name; they are never forbidden. */
  aliases: z.array(Line(BRAND_MAP_LIMITS.aliasText)).max(BRAND_MAP_LIMITS.aliases).default([]),
  /** The page on the brand's own site that is this name's home. */
  home: Url.optional(),
  /** Identifiers: a Wikidata item, a Wikipedia page, an official site. */
  sameAs: z.array(BrandMapLinkSchema).max(BRAND_MAP_LIMITS.nameSameAs).default([]),
});
export type BrandMapName = z.infer<typeof BrandMapNameSchema>;

/** The half a person decides. */
export const BrandMapDecidedSchema = z.object({
  identity: BrandMapIdentitySchema.prefault({}),
  subjects: z.array(BrandMapSubjectSchema).max(BRAND_MAP_LIMITS.subjects).default([]),
  names: z.array(BrandMapNameSchema).max(BRAND_MAP_LIMITS.names).default([]),
});
export type BrandMapDecided = z.infer<typeof BrandMapDecidedSchema>;

export const IDENTITY_FIELDS = ["name", "category", "statement", "site"] as const;

/**
 * One proposed change. Every suggestion is one of these; a person accepting it applies
 * it to the decided half. Strict: a change may carry nothing it does not name (an agent
 * cannot slip an address into a name, for instance).
 */
export const BrandMapChangeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("set_identity"),
    field: z.enum(IDENTITY_FIELDS),
    value: Line(BRAND_MAP_LIMITS.statement),
  }),
  z.strictObject({ type: z.literal("add_is_not"), text: Line(BRAND_MAP_LIMITS.isNotText) }),
  z.strictObject({
    type: z.literal("add_avoid"),
    term: Line(BRAND_MAP_LIMITS.avoidTerm),
    useInstead: OptionalLine(BRAND_MAP_LIMITS.avoidTerm).default(""),
  }),
  z.strictObject({ type: z.literal("add_profile"), url: Url, source: BrandMapLinkSource.default("site") }),
  z.strictObject({ type: z.literal("add_subject"), name: Line(BRAND_MAP_LIMITS.subjectName) }),
  z.strictObject({
    type: z.literal("add_question"),
    /** The subject, by name. */
    subject: Line(BRAND_MAP_LIMITS.subjectName),
    text: Line(BRAND_MAP_LIMITS.questionText),
    intent: BlogIntent.catch("other").default("other"),
  }),
  z.strictObject({
    type: z.literal("add_name"),
    name: Line(BRAND_MAP_LIMITS.nameText),
    kind: BrandMapNameKind,
    aliases: z.array(Line(BRAND_MAP_LIMITS.aliasText)).max(BRAND_MAP_LIMITS.aliases).default([]),
  }),
  z.strictObject({ type: z.literal("add_alias"), name: Line(BRAND_MAP_LIMITS.nameText), alias: Line(BRAND_MAP_LIMITS.aliasText) }),
  z.strictObject({
    type: z.literal("set_home"),
    target: z.enum(["subject", "name"]),
    name: Line(BRAND_MAP_LIMITS.nameText),
    url: Url,
  }),
]);
export type BrandMapChange = z.infer<typeof BrandMapChangeSchema>;

export const BrandMapSuggestionFrom = z.enum(["research", "article", "vizzy"]);
export type BrandMapSuggestionFrom = z.infer<typeof BrandMapSuggestionFrom>;

export const BrandMapSuggestionSchema = z.object({
  id: Id("sg"),
  /** Deterministic from the change (changes.ts `changeKey`): the same proposal always has the same key. */
  key: z.string().min(1).max(200),
  change: BrandMapChangeSchema,
  /** Why it is suggested, in a few words. */
  reason: z.string().max(BRAND_MAP_LIMITS.reason).default(""),
  from: BrandMapSuggestionFrom,
  /** What it rests on: the brand's own site, its articles, a web search, or someone asked for it. */
  evidence: z.enum(["site", "articles", "search", "asked"]).optional(),
  /** Read between the lines rather than stated anywhere: shown unticked, to check. */
  inferred: z.boolean().default(false),
  /** The article that suggested it. */
  ref: z
    .object({
      workspaceId: z.string().max(64),
      planId: z.string().max(64),
      title: z.string().max(200).default(""),
    })
    .optional(),
  at: z.string().max(40),
});
export type BrandMapSuggestion = z.infer<typeof BrandMapSuggestionSchema>;

/** The last research run: when, and anything it could not do. */
export const BrandMapResearchSchema = z.object({
  at: z.string().max(40),
  notes: z.array(z.string().max(BRAND_MAP_LIMITS.researchNote)).max(BRAND_MAP_LIMITS.researchNotes).default([]),
});
export type BrandMapResearch = z.infer<typeof BrandMapResearchSchema>;

/** On the brand's record once its subjects moved into records of their own (BRAND_MAP_SCALE_ENABLED). */
export const BrandMapMovedSchema = z.object({
  at: z.string().max(40),
  /** A digest of the `subjects` list at the move: if it changes while the switch is off, what was added is brought in. */
  arrayHash: z.string().max(64),
});
export type BrandMapMoved = z.infer<typeof BrandMapMovedSchema>;

/** The stored document: suggestions are read one row at a time (store.ts), so they are `unknown` here. */
export const BrandMapStoredSchema = BrandMapDecidedSchema.extend({
  id: z.string(),
  tenantId: z.string(),
  rev: z.number().int().min(0).default(0),
  suggestions: z.array(z.unknown()).catch([]).default([]),
  dismissed: z.array(z.string().max(200)).max(BRAND_MAP_LIMITS.dismissed).catch([]).default([]),
  research: BrandMapResearchSchema.nullable().catch(null).default(null),
  decidedAt: z.string().nullable().default(null),
  decidedBy: z.string().max(254).nullable().default(null),
  createdAt: z.string().default(""),
  updatedAt: z.string().default(""),
  /** Set once the subjects moved into records; from then on `subjects` above is kept as it was. */
  moved: BrandMapMovedSchema.nullable().catch(null).default(null),
  /** When a person first decided one of the map's records (a subject, question or situation). */
  recordsDecidedAt: z.string().max(40).nullable().catch(null).default(null),
  /** The ungrouped subjects' totals, for display (brandMapRecords.ts GroupTotalsSchema). */
  ungroupedTotals: z.record(z.string(), z.number()).nullable().catch(null).default(null),
});

/** The brand map as the app reads it: the decided half, its suggestions parsed, and its bookkeeping. */
export type BrandMap = BrandMapDecided & {
  id: string;
  tenantId: string;
  rev: number;
  suggestions: BrandMapSuggestion[];
  dismissed: string[];
  research: BrandMapResearch | null;
  decidedAt: string | null;
  decidedBy: string | null;
  createdAt: string;
  updatedAt: string;
  moved: BrandMapMoved | null;
  recordsDecidedAt: string | null;
  ungroupedTotals?: Record<string, number> | null;
};

/**
 * Saved: a person has decided something on the map — saved the page once (`rev` ≥ 1), or
 * decided one of its records. Until then nothing reaches an article.
 */
export function isMapSaved(map: Pick<BrandMap, "rev" | "recordsDecidedAt">): boolean {
  return map.rev >= 1 || Boolean(map.recordsDecidedAt);
}

/** The raw stored document, as the tenant layer hands it over (parsed by brandMap/store.ts). */
export type BrandMapRecord = { id: string; tenantId: string } & Record<string, unknown>;

export function brandMapDocId(tenantId: string): string {
  return `bm_${encodeURIComponent(tenantId)}`;
}
