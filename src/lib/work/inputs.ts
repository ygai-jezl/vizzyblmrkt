import { z } from "zod";
import { MEANINGS, type MeaningKey } from "@/lib/metrics/meanings";
import { COMPANY_STAGE_IDS } from "./stages";
import {
  ClippingSchema,
  DaySchema,
  DECISION_OPTION_IDS,
  ENTRY_STATES,
  LookSchema,
  MAX_WORK_REF,
  READS,
  RUNS_BETTER_WHAT,
  TypedLinkSchema,
  UsedCountsSchema,
  WORK_LIMITS,
  WORK_STATUSES,
  WorkLinkSchema,
  WorkLogIdSchema,
  PlanUrlSchema,
} from "./types";

/**
 * What a person may send Work's admin routes (ADR-0018), checked strictly: a key the shape
 * doesn't name is refused, so origin, `proposed`, `setBy`, `recommended`, an organisation or a
 * region can never come from a request. The server sets those (src/lib/work/service.ts).
 *
 * Pure: the add page and the task page check their forms with the same shapes.
 */

const MEANING_KEYS = Object.keys(MEANINGS) as [MeaningKey, ...MeaningKey[]];
const TenantId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const PlainId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
export const RefSchema = z.number().int().min(1).max(MAX_WORK_REF);
/** HH:MM on a 24 hour clock. */
export const TimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), { message: "one line" });

/**
 * Which screen sent a change, kept as the log row's tool (Review's Start is how work_ready's picks
 * are counted). Never who: the server knows that.
 */
export const WORK_VIA = ["work_page", "quick_add", "work_list", "review_ready", "review_check", "today"] as const;
export type WorkVia = (typeof WORK_VIA)[number];

// --- Checks ------------------------------------------------------------------------------------

/** A check a person sets: on a day (08:00 brand time unless a time is given), or when another task is done. */
export const CheckInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("date"), day: DaySchema, time: TimeSchema.optional(), note: z.string().trim().max(WORK_LIMITS.checkNote).optional() }).strict(),
  z.object({ kind: z.literal("after_task"), ref: RefSchema, note: z.string().trim().max(WORK_LIMITS.checkNote).optional() }).strict(),
]);
export type CheckInput = z.infer<typeof CheckInputSchema>;

// --- How we'll know it worked ------------------------------------------------------------------

const UsedInput = { kind: z.literal("used"), counts: UsedCountsSchema, look: LookSchema };
const MovesInput = {
  kind: z.literal("moves"),
  meaning: z.enum(MEANING_KEYS),
  /** Starts from the meaning's better when left out. */
  direction: z.enum(["up", "down"]).optional(),
  word: oneLine(WORK_LIMITS.word).min(1).optional(),
  look: LookSchema,
};
const RunsBetterInput = { kind: z.literal("runs_better"), what: z.enum(RUNS_BETTER_WHAT), look: LookSchema };

export const ThenInputSchema = z.discriminatedUnion("kind", [z.object(UsedInput).strict(), z.object(MovesInput).strict(), z.object(RunsBetterInput).strict()]);
export type ThenInput = z.infer<typeof ThenInputSchema>;

/** A measure as a person sets it: the kind and its fields, and an optional then. Never setBy, setAt or proposed. */
export const MeasureInputSchema = z.discriminatedUnion("kind", [
  z.object({ ...UsedInput, then: ThenInputSchema.nullable().optional() }).strict(),
  z.object({ ...MovesInput, then: ThenInputSchema.nullable().optional() }).strict(),
  z.object({ ...RunsBetterInput, then: ThenInputSchema.nullable().optional() }).strict(),
  z.object({ kind: z.literal("done") }).strict(),
]);
export type MeasureInput = z.infer<typeof MeasureInputSchema>;

// --- Tasks -------------------------------------------------------------------------------------

/** The task fields a person sets, on add and on edit. */
const TaskFields = {
  title: oneLine(WORK_LIMITS.title).min(1),
  description: z.string().max(WORK_LIMITS.description),
  notes: z.string().max(WORK_LIMITS.notes),
  status: z.enum(WORK_STATUSES),
  stage: z.enum(COMPANY_STAGE_IDS).nullable(),
  mustHave: z.boolean(),
  /** The brand it is for; null for the whole business. */
  brandId: TenantId.nullable(),
  links: z.array(WorkLinkSchema).max(WORK_LIMITS.links),
  /** The refs of the tasks it waits for. */
  blockedBy: z.array(RefSchema).max(WORK_LIMITS.blockedBy),
  waitingOn: oneLine(WORK_LIMITS.waitingOn).nullable(),
  clipping: ClippingSchema.nullable(),
  typedLinks: z.array(TypedLinkSchema).max(WORK_LIMITS.typedLinks),
  measure: MeasureInputSchema.nullable(),
  check: CheckInputSchema.nullable(),
};

const OptionalTaskFields = {
  description: TaskFields.description.optional(),
  notes: TaskFields.notes.optional(),
  status: TaskFields.status.optional(),
  stage: TaskFields.stage.optional(),
  mustHave: TaskFields.mustHave.optional(),
  brandId: TaskFields.brandId.optional(),
  links: TaskFields.links.optional(),
  blockedBy: TaskFields.blockedBy.optional(),
  waitingOn: TaskFields.waitingOn.optional(),
  clipping: TaskFields.clipping.optional(),
  typedLinks: TaskFields.typedLinks.optional(),
  measure: TaskFields.measure.optional(),
  check: TaskFields.check.optional(),
  via: z.enum(WORK_VIA).optional(),
};

