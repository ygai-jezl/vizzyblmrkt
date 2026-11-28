import { z } from "zod";
import { MEANINGS, type MeaningKey } from "@/lib/metrics/meanings";
import { LOOP_RULES, LOOPS, VENDOR, type LoopKind } from "@/lib/loops/registry";
import { RESOURCES, type ResourcePurpose } from "@/lib/plans/resources";
import { isCanonicalInstant } from "@/lib/ontology/events";
import { AgentActionIdSchema, SignalRefSchema } from "@/lib/types/agentAction";
import { EVENT_NAME_RE } from "@/lib/types/productConnection";
import type { Region } from "@/lib/types/tenant";
import { COMPANY_STAGE_IDS } from "./stages";

/**
 * Work's data (ADR-0020): `work_tasks` and `work_log`, both in regional databases, written only
 * through src/lib/tenant/work.ts.
 *
 * - A task lives in the regional database of the brand it names, or for a whole business task
 *   (no brand) of the brand it was added from. It never moves database: a brand move changes its
 *   organisation, never its region.
 * - Every change to a task writes a `work_log` row with the value before and after, in the same
 *   transaction. Log rows are append only and have no time to live: they go only when the
 *   organisation's Work is erased.
 * - Refs (#73) are numbered per organisation by a counter in the control plane
 *   (src/lib/tenant/workRefs.ts); a task's document id is random (`wt_`), so a suggestion can name
 *   the task it would make before it exists.
 * - Origin, the proposed kind of win and `recommended` on a decision are set by the server, never
 *   read from a request.
 *
 * Pure: zod, plain data and type imports, so the add page, the list and measureKind.ts can use it
 * in the browser. Text people write here is data, never instructions, for Vizzy.
 */

// --- Limits ------------------------------------------------------------------------------------

export const WORK_LIMITS = {
  title: 200,
  description: 4000,
  notes: 4000,
  links: 20,
  blockedBy: 5,
  typedLinks: 10,
  /** Decisions on one task. */
  decisions: 50,
  /** Tasks in one organisation, across every region. */
  tasks: 5000,
  /** Log entries people write in one organisation on one day. */
  entriesPerDay: 500,
  /** Changes kept on the task itself; every change is also a log row. */
  recent: 20,
  /** Signals a Vizzy suggestion's origin keeps. */
  evidence: 10,
  linkUrl: 2000,
  linkLabel: 120,
  waitingOn: 120,
  checkNote: 280,
  workstream: 80,
  entryNote: 280,
  entryLinks: 3,
  question: 200,
  optionLabel: 120,
  reason: 280,
  why: 280,
  planUrl: 2000,
  planTitle: 120,
  planVersion: 40,
  proposedReason: 140,
  noneReason: 140,
  word: 40,
  importFile: 120,
  importRows: 1000,
  /** The longest a recent entry keeps a value before and after. */
  recentValue: 200,
} as const;

// --- Ids and small values ----------------------------------------------------------------------

/** `wt_` and 20 base32 characters: random, never the ref. */
export const WORK_TASK_ID = /^wt_[a-z2-7]{20}$/;
/** `wl_` and 24 hex. */
export const WORK_LOG_ID = /^wl_[0-9a-f]{24}$/;
/** An import's id, shared by every task it made. */
export const WORK_IMPORT_ID = /^wi_[0-9a-f]{16}$/;
/** The largest ref; the task page's address takes 1 to 6 digits. */
export const MAX_WORK_REF = 999_999;

const REGION_IDS = ["us", "eu", "asia"] as const satisfies readonly Region[];
const ORGANISATION_ID = /^org_[A-Za-z0-9_-]{1,155}$/;
const TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A team member's user id, a product connection or an idea: no address, no spaces. */
const PLAIN_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** A tool that wrote a row, such as work_page, quick_add, import, review_add or draft_work_log. */
const TOOL = /^[a-z][a-z_]{0,39}$/;
/** A repo as its connection keeps it (fullPath): owner/name, or a GitLab group/sub/project. */
const REPO_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,9}$/;
/** A switch's name: capitals, digits and underscores, up to 80. */
export const SWITCH_NAME = /^[A-Z][A-Z0-9_]{0,79}$/;
/** An ontology type's id (src/lib/ontology/registry.ts). */
const TYPE_ID = /^[a-z][a-z0-9_]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const Canonical = z.string().refine(isCanonicalInstant, { message: "not a canonical instant (toISOString)" });
const PlainId = z.string().regex(PLAIN_ID);
const MemberId = z.string().regex(PLAIN_ID);
const TenantId = z.string().regex(TENANT_ID);
export const WorkTaskIdSchema = z.string().regex(WORK_TASK_ID);
export const WorkLogIdSchema = z.string().regex(WORK_LOG_ID);
export const OrganisationIdSchema = z.string().regex(ORGANISATION_ID);
export const RegionSchema = z.enum(REGION_IDS);
export const WorkRefSchema = z.number().int().min(1).max(MAX_WORK_REF);

