import { z } from "zod";
import { FACT_KINDS } from "@/lib/onboarding/choices";
import { AGENT_ACTION_ID, type AgentActionId } from "./agentAction";

/**
 * Home's Your next action as a card Vizzy writes (NEXT_ACTION_CARD_ENABLED, ADR-0022). The card is
 * data, never code: five components from a YouGrow-only catalog, drawn by our own components.
 *
 * - ActionCard: the card, with 1 to 3 Steps and an optional Note.
 * - Step: one thing to do, with one short line on why in the founder's own terms. It does exactly
 *   one of: a button that carries an action id from the server allowlist (src/lib/nextAction/
 *   actions.ts), ChoiceChips (one quick question), or Progress (a goal the founder named).
 * - ChoiceChips: 2 to 4 answers; an answer can become a fact the founder keeps in About your business.
 * - Progress: a goal on one of the brand's own counts, read from its data when the card is drawn.
 * - Note: one line on what the team just finished.
 *
 * A button never carries a URL or a path: only an id the server resolves. Pure (zod and plain data),
 * so client components can import it.
 */

// --- The actions a button can take -------------------------------------------------------------

/** Open one admin page. The server resolves each to a path from a fixed list (actions.ts). */
export const PAGE_ACTION_IDS = [
  "page.create_launch",
  "page.welcome_email",
  "page.share_waitlist",
  "page.invite_waitlist",
  "page.sending",
  "page.logo",
  "page.voice",
  "page.email_style",
  "page.brand_map",
  "page.start_programme",
  "page.knowledge",
  "page.schedule_post",
  "page.newsletter",
  "page.connect_accounts",
  "page.connect_product",
  "page.learn_product",
  "page.journeys",
  "page.people",
  "page.review",
  "page.about",
] as const;
export type PageActionId = (typeof PAGE_ACTION_IDS)[number];

/** Ask Vizzy one of our own prompts, in the chat on Home. */
export const ASK_ACTION_IDS = [
  "ask.plan_idea",
  "ask.waitlist_page",
  "ask.welcome_email",
  "ask.share_post",
  "ask.plan_posts",
  "ask.newsletter",
  "ask.brand_voice",
  "ask.in_person_signups",
  "ask.own_form",
  "ask.nudge_emails",
  "ask.first_steps",
] as const;
export type AskActionId = (typeof ASK_ACTION_IDS)[number];

export const ACTION_IDS = [...PAGE_ACTION_IDS, ...ASK_ACTION_IDS] as const;
export type ActionId = PageActionId | AskActionId;

export function isActionId(v: unknown): v is ActionId {
  return typeof v === "string" && (ACTION_IDS as readonly string[]).includes(v);
}

/** The counts a goal can follow: the brand's own, read when the card is drawn. */
export const GOAL_METRICS = ["signups", "posts", "newsletters"] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];

export const STEP_KEYS = ["s1", "s2", "s3"] as const;
export type StepKey = (typeof STEP_KEYS)[number];

export const NEXT_ACTION_LIMITS = {
  MAX_STEPS: 3,
  TITLE: 60,
  WHY: 160,
  BUTTON: 28,
  QUESTION: 40,
  CHIP: 28,
  CHIP_FACT: 80,
  MIN_CHIPS: 2,
  MAX_CHIPS: 4,
  NOTE: 120,
  GOAL_MAX: 1_000_000,
  /** The optional reason a founder gives when they dismiss a step. */
  REASON: 140,
  /** Outcomes kept on the card's record, newest first: what the next card reads. */
  OUTCOMES: 30,
  /** Outcomes older than this are dropped when the record is next written. */
  OUTCOME_DAYS: 90,
  /** A dismissed action stays off the card this long. */
  QUIET_DAYS: 30,
  /** Cards written per brand per UTC day, whatever the reason. */
  COMPOSES_PER_DAY: 20,
  /** How long a step's agent action waits before the tick sets it aside. */
  STEP_DAYS: 30,
} as const;

// --- Components --------------------------------------------------------------------------------

const L = NEXT_ACTION_LIMITS;