export const AddTaskBodySchema = z.object({ title: TaskFields.title, ...OptionalTaskFields }).strict();
export type AddTaskBody = z.infer<typeof AddTaskBodySchema>;

/** An edit: any of the fields, and the idea the task became (Make it an idea), or null to unlink it. */
export const EditTaskBodySchema = z
  .object({
    title: TaskFields.title.optional(),
    ...OptionalTaskFields,
    idea: z.object({ brandId: TenantId, ideaId: PlainId }).strict().nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).some((k) => k !== "via"), { message: "nothing to change" });
export type EditTaskBody = z.infer<typeof EditTaskBodySchema>;

// --- The list's filters ------------------------------------------------------------------------

export const LIST_STATUSES = ["open", "all", "closed", ...WORK_STATUSES] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];
export const LIST_KINDS = ["used", "moves", "runs_better", "done", "none"] as const;

export interface WorkFilters {
  /** A brand's id, "none" for whole business tasks, or null for every brand. */
  brand: string | null;
  stage: (typeof COMPANY_STAGE_IDS)[number] | null;
  status: ListStatus;
  mustHave: boolean;
  due: boolean;
  kind: (typeof LIST_KINDS)[number] | null;
}

/** The list's filters from the address: anything unknown is left out, so a stale link still opens. */
export function filtersOf(params: URLSearchParams): WorkFilters {
  const pick = <T extends string>(v: string | null, of: readonly T[]): T | null => (v !== null && (of as readonly string[]).includes(v) ? (v as T) : null);
  const brand = params.get("brand");
  return {
    brand: brand && (brand === "none" || TenantId.safeParse(brand).success) ? brand : null,
    stage: pick(params.get("stage"), COMPANY_STAGE_IDS),
    status: pick(params.get("status"), LIST_STATUSES) ?? "open",
    mustHave: params.get("must") === "1",
    due: params.get("due") === "1",
    kind: pick(params.get("kind"), LIST_KINDS),
  };
}

// --- Checks, the Log, decisions and import -----------------------------------------------------

export const CheckActionBodySchema = z
  .object({
    ref: RefSchema,
    action: z.enum(["checked", "look_again", "read"]),
    read: z.enum(READS).optional(),
    /** Look again, or Too soon to tell, on another day: 08:00 brand time unless a time is given. */
    day: DaySchema.optional(),
    time: TimeSchema.optional(),
    via: z.enum(WORK_VIA).optional(),
  })
  .strict()
  .refine((b) => (b.action === "read") === (b.read !== undefined), { message: "a read goes with action read, and only with it", path: ["read"] })
  .refine((b) => b.time === undefined || b.day !== undefined, { message: "a time goes with a day", path: ["time"] });
export type CheckActionBody = z.infer<typeof CheckActionBodySchema>;

export const LogEntryBodySchema = z
  .object({
    workstream: oneLine(WORK_LIMITS.workstream).min(1),
    state: z.enum(ENTRY_STATES),
    note: z.string().trim().max(WORK_LIMITS.entryNote).optional(),
    links: z.array(WorkLinkSchema).max(WORK_LIMITS.entryLinks).optional(),
    /** The task it is about. */
    ref: RefSchema.optional(),
    /** The brand it is for; null for the whole business. Members always log for their own brand. */
    brandId: TenantId.nullable().optional(),
  })
  .strict();
export type LogEntryBody = z.infer<typeof LogEntryBodySchema>;

export const DecisionBodySchema = z
  .object({
    ref: RefSchema,
    question: oneLine(WORK_LIMITS.question).min(1).optional(),
    /** The options' labels, 2 to 4; they become a, b, c and d. A plan approval's are fixed. */
    options: z.array(oneLine(WORK_LIMITS.optionLabel).min(1)).min(2).max(4).optional(),
    chosen: z.enum(DECISION_OPTION_IDS).nullable().optional(),
    why: z.string().trim().max(WORK_LIMITS.why).optional(),
    replaces: WorkLogIdSchema.optional(),
    /** A plan approval: the plan link on the task, and the version it approves. */
    plan: z.object({ url: PlanUrlSchema, version: oneLine(WORK_LIMITS.planVersion).min(1).optional() }).strict().optional(),
  })
  .strict()
  .refine((b) => b.plan !== undefined || (b.question !== undefined && b.options !== undefined), { message: "a decision has a question and 2 to 4 options", path: ["question"] });
export type DecisionBody = z.infer<typeof DecisionBodySchema>;

/** The fields an imported column can fill. */
export const IMPORT_FIELDS = ["title", "ref", "mustHave", "description", "notes", "status", "clipping", "stage", "brand", "check", "skip"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** The most an import's body may be: 1,000 rows of a full Backlog tab. */
export const IMPORT_MAX_BYTES = 3_000_000;

export const ImportBodySchema = z
  .object({
    mode: z.enum(["preview", "import"]),
    /** The CSV file's text, or what was pasted from Google Sheets (tab separated). */
    text: z.string().max(IMPORT_MAX_BYTES),
    /** The file's name, as the task page shows it ("Imported from Backlog.csv"). */
    file: z.string().max(400).optional(),
    /** A column's header and the field it fills, where the person changed what Work matched. */
    mapping: z.record(z.string().max(200), z.enum(IMPORT_FIELDS)).optional(),
    /** The brand the rows are for when the sheet has no Brand column; null for the whole business. */
    brandId: TenantId.nullable().optional(),
  })
  .strict();
export type ImportBody = z.infer<typeof ImportBodySchema>;
