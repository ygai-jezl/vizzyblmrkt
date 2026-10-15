import { z } from "zod";
import { BlogIntent } from "./contentPlan";
import { BRAND_MAP_LIMITS, isHttpsUrl } from "./brandMap";

/**
 * The brand map at any size (BRAND_MAP_SCALE_ENABLED): a brand's subjects and their
 * questions in records of their own, in groups, with no fixed count — plus its buying
 * situations (BRAND_MAP_SITUATIONS_ENABLED), its research runs, and what was found in the
 * research it uploaded as a PDF (BRAND_MAP_IMPORT_ENABLED). Regional collections, one
 * document per thing, reached only through src/lib/tenant.
 *
 * Identity and names stay on the brand's one record (brandMap.ts). Its old `subjects` list
 * stays as it was when the subjects moved (`moved`), so a build without these switches still
 * reads it.
 *
 * Every record is decided (a person put it on the map), proposed (research, an import or
 * Vizzy suggests it: nothing reaches an article until a person decides it) or dismissed
 * (kept, so it is never proposed again).
 *
 * Rules for changing this file: additive only, as for brandMap.ts. Pure + client-safe.
 */

/** Safety limits: what a brand can hold before a create is refused. Never shown as advice. */
export const BRAND_MAP_RECORD_LIMITS = {
  subjects: 10_000,
  questionsPerSubject: 500,
  situations: 1_000,
  groups: 500,
  imports: 200,
  /** One research run: situations researched, and questions kept per situation. */
  runSituations: 25,
  runQuestions: 15,
  /** Things kept from one uploaded PDF. */
  importItems: 300,
  importBytes: 14 * 1024 * 1024,
  groupName: 80,
  subjectName: BRAND_MAP_LIMITS.subjectName,
  questionText: BRAND_MAP_LIMITS.questionText,
  situationText: 200,
  situationPart: 120,
  situationsPerQuestion: 10,
  reason: 200,
  backedBy: 6,
  seen: 5,
  label: 200,
} as const;

