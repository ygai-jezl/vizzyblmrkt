import { z } from "zod";
import type { AgentAction, AgentActionId } from "@/lib/types/agentAction";
import { DECISION_OPTION_IDS, ENTRY_STATES, isPlanApprovalQuestion, WORK_LIMITS, WorkLinkSchema, WorkRefSchema, WorkTaskIdSchema, type DecisionOptionId, type EntryState, type WorkLink } from "./types";

/**
 * A Log note or a decision Vizzy drafts for Work in chat (ADR-0020, plan group 5): one agent action
 * in the agent_actions of the brand whose chat made it, which a person opens from the chat's card,
 * checks and saves. Nothing is in the Log until they do.
 *
 * - draft_work_log (`work_log.draft`): a workstream, its state, a note, up to 3 links and the task
 *   it is about. The card opens the Log with the box filled in; the person can change it, then
 *   saves it to today's log.
 * - draft_work_decision (`work_decision.draft`): the question on a task, 2 to 4 options, and
 *   Vizzy's pick with its reason. The card opens the task; the person chooses, and the decision
 *   row keeps Vizzy's pick as its recommendation, so `agreed` says where people overrule it. Vizzy
 *   never drafts Approve the plan: that gate stays with people, and the shape refuses it.
 *
 * The draft's target is the log row it becomes (work_log:<id>), and its details are kept once
 * saved (clearDetailsOnClose false), so what Vizzy drafted stays beside what the person saved. An
 * unsaved draft is set aside (expired) after 7 days. Vizzy's words are data shown as written,
 * never instructions.
 *
 * Pure: zod and plain data, so the Log and the task page use it in the browser.
 */

export const WORK_LOG_DRAFT_ACTION = "work_log.draft";
export const WORK_DECISION_DRAFT_ACTION = "work_decision.draft";
/** How long a draft waits to be saved before it is set aside. */
export const DRAFT_DAYS = 7;

const TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), { message: "one line" });

/** A Log note as Vizzy drafted it. */
export const LogDraftSchema = z
  .object({
    workstream: oneLine(WORK_LIMITS.workstream).min(1),
    state: z.enum(ENTRY_STATES),
    note: z.string().trim().max(WORK_LIMITS.entryNote),
    links: z.array(WorkLinkSchema).max(WORK_LIMITS.entryLinks),
    /** The task it is about, by id and by its ref when drafted. */
    taskId: WorkTaskIdSchema.nullable(),
    ref: WorkRefSchema.nullable(),
    /** The brand it is for; null for the whole business. */
    brandId: z.string().regex(TENANT_ID).nullable(),
  })
  .strict()
  .refine((d) => (d.taskId === null) === (d.ref === null), { message: "a task is named by its id and its ref", path: ["ref"] });
export type LogDraft = z.infer<typeof LogDraftSchema>;

/** A decision as Vizzy drafted it: never Approve the plan. */
export const DecisionDraftSchema = z
  .object({
    taskId: WorkTaskIdSchema,
    ref: WorkRefSchema,
    question: oneLine(WORK_LIMITS.question).min(1),
    options: z
      .array(z.object({ id: z.enum(DECISION_OPTION_IDS), label: oneLine(WORK_LIMITS.optionLabel).min(1) }).strict())
      .min(2)
      .max(4),
    /** Vizzy's pick and why, or null when it picks none. */
    recommended: z.object({ option: z.enum(DECISION_OPTION_IDS), reason: z.string().trim().min(1).max(WORK_LIMITS.reason) }).strict().nullable(),
  })
  .strict()
  .superRefine((d, c) => {
    if (isPlanApprovalQuestion(d.question)) c.addIssue({ code: "custom", path: ["question"], message: "Vizzy never drafts Approve the plan" });
    if (d.options.some((o, i) => o.id !== DECISION_OPTION_IDS[i])) c.addIssue({ code: "custom", path: ["options"], message: "options are a, b, c and d, in order" });
    if (d.recommended && !d.options.some((o) => o.id === d.recommended!.option)) c.addIssue({ code: "custom", path: ["recommended"], message: "the pick is one of the options" });
  });
export type DecisionDraft = z.infer<typeof DecisionDraftSchema>;