/** A real calendar day, YYYY-MM-DD. */
export function isDay(v: unknown): v is string {
  return typeof v === "string" && DAY.test(v) && new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v;
}
export const DaySchema = z.string().refine(isDay, { message: "not a YYYY-MM-DD day" });

const oneLine = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), { message: "one line" });

// --- Statuses ----------------------------------------------------------------------------------

export const WORK_STATUSES = ["todo", "in_progress", "waiting", "done", "dropped"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/** The statuses that close a task: it gets a closedAt. */
export const CLOSED_STATUSES = ["done", "dropped"] as const satisfies readonly WorkStatus[];

export function isClosedStatus(s: WorkStatus): boolean {
  return (CLOSED_STATUSES as readonly string[]).includes(s);
}

// --- Links -------------------------------------------------------------------------------------

/** An http(s) address with no user name or password in it. */
function isWebAddress(v: string, httpsOnly: boolean): boolean {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && (httpsOnly || u.protocol !== "http:")) return false;
  return !u.username && !u.password && Boolean(u.hostname);
}

/** A free link: an AI chat, a page, a doc. */
export const WorkLinkSchema = z.object({
  url: z
    .string()
    .max(WORK_LIMITS.linkUrl)
    .refine((v) => isWebAddress(v, false), { message: "an http or https address with no user name or password" }),
  label: oneLine(WORK_LIMITS.linkLabel).optional(),
});
export type WorkLink = z.infer<typeof WorkLinkSchema>;

/** A clipping from a programme's Scrapbook (idea items). */
export const ClippingSchema = z.object({ brandId: TenantId, workspaceId: PlainId, itemId: PlainId });
export type Clipping = z.infer<typeof ClippingSchema>;

/** A plan page: https only, up to 2,000 characters, with no user name or password in it. */
export const PlanUrlSchema = z
  .string()
  .max(WORK_LIMITS.planUrl)
  .refine((v) => isWebAddress(v, true), { message: "an https address with no user name or password" });

const isLoopKind = (v: string): v is LoopKind => Object.prototype.hasOwnProperty.call(LOOPS, v);
const LoopKindSchema = z.string().refine(isLoopKind, { message: "not a kind in src/lib/loops/registry.ts" }) as unknown as z.ZodType<LoopKind>;

export const TYPED_LINK_KINDS = ["pull_request", "switch", "idea", "loop_line", "plan"] as const;
export type TypedLinkKind = (typeof TYPED_LINK_KINDS)[number];

/**
 * The join keys of the delivery chain, beside the free links: agents can't read free links
 * reliably. A switch or a loop line is named, or `none` with the reason why there is none.
 */
export const TypedLinkSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("pull_request"), provider: z.enum(["github", "gitlab"]), repo: z.string().max(200).regex(REPO_PATH), number: z.number().int().min(1).max(2_147_483_647) }),
    z.object({ kind: z.literal("switch"), name: z.string().regex(SWITCH_NAME).optional(), none: oneLine(WORK_LIMITS.noneReason).min(1).optional() }),
    z.object({ kind: z.literal("idea"), brandId: TenantId, ideaId: PlainId }),
    z.object({ kind: z.literal("loop_line"), loopKind: LoopKindSchema.optional(), none: oneLine(WORK_LIMITS.noneReason).min(1).optional() }),
    z.object({ kind: z.literal("plan"), url: PlanUrlSchema, title: oneLine(WORK_LIMITS.planTitle).min(1), version: oneLine(WORK_LIMITS.planVersion).min(1).optional() }),
  ])
  .superRefine((l, c) => {
    if (l.kind !== "switch" && l.kind !== "loop_line") return;
    const named = l.kind === "switch" ? l.name : l.loopKind;
    if ((named === undefined) === (l.none === undefined)) {
      c.addIssue({ code: "custom", path: ["none"], message: l.kind === "switch" ? "a switch link names a switch, or none with why" : "a loop line names a LOOPS kind, or none with why" });
    }
  });
