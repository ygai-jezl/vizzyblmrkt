import { z } from "zod";
import { DECLINE_WHY, type AgentAction, type AgentActionId, type DeclineWhy } from "@/lib/types/agentAction";
import { MeasureInputSchema, type AddTaskBody, type MeasureInput, type ThenInput } from "./inputs";
import { MEASURE_KIND_LABEL, partLine } from "./screenWords";
import { COMPANY_STAGE_IDS, stageById, type CompanyStage } from "./stages";
import { MEASURE_KINDS, startingDirection, TypedLinkSchema, WORK_LIMITS, type MeasureKind, type ThenMeasure, type TypedLink, type WorkStatus } from "./types";
import { WORK_STATUS_LABEL } from "./words";

/**
 * A task Vizzy suggests for Work (ADR-0020, plan decision 10.1): one agent action
 * (`work_task.suggest`) in the agent_actions of the brand whose chat made it. Its `proposal.task`
 * is what Vizzy suggested; once a person adds it, `result.task` is the task as added and
 * `result.edited` names the fields they changed (empty for Add to Work). Work suggestions keep
 * their details when decided (clearDetailsOnClose false), so the pair survives for a later edits
 * learner, and a dismissal keeps the reason the person tapped (`declined.why`).
 *
 * Work data never goes under `fields` (FIELD_VALUES_KEY is for a person's field values, which the
 * erase blanks in place). The action's target is the id the task takes once added, so the
 * suggestion and the task join both ways.
 *
 * A suggestion never sets Must have: it stays with people, and the shape refuses it. A person can
 * tick it while adding, and that isn't an edit. Vizzy's words (the title, the description and its
 * why) are data shown as written, never instructions.
 *
 * Pure: zod, plain data and pure helpers, so Review's cards and the add page use it in the browser.
 */

export const WORK_SUGGEST_ACTION = "work_task.suggest";
/** How long a suggestion waits in Review before it is set aside (expired). */
export const SUGGESTION_DAYS = 30;
/** After Not now, how long before Vizzy may suggest the same task again. */
export const NOT_NOW_DAYS = 30;

const TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), { message: "one line" });

/** The longest "from" line on a card, such as "from today's log: Pricing research". */
export const FROM_MAX = 120;

/** What Vizzy suggested: the task's fields, the kind of win it proposes with its reason, and where it came from. */
export const SuggestedTaskSchema = z
  .object({
    title: oneLine(WORK_LIMITS.title).min(1),
    description: z.string().max(WORK_LIMITS.description),
    stage: z.enum(COMPANY_STAGE_IDS).nullable(),
    /** The brand it is for; null for the whole business. */
    brandId: z.string().regex(TENANT_ID).nullable(),
    typedLinks: z.array(TypedLinkSchema).max(WORK_LIMITS.typedLinks),
    /** How we'll know it worked, as Vizzy would set it; null when it suggests only a kind. */
    measure: MeasureInputSchema.nullable(),
    /** The kind of win Vizzy proposes, with its reason, kept beside the kind the person picks. */
    proposed: z.object({ kind: z.enum(MEASURE_KINDS), reason: oneLine(WORK_LIMITS.proposedReason).min(1) }).strict().nullable(),
    /** Where it came from, set by the server from the evidence, lower case: "from today's log". */
    from: oneLine(FROM_MAX).min(1),
    /** Vizzy's own reason, in its words. */
    why: z.string().trim().max(WORK_LIMITS.why),
  })
  .strict()
  .refine((s) => !s.measure || !s.proposed || s.measure.kind === s.proposed.kind, { message: "the measure is of the kind Vizzy proposes", path: ["measure"] });
export type SuggestedTask = z.infer<typeof SuggestedTaskSchema>;

/** A Work suggestion's task, or null when the action is another kind or its proposal can't be read. */
export function suggestionOf(a: Pick<AgentAction, "action" | "proposal">): SuggestedTask | null {
  if (a.action !== WORK_SUGGEST_ACTION) return null;
  const parsed = SuggestedTaskSchema.safeParse((a.proposal as { task?: unknown } | null)?.task);
  return parsed.success ? parsed.data : null;
}