/** One line of plain text: no line breaks, control characters or angle brackets. */
const line = (max: number, min = 2) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !/[\r\n\u2028\u2029<>]/.test(s) && !/\p{Cc}/u.test(s), { message: "one plain line" });

export const ChoiceOptionSchema = z.object({ label: line(L.CHIP, 1), fact: line(L.CHIP_FACT, 3).nullable() }).strict();
export type ChoiceOption = z.infer<typeof ChoiceOptionSchema>;

export const ChoiceChipsSchema = z
  .object({
    type: z.literal("ChoiceChips"),
    question: line(L.QUESTION),
    options: z.array(ChoiceOptionSchema).min(L.MIN_CHIPS).max(L.MAX_CHIPS),
    /** The kind of fact an answer becomes, or null when it is only recorded as the step's outcome. */
    fact: z.enum(FACT_KINDS).nullable(),
  })
  .strict()
  .superRefine((c, ctx) => {
    c.options.forEach((o, i) => {
      if ((c.fact === null) !== (o.fact === null)) ctx.addIssue({ code: "custom", path: ["options", i, "fact"], message: "a fact line exactly when the question has a fact kind" });
    });
    const labels = c.options.map((o) => o.label.toLowerCase());
    if (new Set(labels).size !== labels.length) ctx.addIssue({ code: "custom", path: ["options"], message: "answers must differ" });
  });
export type ChoiceChips = z.infer<typeof ChoiceChipsSchema>;

export const ProgressSchema = z
  .object({ type: z.literal("Progress"), metric: z.enum(GOAL_METRICS), target: z.number().int().min(1).max(L.GOAL_MAX) })
  .strict();
export type Progress = z.infer<typeof ProgressSchema>;