export type TypedLink = z.infer<typeof TypedLinkSchema>;

/** Typed links without loop lines, which only operators see (decision 14). */
export function withoutLoopLines<T extends { kind: string }>(links: readonly T[]): T[] {
  return links.filter((l) => l.kind !== "loop_line");
}

// --- How we'll know it worked ------------------------------------------------------------------

export const MEASURE_KINDS = ["used", "moves", "runs_better", "done"] as const;
export type MeasureKind = (typeof MEASURE_KINDS)[number];

export const RUNS_BETTER_WHAT = ["errors", "crashes", "memory", "cost", "speed"] as const;
export type RunsBetterWhat = (typeof RUNS_BETTER_WHAT)[number];

const MEANING_KEYS = Object.keys(MEANINGS) as [MeaningKey, ...MeaningKey[]];
const PURPOSES = new Set<string>(Object.values(RESOURCES).flatMap((r) => r.purposes as readonly string[]));
const isPurpose = (v: string): v is ResourcePurpose => PURPOSES.has(v);

/** When to look: N days after Done, or after N outputs once the loops count outputs (the verdict's looks). */
export const LookSchema = z.union([
  z.object({ days: z.number().int().min(1).max(365) }).strict(),
  z.object({ outputs: z.number().int().refine((n) => (LOOP_RULES.looks as readonly number[]).includes(n), { message: "10, 20 or 40" }) }).strict(),
]);
export type Look = z.infer<typeof LookSchema>;

/**
 * What a Used measure counts: exactly one of an AI purpose in the usage meter, an ontology type, a
 * LOOPS kind (those three for operators only), the brand's own product event, or none (the
 * person's read is the record, with an optional reason).
 */
export const UsedCountsSchema = z.union([
  z.object({ purpose: z.string().refine(isPurpose, { message: "not a purpose in src/lib/plans/resources.ts" }) }).strict(),
  z.object({ type: z.string().regex(TYPE_ID) }).strict(),
  z.object({ loopKind: LoopKindSchema }).strict(),
  z.object({ productEvent: z.object({ connectionId: PlainId, event: z.string().max(80).regex(EVENT_NAME_RE) }).strict() }).strict(),
  z.object({ none: oneLine(WORK_LIMITS.noneReason) }).strict(),
]);
export type UsedCounts = z.infer<typeof UsedCountsSchema>;

const UsedFields = { kind: z.literal("used"), counts: UsedCountsSchema, look: LookSchema };
const MovesFields = {
  kind: z.literal("moves"),
  meaning: z.enum(MEANING_KEYS),
  direction: z.enum(["up", "down"]),
  /** The brand's own word for conversions, such as Sign ups or Orders. */
  word: oneLine(WORK_LIMITS.word).min(1).optional(),
  look: LookSchema,
};
const RunsBetterFields = { kind: z.literal("runs_better"), what: z.enum(RUNS_BETTER_WHAT), look: LookSchema };

/** A then: one second measure with the first's shape, never Done is the win. */
export const ThenSchema = z.discriminatedUnion("kind", [z.object(UsedFields), z.object(MovesFields), z.object(RunsBetterFields)]);
export type ThenMeasure = z.infer<typeof ThenSchema>;

/** The kind proposed for the task, set by the server: the rule's (measureKind.ts) or Vizzy's. */
export const ProposedKindSchema = z.object({ kind: z.enum(MEASURE_KINDS), reason: oneLine(WORK_LIMITS.proposedReason).min(1), by: z.enum(["rule", "vizzy"]) });
export type ProposedKind = z.infer<typeof ProposedKindSchema>;

const SetFields = { setBy: MemberId, setAt: Canonical, proposed: ProposedKindSchema.nullable().optional() };

/** Problems with one measure's own fields: a vendor's or a date meaning, or a word not on conversions. */
function measureFieldProblems(m: { kind: string; meaning?: string; word?: string }): string[] {
  if (m.kind !== "moves" || !m.meaning) return [];
  const out: string[] = [];
  if (VENDOR.test(m.meaning)) out.push("a Moves a number measure never names one provider's number");
  if ((MEANINGS as Record<string, { unit: string }>)[m.meaning]?.unit === "date") out.push("a date is not a number that moves");
  if (m.word !== undefined && m.meaning !== "conversions") out.push("the brand's word goes only with conversions");
  return out;
}