/** Whether the person sees a suggestion: everything in the organisation view, their own brand's in the brand view (decision 7). */
export function seesSuggestion(scope: { view: "organisation" | "brand"; session: { id: string } }, s: Pick<SuggestedTask, "brandId">): boolean {
  return scope.view === "organisation" || s.brandId === scope.session.id;
}

/**
 * A suggestion that names only a kind of win the task can't keep without more: Used, Moves a
 * number or Runs better need what is counted and when to look, so the card says Vizzy suggests
 * the kind and the person sets the rest on the task. Done is the win needs nothing more.
 */
export function suggestsKindOnly(s: Pick<SuggestedTask, "measure" | "proposed">): boolean {
  return !s.measure && s.proposed !== null && s.proposed.kind !== "done";
}

/**
 * Add to Work: the task exactly as Vizzy suggested it, To do, with no Must have. A suggestion of
 * Done is the win alone is added with that measure, so Vizzy's kind is kept on the task as proposed.
 */
export function addBodyOf(s: SuggestedTask): AddTaskBody {
  return {
    title: s.title,
    ...(s.description ? { description: s.description } : {}),
    status: "todo",
    stage: s.stage,
    brandId: s.brandId,
    typedLinks: s.typedLinks,
    measure: startingMeasureOf(s),
  };
}

// --- What the person changed -------------------------------------------------------------------

/** JSON with sorted keys at every level, leaving out undefined and null. */
function stable(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined && o[k] !== null)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

const partKey = (p: ThenInput | Exclude<MeasureInput, { kind: "done" }>) => {
  const rest: Record<string, unknown> = { ...p };
  delete rest.then;
  if (p.kind === "moves") rest.direction = p.direction ?? startingDirection(p.meaning);
  return rest;
};

/** A measure's content, so two ways of writing the same measure (a direction left to start from better) compare equal. */
export function measureContent(m: MeasureInput | null | undefined): string {
  if (!m) return "null";
  if (m.kind === "done") return stable({ kind: "done" });
  return stable({ ...partKey(m), then: m.then ? partKey(m.then) : null });
}

/**
 * The measure Edit then add starts from: the one Add to Work would keep (Vizzy's measure, or Done
 * is the win for a suggestion of that kind alone), and none for a kind-only suggestion of another
 * kind, whose kind the picker marks Vizzy suggests instead. So an untouched Edit then add sends
 * what Add to Work would.
 */
export function startingMeasureOf(s: Pick<SuggestedTask, "measure" | "proposed">): MeasureInput | null {
  return s.measure ?? (s.proposed?.kind === "done" ? { kind: "done" } : null);
}

/**
 * The fields the person changed from what Vizzy suggested (`result.edited`): title, description,
 * stage, brandId, typedLinks and measure, with "measure.kind" too when the kind of win changed.
 * The measure is compared with what Add to Work keeps (startingMeasureOf), so an untouched Edit
 * then add is the same as Add to Work; on a kind-only suggestion, setting a measure of Vizzy's
 * kind is a measure edit, not a kind change. Must have is never an edit: a suggestion never sets
 * it. Empty for Add to Work.
 */
export function editedFields(s: SuggestedTask, body: AddTaskBody): string[] {
  const out: string[] = [];
  if (body.title.trim() !== s.title) out.push("title");
  if ((body.description ?? "").trim() !== s.description.trim()) out.push("description");
  if ((body.stage ?? null) !== s.stage) out.push("stage");
  if (body.brandId !== undefined && body.brandId !== s.brandId) out.push("brandId");
  if (stable(body.typedLinks ?? []) !== stable(s.typedLinks)) out.push("typedLinks");
  const measure = body.measure ?? null;
  const kept = startingMeasureOf(s);
  if (measureContent(measure) !== measureContent(kept)) out.push("measure");
  const kindWas = s.measure?.kind ?? s.proposed?.kind ?? null;
  // No measure where Add to Work keeps none is no change of kind, even when Vizzy named one.
  const kindChanged = measure ? measure.kind !== kindWas : kept !== null;
  if (kindChanged) out.push("measure.kind");
  return out;
}