/** A Work Log draft's note, or null when the action is another kind or its proposal can't be read. */
export function logDraftOf(a: Pick<AgentAction, "action" | "proposal">): LogDraft | null {
  if (a.action !== WORK_LOG_DRAFT_ACTION) return null;
  const parsed = LogDraftSchema.safeParse((a.proposal as { entry?: unknown } | null)?.entry);
  return parsed.success ? parsed.data : null;
}

/** A Work decision draft, or null when the action is another kind or its proposal can't be read. */
export function decisionDraftOf(a: Pick<AgentAction, "action" | "proposal">): DecisionDraft | null {
  if (a.action !== WORK_DECISION_DRAFT_ACTION) return null;
  const parsed = DecisionDraftSchema.safeParse((a.proposal as { decision?: unknown } | null)?.decision);
  return parsed.success ? parsed.data : null;
}

/** Where a drafted note opens: today's Log, with the box filled in. */
export function logDraftHref(id: AgentActionId): string {
  return `/admin/work/log?draft=${id}`;
}

/** Where a drafted decision opens: its task, with the draft above its decisions. */
export function decisionDraftHref(ref: number, id: AgentActionId): string {
  return `/admin/work/${ref}?decision=${id}#decisions`;
}

/** The Log box's line for a drafted note: "Workstream: note". */
export function logDraftLine(d: Pick<LogDraft, "workstream" | "note">): string {
  return d.note ? `${d.workstream}: ${d.note}` : d.workstream;
}

/** What the person changed from Vizzy's draft before saving it, for the draft's result. Empty when saved as drafted. */
export function editedLogFields(
  d: LogDraft,
  saved: { workstream: string; state: EntryState; note: string; taskId: string | null; brandId: string | null; links: readonly WorkLink[] },
): string[] {
  const out: string[] = [];
  if (saved.workstream.trim() !== d.workstream) out.push("workstream");
  if (saved.state !== d.state) out.push("state");
  if (saved.note.trim() !== d.note) out.push("note");
  if (saved.taskId !== d.taskId) out.push("task");
  if (saved.taskId === null && d.taskId === null && saved.brandId !== d.brandId) out.push("brandId");
  if (JSON.stringify(saved.links) !== JSON.stringify(d.links)) out.push("links");
  return out;
}

/** The option a pick names: its letter ("b") or its label, ignoring case. */
export function optionOf(options: ReadonlyArray<{ id: DecisionOptionId; label: string }>, pick: string): DecisionOptionId | null {
  const p = pick.trim().toLowerCase().replace(/^option\s+/, "");
  if (!p) return null;
  const byId = options.find((o) => o.id === p);
  if (byId) return byId.id;
  return options.find((o) => o.label.trim().toLowerCase() === p)?.id ?? null;
}

/** The words a drafted note or decision shows, and the chat's card says. */
export const DRAFT_COPY = {
  logDrafted: "Vizzy drafted this note. Nothing is in the Log until you save it, and you can change it first.",
  logSave: "Save to today's log",
  logLeave: "Leave it",
  logSaved: "Saved to today's log.",
  logDraftGone: "That note from Vizzy was saved already, or it was set aside after 7 days. Ask Vizzy to draft it again if you still need it.",
  decisionDrafted: "Vizzy drafted this decision. Nothing is recorded until you choose.",
  decisionSave: "Save the decision",
  decisionLeave: "Leave it",
  decisionDraftGone: "That decision from Vizzy was saved already, or it was set aside after 7 days. Ask Vizzy to draft it again if you still need it.",
  vizzyPick: "Vizzy's pick",
  noPick: "Vizzy didn't pick one.",
  cardLogTitle: "Log note, drafted",
  cardLogNote: "Nothing is in the Log until you save it.",
  cardDecisionTitle: "Decision, drafted",
  cardDecisionNote: "Nothing is recorded until you choose.",
  cardDecisionCta: "Choose",
  cardSuggestionTitle: "Task suggestion",
  cardSuggestionNote: "Nothing goes on Work until someone adds it in Review.",
  cardSuggestionCta: "Open Review",
} as const;

/** Vizzy's pick on a drafted decision, in words: "Vizzy's pick: By email. It reaches the people who asked." */
export function pickLine(d: Pick<DecisionDraft, "options" | "recommended">): string {
  if (!d.recommended) return DRAFT_COPY.noPick;
  const label = d.options.find((o) => o.id === d.recommended!.option)?.label ?? "";
  return `${DRAFT_COPY.vizzyPick}: ${label}. ${d.recommended.reason}`;
}