export const MeasureSchema = z
  .discriminatedUnion("kind", [
    z.object({ ...UsedFields, ...SetFields, then: ThenSchema.nullable().optional() }),
    z.object({ ...MovesFields, ...SetFields, then: ThenSchema.nullable().optional() }),
    z.object({ ...RunsBetterFields, ...SetFields, then: ThenSchema.nullable().optional() }),
    z.object({ kind: z.literal("done"), ...SetFields }),
  ])
  .superRefine((m, c) => {
    for (const p of measureFieldProblems(m as { kind: string; meaning?: string; word?: string })) c.addIssue({ code: "custom", path: ["meaning"], message: p });
    const then = "then" in m ? m.then : null;
    if (!then) return;
    for (const p of measureFieldProblems(then as { kind: string; meaning?: string; word?: string })) c.addIssue({ code: "custom", path: ["then", "meaning"], message: p });
    const first = "look" in m ? m.look : null;
    if (first && "days" in first && "days" in then.look && then.look.days <= first.days) {
      c.addIssue({ code: "custom", path: ["then", "look"], message: "when both look by days, the then looks later" });
    }
  });
export type Measure = z.infer<typeof MeasureSchema>;

/** A Moves a number measure's direction to start from: down for a rank or a meaning where lower is better, else up. */
export function startingDirection(meaning: MeaningKey): "up" | "down" {
  const m = MEANINGS[meaning] as { unit: string; better?: "higher" | "lower" };
  if (m.unit === "rank") return "down";
  return m.better === "lower" ? "down" : "up";
}

// --- Origin ------------------------------------------------------------------------------------

export const ORIGIN_KINDS = ["person", "import", "suggestion", "coding_agent"] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

/**
 * Where a task came from, set by the path that made it, never read from a request. A coding
 * agent's origin waits for piece K: the store refuses it.
 */
export const OriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), by: MemberId }),
  z.object({
    kind: z.literal("import"),
    by: MemberId,
    importId: z.string().regex(WORK_IMPORT_ID),
    row: z.number().int().min(1).max(100_000),
    /** The file's base name, as the task page shows it ("Imported from Backlog.csv"). */
    file: oneLine(WORK_LIMITS.importFile).min(1).optional(),
  }),
  z.object({
    kind: z.literal("suggestion"),
    agent: z.literal("vizzy"),
    agentActionId: AgentActionIdSchema,
    evidence: z.array(SignalRefSchema).max(WORK_LIMITS.evidence),
    /** Who added it from Review. */
    by: MemberId,
    chatId: PlainId.optional(),
  }),
  z.object({ kind: z.literal("coding_agent"), tool: z.string().regex(TOOL), session: PlainId, keyId: PlainId }),
]);
export type WorkOrigin = z.infer<typeof OriginSchema>;

// --- Who did it --------------------------------------------------------------------------------

export const WHO_KINDS = ["person", "vizzy", "coding_agent", "system"] as const;

/** Who did it: a team member by user id, Vizzy, a coding agent (after K) or the system. Ids only. */
export const WhoSchema = z.object({ kind: z.enum(WHO_KINDS), id: PlainId.nullable() });
export type WorkWho = z.infer<typeof WhoSchema>;

/** Who wrote a row, with which tool and in which session. */
export const WorkSourceSchema = z.object({ who: WhoSchema, tool: z.string().regex(TOOL), session: PlainId.nullable() });
export type WorkSource = z.infer<typeof WorkSourceSchema>;

// --- Checks ------------------------------------------------------------------------------------

/** The most closed weeks one count from the learning loops reads: USED_WEEKS_MAX in src/lib/loops/used.ts, which a test holds this to. */
export const COUNTED_WEEKS_MAX = 13;