// --- Dismissing --------------------------------------------------------------------------------

/** The one tap reasons on Dismiss, in the order drawn. */
export const DECLINE_WHY_LABEL: Record<DeclineWhy, string> = {
  not_now: "Not now",
  not_for_us: "Not for us",
  already_on_it: "Already on it",
  wrong: "Wrong",
};
export const DECLINE_WHY_CHOICES: ReadonlyArray<{ why: DeclineWhy; label: string }> = DECLINE_WHY.map((why) => ({ why, label: DECLINE_WHY_LABEL[why] }));

/** Whether Vizzy may suggest it again: in 30 days after Not now, never after any other reason or none. */
export function againAfter(why: DeclineWhy | null | undefined): "30_days" | "never" {
  return why === "not_now" ? "30_days" : "never";
}

/** The done line after a dismissal, saying whether Vizzy may suggest it again. */
export function dismissedLine(title: string, why: DeclineWhy | null | undefined): string {
  const again = againAfter(why) === "30_days" ? `Vizzy can suggest it again in ${NOT_NOW_DAYS} days.` : "Vizzy won't suggest it again.";
  return why ? `Dismissed “${title}”: ${DECLINE_WHY_LABEL[why]}. ${again}` : `Dismissed “${title}”. ${again}`;
}

/** The done line after Add to Work: "Added to Work as #82 Title, To do." */
export function addedToWorkLine(ref: number, title: string, status: WorkStatus = "todo"): string {
  return `Added to Work as #${ref} ${title}, ${WORK_STATUS_LABEL[status]}.`;
}

// --- The card ----------------------------------------------------------------------------------

/** A Moves a number part with its direction filled in, so it reads as a kept measure does. */
function asPart(p: ThenInput | Exclude<MeasureInput, { kind: "done" }>): ThenMeasure {
  return (p.kind === "moves" ? { ...p, direction: p.direction ?? startingDirection(p.meaning) } : p) as ThenMeasure;
}

/** How we'll know it worked, as the card says it: "Moves a number: click rate up, 7 days after it's done." */
export function suggestedMeasureText(s: Pick<SuggestedTask, "measure" | "proposed">): string | null {
  const m = s.measure;
  if (m) {
    if (m.kind === "done") return `${MEASURE_KIND_LABEL.done}.`;
    const first = partLine(asPart(m));
    return m.then ? `${first} Then ${partLine(asPart(m.then))}` : first;
  }
  return s.proposed ? `${MEASURE_KIND_LABEL[s.proposed.kind]}.` : null;
}

/** "From today's log", as the card's meta line starts it. */
export function fromWords(from: string): string {
  return from ? `${from[0]!.toUpperCase()}${from.slice(1)}` : from;
}

/** The stage as a card shows it: its number and its word. */
export function stageTag(stage: CompanyStage | null): { n: number; label: string } | null {
  const s = stage ? stageById(stage) : undefined;
  return s ? { n: s.n, label: s.label } : null;
}

/** The kind Vizzy proposes, for the add page's Vizzy suggests mark. */
export function proposedOf(s: Pick<SuggestedTask, "measure" | "proposed">): { kind: MeasureKind; reason: string } | null {
  return s.proposed ?? null;
}

/** The ids of the ideas a suggestion names, by "brandId:ideaId". */
export function ideaKeysOf(links: readonly TypedLink[]): string[] {
  return links.filter((l): l is Extract<TypedLink, { kind: "idea" }> => l.kind === "idea").map((l) => `${l.brandId}:${l.ideaId}`);
}

/** The add page's address for Edit then add. */
export function editThenAddHref(id: AgentActionId): string {
  return `/admin/work/new?suggestion=${id}`;
}