export const StepSchema = z
  .object({
    type: z.literal("Step"),
    key: z.enum(STEP_KEYS),
    title: line(L.TITLE, 3),
    why: line(L.WHY, 3),
    action: z.enum(ACTION_IDS).nullable(),
    button: line(L.BUTTON).nullable(),
    choices: ChoiceChipsSchema.nullable(),
    progress: ProgressSchema.nullable(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const does = [s.action !== null, s.choices !== null, s.progress !== null].filter(Boolean).length;
    if (does !== 1) ctx.addIssue({ code: "custom", path: ["action"], message: "a step does exactly one thing: a button, a question or a goal" });
    if ((s.action === null) !== (s.button === null)) ctx.addIssue({ code: "custom", path: ["button"], message: "a button's words exactly when it has an action" });
  });
export type Step = z.infer<typeof StepSchema>;

export const NoteSchema = z.object({ type: z.literal("Note"), tone: z.literal("done"), text: line(L.NOTE, 3) }).strict();
export type Note = z.infer<typeof NoteSchema>;

export const ActionCardSchema = z
  .object({
    type: z.literal("ActionCard"),
    v: z.literal(1),
    steps: z.array(StepSchema).min(1).max(L.MAX_STEPS),
    note: NoteSchema.nullable(),
  })
  .strict()
  .superRefine((c, ctx) => {
    c.steps.forEach((s, i) => {
      if (s.key !== STEP_KEYS[i]) ctx.addIssue({ code: "custom", path: ["steps", i, "key"], message: "steps are s1, s2, s3 in order" });
    });
    const actions = c.steps.flatMap((s) => (s.action ? [s.action] : []));
    if (new Set(actions).size !== actions.length) ctx.addIssue({ code: "custom", path: ["steps"], message: "an action at most once per card" });
  });
export type ActionCard = z.infer<typeof ActionCardSchema>;

/**
 * What names a step across cards, for its record and for "not offered again": its action id, or
 * `question.<fact kind or plain>` or `goal.<metric>` for a step with no button.
 */
export function stepActionKey(step: Pick<Step, "action" | "choices" | "progress">): string {
  if (step.action) return step.action;
  if (step.choices) return `question.${step.choices.fact ?? "plain"}`;
  return `goal.${step.progress?.metric ?? "none"}`;
}

// --- The kept record ---------------------------------------------------------------------------

/** What happened to a step: done (the founder acted), dismissed, answered (a chip), or ignored (replaced untouched). */
export const STEP_STATES = ["open", "done", "dismissed", "answered", "ignored"] as const;
export type StepState = (typeof STEP_STATES)[number];

export const OUTCOME_STATES = ["done", "dismissed", "answered", "ignored"] as const;
export type OutcomeState = (typeof OUTCOME_STATES)[number];

/** Why a card could not be used, so Home shows the steps list instead. */
export const FALLBACK_REASONS = ["model", "schema", "allowlist", "writing", "empty"] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

const isoTime = z.string().max(40).refine((s) => Number.isFinite(Date.parse(s)), { message: "a time" });
const ActionKey = z.string().regex(/^[a-z]+\.[a-z_]{1,40}$/);
const AgentActionIdSchema = z.string().regex(AGENT_ACTION_ID) as unknown as z.ZodType<AgentActionId>;

export const CardStepRecordSchema = z
  .object({ key: z.enum(STEP_KEYS), actionKey: ActionKey, agentActionId: AgentActionIdSchema, state: z.enum(STEP_STATES) })
  .strict();
export type CardStepRecord = z.infer<typeof CardStepRecordSchema>;

/** One decided step, kept for the next card: the founder's reason and answer are their own words. */
export const OutcomeSchema = z
  .object({
    at: isoTime,
    cardId: z.string().regex(/^nc_[a-f0-9]{16}$/),
    step: z.enum(STEP_KEYS),
    actionKey: ActionKey,
    title: z.string().max(L.TITLE),
    state: z.enum(OUTCOME_STATES),
    reason: z.string().max(L.REASON).nullable(),
    answer: z.string().max(L.CHIP).nullable(),
  })
  .strict();
export type Outcome = z.infer<typeof OutcomeSchema>;

/**
 * `next_action_cards/{na_<brand>}`, in the brand's region: the card on Home now (or the reason it
 * fell back), the hash of what it was written from, its steps' records, and the newest outcomes.
 */
export interface NextActionRecord {
  id: string;
  tenantId: string;
  status: "card" | "fallback";
  /** A hash of the inputs (src/lib/nextAction/inputs.ts): a new card only when it changes, or on Show another. */
  inputHash: string;
  cardId: string | null;
  card: ActionCard | null;
  steps: CardStepRecord[];
  failure: FallbackReason | null;
  /** Why it was last written. */
  reason: "state" | "another";
  composedAt: string;
  model: string;
  promptVersion: number;
  /** The UTC day of the last write, and how many cards were written that day. */
  composeDay: string;
  composeCount: number;
  /** A write in progress holds the record until then, so two tabs never write two cards. */
  leaseUntil: string | null;
  /** Which write holds it: only that one may put its card in. */
  leaseId: string | null;
  outcomes: Outcome[];
  createdAt: string;
  updatedAt: string;
}

export const NextActionRecordSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  status: z.enum(["card", "fallback"]),
  inputHash: z.string().max(80),
  cardId: z.string().regex(/^nc_[a-f0-9]{16}$/).nullable(),
  card: ActionCardSchema.nullable(),
  steps: z.array(CardStepRecordSchema).max(L.MAX_STEPS),
  failure: z.enum(FALLBACK_REASONS).nullable(),
  reason: z.enum(["state", "another"]),
  composedAt: isoTime,
  model: z.string().max(80),
  promptVersion: z.number().int().min(0),
  composeDay: z.string().max(10),
  composeCount: z.number().int().min(0),
  leaseUntil: isoTime.nullable(),
  leaseId: z.string().max(40).nullable(),
  // A damaged outcome is dropped on its own, never the whole record.
  outcomes: z.array(z.unknown()).transform((rows) => rows.flatMap((r) => {
    const o = OutcomeSchema.safeParse(r);
    return o.success ? [o.data] : [];
  })),
  createdAt: isoTime,
  updatedAt: isoTime,
}) as unknown as z.ZodType<NextActionRecord>;

/** The record's id for a brand: one per brand. */
export function nextActionDocId(tenantId: string): string {
  return `na_${encodeURIComponent(tenantId)}`;
}

export const CARD_ID_RE = /^nc_[a-f0-9]{16}$/;
export const isCardId = (v: unknown): v is string => typeof v === "string" && CARD_ID_RE.test(v);