/**
 * A count from the learning loops' weekly counts across brands (LOOPS_ENABLED on, for a purpose, a
 * type or a LOOPS kind), never a walk over brands. `read`: the closed ISO weeks read, the newest
 * 13 at most, with `from` the first one's Monday and `to` the last one's end; `shown`: those with
 * counts from 10 organisations or more, which `n` adds up; `orgs`: the fewest organisations in a
 * week shown; `open` from `openFrom`: weeks the check covers that weren't over when it was
 * counted, left out; `older`: closed weeks before the 13 read, left out; `beforeDone`: the first
 * week read starts before Done; `row`: the row a LOOPS kind counts under when that isn't the kind
 * itself, as the image kinds count together.
 */
export const CountedWeeksSchema = z
  .object({
    read: z.number().int().min(0).max(COUNTED_WEEKS_MAX),
    shown: z.number().int().min(0).max(COUNTED_WEEKS_MAX),
    orgs: z.number().int().min(0).optional(),
    open: z.number().int().min(0),
    openFrom: Canonical.optional(),
    older: z.number().int().min(0),
    beforeDone: z.boolean().optional(),
    row: z.string().max(60).optional(),
  })
  .strict();
export type CountedWeeks = z.infer<typeof CountedWeeksSchema>;

/**
 * What a measure's check counted, read once when the check first shows and kept on it: a count
 * (`n`), units a purpose spent, how many brands used it (or `hidden` below the cell size), and
 * `capped` with `backTo` when only the newest rows could be read. `backTo` alone: a product
 * event's count starts after `from`, where the events still kept (90 days) began when it was
 * counted. `gone`, with no `n`: none of the time from `from` to `to` was still kept by then.
 * `weeks`: the count came from the learning loops' weekly counts (CountedWeeksSchema), with `n`
 * the weeks shown added up, or `hidden` when none showed. Every field but the times is optional,
 * so a check counted before any of them still reads.
 */
export const CountedSchema = z.object({
  n: z.number().int().min(0).optional(),
  units: z.number().min(0).optional(),
  brands: z.number().int().min(0).optional(),
  hidden: z.boolean().optional(),
  capped: z.boolean().optional(),
  backTo: Canonical.optional(),
  gone: z.boolean().optional(),
  weeks: CountedWeeksSchema.optional(),
  from: Canonical,
  to: Canonical,
  at: Canonical,
});
export type Counted = z.infer<typeof CountedSchema>;

/**
 * A count only the people who run this copy's own learning loop see (decision 14): a purpose's
 * units from every brand's meter, or a count from the loops' weekly counts across brands.
 */
export function isOperatorCounted(c: { units?: unknown; weeks?: unknown } | null | undefined): boolean {
  return !!c && (c.units !== undefined || c.weeks !== undefined);
}

export const CHECK_KINDS = ["date", "after_task"] as const;
export const MEASURE_WHICH = ["first", "then"] as const;
export type MeasureWhich = (typeof MEASURE_WHICH)[number];
/** The setBy of a check a measure set. */
export const SET_BY_MEASURE = "measure";

/**
 * One check slot: on a date, or when another task is done. `setBy` is a person's user id, or
 * "measure" when a measure set it (always a date check), with `which` measure it asks about.
 */
export const CheckSchema = z
  .object({
    kind: z.enum(CHECK_KINDS),
    /** When it is due; null on an after_task check, which is due once the task it waits for is done. */
    at: Canonical.nullable(),
    taskId: WorkTaskIdSchema.nullable(),
    note: z.string().max(WORK_LIMITS.checkNote),
    setBy: MemberId,
    setAt: Canonical,
    which: z.enum(MEASURE_WHICH).nullable(),
    counted: CountedSchema.nullable().optional(),
  })
  .superRefine((ch, c) => {
    const issue = (path: string, message: string) => c.addIssue({ code: "custom", path: [path], message });
    if (ch.kind === "date" && (ch.at === null || ch.taskId !== null)) issue("at", "a date check has a time and no task");
    if (ch.kind === "after_task" && (ch.at !== null || ch.taskId === null)) issue("taskId", "an after_task check names a task and no time");
    const byMeasure = ch.setBy === SET_BY_MEASURE;
    if (byMeasure !== (ch.which !== null)) issue("which", "only a measure's check says which measure");
    if (byMeasure && ch.kind !== "date") issue("kind", "a measure's check is on a date");
    if (!byMeasure && ch.counted != null) issue("counted", "only a measure's check keeps a count");
  });
export type WorkCheck = z.infer<typeof CheckSchema>;

export const READS = ["better", "same", "worse", "too_soon"] as const;
export type WorkRead = (typeof READS)[number];