const isOneLine = (s: string) => !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(s);
const Line = (max: number) => z.string().trim().min(1).max(max).refine(isOneLine, "must be one line of text");
const OptionalLine = (max: number) => z.string().trim().max(max).refine(isOneLine, "must be one line of text");
const Url = z.string().trim().max(300).refine(isHttpsUrl, "must be an https address");
const Id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{6,24}$`), `must be a ${prefix}_ id`);
const Count = z.number().int().min(0).default(0);
/** A list read one item at a time: an item that no longer parses is left out, never the whole list. */
const tolerantArray = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((rows) => rows.flatMap((row) => {
      const parsed = item.safeParse(row);
      return parsed.success ? [parsed.data as z.output<T>] : [];
    }).slice(0, max));
const Stamp = z.string().max(40).default("");

export const SubjectId = Id("sub");
export const QuestionId = Id("q");
export const GroupId = Id("grp");
export const SituationId = Id("sit");
export const RunId = Id("run");
export const ImportId = Id("imp");

export const RecordStatus = z.enum(["decided", "proposed", "dismissed"]);
export type RecordStatus = z.infer<typeof RecordStatus>;

/** Where a record came from. */
export const RecordFrom = z.enum(["person", "move", "research", "situations", "import", "article", "vizzy"]);
export type RecordFrom = z.infer<typeof RecordFrom>;

/** What every record carries besides its own fields. `rev` moves on each edit, for conflicts. */
const recordBase = {
  tenantId: z.string(),
  /** An unknown status (from a later build) reads as dismissed: it never reaches an article. */
  status: RecordStatus.catch("dismissed").default("decided"),
  from: RecordFrom.catch("person").default("person"),
  /** Why it was proposed, in a few words. */
  reason: OptionalLine(BRAND_MAP_RECORD_LIMITS.reason).catch("").default(""),
  /** Where a proposal rests: "from your research: <file>, page 3", "seen in 4 situations". */
  evidence: OptionalLine(BRAND_MAP_RECORD_LIMITS.label).catch("").default(""),
  rev: z.number().int().min(0).default(0),
  createdAt: Stamp,
  updatedAt: Stamp,
  decidedAt: z.string().max(40).nullable().default(null),
};

/** Counts for display only: worked out again whenever a page or question changes, and when it is opened. */
export const SubjectCountsSchema = z.object({
  questions: Count,
  answered: Count,
  drafted: Count,
  planned: Count,
  open: Count,
});
export type SubjectCounts = z.infer<typeof SubjectCountsSchema>;

export const GroupTotalsSchema = z.object({
  subjects: Count,
  questions: Count,
  answered: Count,
  drafted: Count,
  planned: Count,
  /** Subjects with something answered, something drafted (nothing answered), or nothing yet. */
  subjectsAnswered: Count,
  subjectsDrafted: Count,
  subjectsOpen: Count,
});
export type GroupTotals = z.infer<typeof GroupTotalsSchema>;

export const BrandMapGroupSchema = z.object({
  id: GroupId,
  ...recordBase,
  name: Line(BRAND_MAP_RECORD_LIMITS.groupName),
  /** The name folded (changes.ts `fold`): two groups never share it. */
  nameKey: z.string().max(200),
  order: z.number().int().default(0),
  totals: GroupTotalsSchema.prefault({}),
  /** Subjects "Sort into groups" suggested for it, waiting for a person (display only). */
  suggested: Count,
});
export type BrandMapGroup = z.infer<typeof BrandMapGroupSchema>;

export const BrandMapSubjectRecordSchema = z.object({
  id: SubjectId,
  ...recordBase,
  /** null = Ungrouped. */
  groupId: GroupId.nullable().catch(null).default(null),
  name: Line(BRAND_MAP_RECORD_LIMITS.subjectName),
  nameKey: z.string().max(200),
  /** The page on the brand's own site that is this subject's home, and that address normalised. */
  home: Url.nullable().catch(null).default(null),
  urlKey: z.string().max(400).nullable().default(null),
  /** A home page research or an article suggested for it, waiting for a person (it never replaces one). */
  suggestedHome: Url.nullable().catch(null).default(null),
  /** A proposal close in meaning to this subject on the map: shown as "looks like", never merged by itself. */
  looksLike: SubjectId.nullable().catch(null).default(null),
  /** A group "Sort into groups" suggested for it, waiting for a person (it never moves it by itself). */
  suggestedGroupId: GroupId.nullable().catch(null).default(null),
  counts: SubjectCountsSchema.prefault({}),
  /** Answered ÷ questions, in thousandths, so a list can be sorted least answered first. */
  answeredShare: z.number().int().min(0).max(1000).default(0),
  answeredIds: z.array(QuestionId).max(BRAND_MAP_RECORD_LIMITS.questionsPerSubject).catch([]).default([]),
  draftedIds: z.array(QuestionId).max(BRAND_MAP_RECORD_LIMITS.questionsPerSubject).catch([]).default([]),
  plannedIds: z.array(QuestionId).max(BRAND_MAP_RECORD_LIMITS.questionsPerSubject).catch([]).default([]),
  /** Merged into another subject: old links to this one lead there. */
  mergedInto: SubjectId.nullable().catch(null).default(null),
  order: z.number().int().default(0),
});
export type BrandMapSubjectRecord = z.infer<typeof BrandMapSubjectRecordSchema>;

export const BrandMapQuestionRecordSchema = z.object({
  id: QuestionId,
  ...recordBase,
  subjectId: SubjectId,
  text: Line(BRAND_MAP_RECORD_LIMITS.questionText),
  /** The words of the question (blog/brief.ts `textKey`): how pages and research match it exactly. */
  textKey: z.string().max(400),
  intent: BlogIntent.catch("other").default("other"),
  situationIds: z.array(SituationId).max(BRAND_MAP_RECORD_LIMITS.situationsPerQuestion).catch([]).default([]),
  order: z.number().int().default(0),
  /**
   * What people add to the search this question came from ("examples", "free", "step by step
   * guide"), from the brand's own research: leads for an article written for it.
   */
  leads: z.array(OptionalLine(80)).max(8).catch([]).default([]),
  /** Merged away (the subject it was on went into another that asks it too): links lead here. */
  mergedInto: QuestionId.nullable().catch(null).default(null),
});
export type BrandMapQuestionRecord = z.infer<typeof BrandMapQuestionRecordSchema>;

/** Ehrenberg-Bass's W's: what a buying situation turns on. */
export const SituationW = z.enum(["why", "when", "while", "where", "with_whom", "with_what", "feeling"]);
export type SituationW = z.infer<typeof SituationW>;

export const SITUATION_W_LABEL: Record<SituationW, string> = {
  why: "Why",
  when: "When",
  while: "While",
  where: "Where",
  with_whom: "With whom",
  with_what: "With what",
  feeling: "How it feels",
};

/** The business's own goals, or the person's own stake (looking good to the board, not getting caught out). */
export const SituationSide = z.enum(["business", "professional"]);
export type SituationSide = z.infer<typeof SituationSide>;

/** Something of the brand's own that backs a situation: a page on its site, or a knowledge passage. */
export const SituationBackingSchema = z.object({
  kind: z.enum(["page", "knowledge"]),
  label: Line(BRAND_MAP_RECORD_LIMITS.label),
  url: Url.optional(),
});

/** A web page search used for it: its title and domain only, from the search's own sources. */
export const SituationSeenSchema = z.object({
  title: OptionalLine(BRAND_MAP_RECORD_LIMITS.label).catch("").default(""),
  domain: z.string().trim().max(253),
});

export const BrandMapSituationSchema = z.object({
  id: SituationId,
  ...recordBase,
  /** The situation in the buyer's own words: "Our clicks from Google are falling, but our rankings aren't". */
  text: Line(BRAND_MAP_RECORD_LIMITS.situationText),
  textKey: z.string().max(400),
  w: SituationW.catch("why").default("why"),
  /** The W in a few words: "after the monthly traffic report". */
  wText: OptionalLine(BRAND_MAP_RECORD_LIMITS.situationPart).catch("").default(""),
  who: OptionalLine(BRAND_MAP_RECORD_LIMITS.situationPart).catch("").default(""),
  side: SituationSide.catch("business").default("business"),
  want: OptionalLine(BRAND_MAP_RECORD_LIMITS.situationPart).catch("").default(""),
  feel: OptionalLine(BRAND_MAP_RECORD_LIMITS.situationPart).catch("").default(""),
  focus: z.boolean().catch(false).default(false),
  order: z.number().int().default(0),
  /** False: research found it, but nothing of the brand's own backs it (it arrived unticked). */
  backed: z.boolean().catch(true).default(true),
  backedBy: z.array(SituationBackingSchema).max(BRAND_MAP_RECORD_LIMITS.backedBy).catch([]).default([]),
  seen: z.array(SituationSeenSchema).max(BRAND_MAP_RECORD_LIMITS.seen).catch([]).default([]),
  counts: z.object({ questions: Count, answered: Count }).prefault({}),
});
export type BrandMapSituation = z.infer<typeof BrandMapSituationSchema>;

/** A research run: one research allowance, then its steps carry the run's id. */
export const BrandMapRunSchema = z.object({
  id: RunId,
  tenantId: z.string(),
  kind: z.enum(["situations", "subjects", "groups", "import"]),
  startedAt: z.string().max(40),
  startedBy: z.string().max(254).nullable().default(null),
  expiresAt: z.string().max(40),
  stepsLeft: z.number().int().min(0),
  /** Steps that run once per run, once taken (finding the buying situations: "find"). */
  done: z.array(z.string().max(40)).max(20).catch([]).default([]),
});
export type BrandMapRun = z.infer<typeof BrandMapRunSchema>;

/** What an uploaded PDF holds, item by item. */
export const ImportItemKind = z.enum(["ask", "also", "question", "theme", "note"]);
export type ImportItemKind = z.infer<typeof ImportItemKind>;

export const ImportItemSchema = z.object({
  id: z.string().max(40),
  kind: ImportItemKind,
  /** Word for word as it appears ("People also ask" questions, searches), or a one-line note. */
  text: Line(BRAND_MAP_RECORD_LIMITS.label),
  page: z.number().int().min(1).max(10_000).nullable().default(null),
  /** The search it was found under. */
  search: OptionalLine(BRAND_MAP_RECORD_LIMITS.label).catch("").default(""),
  /** A search that implies a question, as that question. */
  asQuestion: OptionalLine(BRAND_MAP_RECORD_LIMITS.questionText).catch("").default(""),
  /** Where placing it put it: a subject on the map, a proposed one, or nowhere (it doesn't fit). */
  subjectId: SubjectId.nullable().catch(null).default(null),
  questionId: QuestionId.nullable().catch(null).default(null),
  fits: z.boolean().catch(true).default(true),
  /** What it adds to its search ("examples", "step by step guide"), for a related search. */
  adds: OptionalLine(80).catch("").default(""),
  /** Placed in a subject the map doesn't have yet: its name (made when a person adds it). */
  newSubject: OptionalLine(BRAND_MAP_RECORD_LIMITS.subjectName).catch("").default(""),
  /** The heading of the research's AI answer it falls under. */
  theme: OptionalLine(BRAND_MAP_RECORD_LIMITS.label).catch("").default(""),
  /** The buying situation it clearly belongs to. */
  situationId: SituationId.nullable().catch(null).default(null),
  /** Why it doesn't fit what the brand does, in a few words. */
  why: OptionalLine(BRAND_MAP_RECORD_LIMITS.reason).catch("").default(""),
  /** Placing has looked at it (placed or not), so it isn't asked about again. */
  tried: z.boolean().catch(false).default(false),
});
export type ImportItem = z.infer<typeof ImportItemSchema>;

export const BrandMapImportSchema = z.object({
  id: ImportId,
  tenantId: z.string(),
  fileName: Line(BRAND_MAP_RECORD_LIMITS.label),
  pages: z.number().int().min(0).default(0),
  at: z.string().max(40),
  by: z.string().max(254).nullable().default(null),
  searches: z.array(Line(BRAND_MAP_RECORD_LIMITS.label)).max(20).catch([]).default([]),
  items: tolerantArray(ImportItemSchema, BRAND_MAP_RECORD_LIMITS.importItems),
  themes: tolerantArray(
    z.object({ name: Line(BRAND_MAP_RECORD_LIMITS.label), page: z.number().int().nullable().default(null), groupId: GroupId.nullable().catch(null).default(null) }),
    40,
  ),
  /** Sites an AI answer in it cites: a name or bare domain each. */
  cited: z.array(Line(BRAND_MAP_RECORD_LIMITS.label)).max(20).catch([]).default([]),
  /** Placing is done (the browser runs it a batch at a time). */
  placed: z.boolean().default(false),
});
export type BrandMapImport = z.infer<typeof BrandMapImportSchema>;

/** On the brand's one record: when its subjects moved into records (defined with that record). */
export { BrandMapMovedSchema, type BrandMapMoved } from "./brandMap";

/**
 * A record as the tenant layer stores it. Its own id is `ref` (`sub_…`, `q_…`); the document
 * id is a digest of the brand and `ref` (src/lib/tenant/brandMapRecords.ts), so two brands'
 * records can never collide. Parsed by src/lib/brandMap/records.ts.
 */
export type BrandMapStoredRecord = { id: string; tenantId: string; ref: string } & Record<string, unknown>;