// --- Changes -----------------------------------------------------------------------------------

/**
 * The fields a change row names. "added" is the task's first row (after: its ref, title and origin
 * kind), "deleted" its last (before: the same).
 */
export const WORK_CHANGE_FIELDS = [
  "added",
  "deleted",
  "title",
  "description",
  "notes",
  "status",
  "stage",
  "mustHave",
  "brandId",
  "organisationId",
  "ref",
  "links",
  "blockedBy",
  "waitingOn",
  "ideaId",
  "ideaBrandId",
  "clipping",
  "typedLinks",
  "measure",
  "check",
] as const;
export type WorkChangeField = (typeof WORK_CHANGE_FIELDS)[number];

const ShortValue = z.union([z.string().max(WORK_LIMITS.recentValue), z.number(), z.boolean(), z.null()]);

/** One of a task's last 20 changes, kept on the task: the short fields keep their value before and after. */
export const RecentSchema = z.object({ at: Canonical, field: z.enum(WORK_CHANGE_FIELDS), who: WhoSchema, before: ShortValue.optional(), after: ShortValue.optional() });
export type WorkRecent = z.infer<typeof RecentSchema>;

// --- Tasks -------------------------------------------------------------------------------------

/**
 * The stored `open`: not Done or Dropped, or Done while a measure's check still waits for its read,
 * so the (organisationId, open, closedAt) read finds the task when its check comes due.
 */
export function workTaskOpen(t: { status: WorkStatus; check: Pick<WorkCheck, "setBy"> | null }): boolean {
  if (!isClosedStatus(t.status)) return true;
  return t.status === "done" && t.check?.setBy === SET_BY_MEASURE;
}

/**
 * On the Open list and in its count (the plan's small call): not Done or Dropped, or Done while
 * its measure's check is due. A Done task whose check is still to come is closed until then.
 */
export function onOpenList(t: { status: WorkStatus; check: Pick<WorkCheck, "setBy" | "at"> | null }, now: Date): boolean {
  if (!isClosedStatus(t.status)) return true;
  return t.status === "done" && t.check?.setBy === SET_BY_MEASURE && t.check.at !== null && Date.parse(t.check.at) <= now.getTime();
}

export const WorkTaskSchema = z
  .object({
    id: WorkTaskIdSchema,
    organisationId: OrganisationIdSchema,
    /** The brand it names; null for a whole business task. */
    brandId: TenantId.nullable(),
    /** The brand it was added from: its region and, for a whole business task, its time zone. */
    addedFrom: TenantId,
    /** The regional database it is kept in. Never changes. */
    region: RegionSchema,
    ref: WorkRefSchema,
    title: oneLine(WORK_LIMITS.title).min(1),
    description: z.string().max(WORK_LIMITS.description),
    notes: z.string().max(WORK_LIMITS.notes),
    status: z.enum(WORK_STATUSES),
    open: z.boolean(),
    stage: z.enum(COMPANY_STAGE_IDS).nullable(),
    mustHave: z.boolean(),
    links: z.array(WorkLinkSchema).max(WORK_LIMITS.links),
    blockedBy: z.array(WorkTaskIdSchema).max(WORK_LIMITS.blockedBy),
    waitingOn: oneLine(WORK_LIMITS.waitingOn).nullable(),
    /** The idea this task became (Make it an idea), and the brand it is in. */
    ideaId: PlainId.nullable(),
    ideaBrandId: TenantId.nullable(),
    clipping: ClippingSchema.nullable(),
    typedLinks: z.array(TypedLinkSchema).max(WORK_LIMITS.typedLinks),
    measure: MeasureSchema.nullable(),
    origin: OriginSchema,
    check: CheckSchema.nullable(),
    /** check !== null, so checks are found by equality alone. */
    hasCheck: z.boolean(),
    recent: z.array(RecentSchema).max(WORK_LIMITS.recent),
    createdAt: Canonical,
    updatedAt: Canonical,
    /** When it went Done or Dropped; null while open (never missing: the list orders by it). */
    closedAt: Canonical.nullable(),
  })
  .superRefine((t, c) => {
    const issue = (path: string, message: string) => c.addIssue({ code: "custom", path: [path], message });
    if (t.hasCheck !== (t.check !== null)) issue("hasCheck", "hasCheck says whether there is a check");
    if (isClosedStatus(t.status) !== (t.closedAt !== null)) issue("closedAt", "a Done or Dropped task has closedAt, an open one null");
    if (t.open !== workTaskOpen(t)) issue("open", "open follows the status and a measure's check");
    if ((t.ideaId === null) !== (t.ideaBrandId === null)) issue("ideaBrandId", "an idea names its brand");
    if (t.blockedBy.includes(t.id) || new Set(t.blockedBy).size !== t.blockedBy.length) issue("blockedBy", "a task never blocks itself, and names each blocker once");
    if (t.check?.taskId === t.id) issue("check", "a task never waits for itself");
    if (t.check?.setBy === SET_BY_MEASURE && (!t.measure || t.measure.kind === "done")) issue("check", "a measure's check needs a measure that isn't Done is the win");
  });
export type WorkTask = z.infer<typeof WorkTaskSchema>;

// --- Decisions ---------------------------------------------------------------------------------

export const DECISION_OPTION_IDS = ["a", "b", "c", "d"] as const;
export type DecisionOptionId = (typeof DECISION_OPTION_IDS)[number];

export const PLAN_APPROVAL_QUESTION = "Approve the plan";
export const PLAN_APPROVAL_OPTIONS = [
  { id: "a", label: "Approve" },
  { id: "b", label: "Change it" },
  { id: "c", label: "Not now" },
] as const satisfies ReadonlyArray<{ id: DecisionOptionId; label: string }>;

/**
 * A plan approval's question, in any case or spacing: nobody drafts or recommends one. Read in
 * time that grows with its length only: anything longer than a question may be is not one, and
 * the trailing marks are stripped by a loop (an anchored regex backtracks over a long run of them).
 */
export function isPlanApprovalQuestion(q: string): boolean {
  const t = q.trim();
  if (t.length > WORK_LIMITS.question) return false;
  const s = t.toLowerCase().replace(/\s+/g, " ");
  let end = s.length;
  while (end > 0 && ".?!".includes(s[end - 1]!)) end -= 1;
  return s.slice(0, end) === PLAN_APPROVAL_QUESTION.toLowerCase();
}

/** Worked out, never sent: whether the choice took the recommended option; null with no choice or no recommendation. */
export function agreedOf(d: { recommended: { option: string } | null; chosen: { option: string } | null }): boolean | null {
  return d.recommended && d.chosen ? d.recommended.option === d.chosen.option : null;
}

export const DecisionSchema = z
  .object({
    question: oneLine(WORK_LIMITS.question).min(1),
    options: z
      .array(z.object({ id: z.enum(DECISION_OPTION_IDS), label: oneLine(WORK_LIMITS.optionLabel).min(1) }))
      .min(2)
      .max(4),
    recommended: z
      .object({
        option: z.enum(DECISION_OPTION_IDS),
        by: z.object({ kind: z.enum(["vizzy", "coding_agent"]), name: oneLine(80).min(1).optional() }),
        reason: z.string().min(1).max(WORK_LIMITS.reason),
      })
      .nullable(),
    chosen: z.object({ option: z.enum(DECISION_OPTION_IDS), by: MemberId }).nullable(),
    agreed: z.boolean().nullable(),
    why: z.string().max(WORK_LIMITS.why).nullable(),
    /** The decision row a changed mind replaces: a new row, the first kept. */
    replaces: WorkLogIdSchema.nullable(),
    /** On a plan approval: the plan link and the version it approves. */
    plan: z.object({ url: PlanUrlSchema, version: oneLine(WORK_LIMITS.planVersion).min(1).optional() }).nullable(),
  })
  .superRefine((d, c) => {
    const issue = (path: string, message: string) => c.addIssue({ code: "custom", path: [path], message });
    if (d.options.some((o, i) => o.id !== DECISION_OPTION_IDS[i])) issue("options", "options are a, b, c and d, in order");
    const ids = new Set(d.options.map((o) => o.id));
    if (d.recommended && !ids.has(d.recommended.option)) issue("recommended", "the recommended pick is one of the options");
    if (d.chosen && !ids.has(d.chosen.option)) issue("chosen", "the choice is one of the options");
    if (d.agreed !== agreedOf(d)) issue("agreed", "agreed is worked out from the pick and the choice");
    if (d.plan) {
      if (d.question !== PLAN_APPROVAL_QUESTION) issue("question", `a plan approval asks "${PLAN_APPROVAL_QUESTION}"`);
      if (d.options.length !== PLAN_APPROVAL_OPTIONS.length || d.options.some((o, i) => o.label !== PLAN_APPROVAL_OPTIONS[i]!.label)) {
        issue("options", "a plan approval's options are Approve, Change it and Not now");
      }
      if (d.recommended) issue("recommended", "nobody recommends approving a plan");
    } else if (isPlanApprovalQuestion(d.question)) {
      issue("plan", "a plan approval names the plan link and version it approves");
    }
  });
export type WorkDecision = z.infer<typeof DecisionSchema>;

// --- Log rows ----------------------------------------------------------------------------------

export const WORK_LOG_KINDS = ["entry", "change", "check", "decision"] as const;
export type WorkLogKind = (typeof WORK_LOG_KINDS)[number];

export const ENTRY_STATES = ["doing", "done", "blocked", "waiting"] as const;
export type EntryState = (typeof ENTRY_STATES)[number];

export const CHECK_ACTIONS = ["checked", "look_again", "read"] as const;
export type CheckAction = (typeof CHECK_ACTIONS)[number];

const RowBase = {
  id: WorkLogIdSchema,
  organisationId: OrganisationIdSchema,
  brandId: TenantId.nullable(),
  region: RegionSchema,
  /** The day it belongs to, in the time zone of the brand it was written from. */
  day: DaySchema,
  at: Canonical,
  source: WorkSourceSchema,
};

/** A check marked, moved on or read. A read is taken only on a measure's check. */
export const CheckRowSchema = z
  .object({
    action: z.enum(CHECK_ACTIONS),
    kind: z.enum(CHECK_KINDS),
    /** When the check was due (null on an after_task check). */
    at: Canonical.nullable(),
    /** The next check it set: Look again, Tomorrow, or Too soon to tell's 7 days on. */
    next: Canonical.nullable(),
    measureKind: z.enum(MEASURE_KINDS).nullable(),
    which: z.enum(MEASURE_WHICH).nullable(),
    counted: CountedSchema.nullable(),
    read: z.enum(READS).nullable(),
  })
  .superRefine((r, c) => {
    const onMeasure = r.which !== null;
    if (onMeasure !== (r.measureKind !== null)) c.addIssue({ code: "custom", path: ["measureKind"], message: "a measure's check names its kind and which" });
    if (r.measureKind === "done") c.addIssue({ code: "custom", path: ["measureKind"], message: "Done is the win has no check" });
    if ((r.action === "read") !== (r.read !== null)) c.addIssue({ code: "custom", path: ["read"], message: "a read row carries the read, and only it" });
    if (r.read !== null && !onMeasure) c.addIssue({ code: "custom", path: ["read"], message: "a read is taken only on a measure's check" });
    if (!onMeasure && r.counted !== null) c.addIssue({ code: "custom", path: ["counted"], message: "only a measure's check keeps a count" });
  });
export type WorkCheckRow = z.infer<typeof CheckRowSchema>;

export const WorkLogRowSchema = z.discriminatedUnion("kind", [
  z.object({
    ...RowBase,
    kind: z.literal("entry"),
    taskId: WorkTaskIdSchema.nullable(),
    workstream: oneLine(WORK_LIMITS.workstream).min(1),
    state: z.enum(ENTRY_STATES),
    note: z.string().max(WORK_LIMITS.entryNote),
    links: z.array(WorkLinkSchema).max(WORK_LIMITS.entryLinks),
  }),
  z.object({
    ...RowBase,
    kind: z.literal("change"),
    taskId: WorkTaskIdSchema,
    field: z.enum(WORK_CHANGE_FIELDS),
    /** The value before and after, each at its field's own cap, so text keeps its full words. */
    before: z.unknown(),
    after: z.unknown(),
  }),
  z.object({ ...RowBase, kind: z.literal("check"), taskId: WorkTaskIdSchema, check: CheckRowSchema }),
  z.object({ ...RowBase, kind: z.literal("decision"), taskId: WorkTaskIdSchema, decision: DecisionSchema }),
]);
export type WorkLogRow = z.infer<typeof WorkLogRowSchema>;
export type WorkLogRowOf<K extends WorkLogKind> = Extract<WorkLogRow, { kind: K }>;
