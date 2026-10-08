import type { ConnectionCatalog } from "@/lib/types/productConnection";
import type {
  ContentPool,
  LifecycleCondition,
  LifecycleDraft,
  LifecycleEnrolment,
  LifecycleJourney,
  LifecycleNode,
  WaitConfig,
} from "@/lib/types/lifecycle";
import { DATE_PASSED_EVENT, dateStartOf, JOURNEY_COMPLETED_EVENT, type DateStart } from "@/lib/types/lifecycle";
import type { ConditionOperator } from "@/lib/types/journey";
import type { ResolvedEmailStyle } from "@/lib/email/emailStyle";
import type { PaletteChip } from "../brand-kit/emailStyleForm";
import { CONDITION_FIELDS } from "@/lib/journey/conditions";

/**
 * Client-side model for the Lifecycle → Journeys screens: the API's response
 * shapes, the condition fields a connection's catalog offers, and small labels.
 * Pure — no server imports (validation issues come back from the API).
 */

export interface GraphIssue {
  code: string;
  nodeId?: string;
  detail?: string;
}

/** A journey's timeline in numbers and words (the API's `timeline`). */
export interface TimelineSummary {
  emails: number;
  days: { typical: number; min: number; max: number };
  steps: Array<{ day: number; label: string }>;
  sendDays: number[] | null;
  sendTime: string | null;
  /** "5 emails over about 8 days (7–10, depending on the day they start)". */
  text: string;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon–Fri from 09:00" — when a journey's emails go out, in each person's own timezone. */
export function sendWindowText(t: Pick<TimelineSummary, "sendDays" | "sendTime">): string {
  const d = t.sendDays;
  if (!d || !t.sendTime) return "at any time";
  const run = d.length > 2 && d.every((x, i) => i === 0 || x === d[i - 1]! + 1);
  const days = d.length === 7 ? "every day" : run ? `${DAY_NAMES[d[0]!]}–${DAY_NAMES[d.at(-1)!]}` : d.map((x) => DAY_NAMES[x]).join(", ");
  return `${days} from ${t.sendTime}`;
}

/** How the product's other journeys link to this one (journey links). */
export interface JourneyChain {
  /** The journey this draft continues from; `live` once the published version does too. */
  from: { id: string; name: string | null; problem: string | null; live: boolean } | null;
  /** The journeys that continue from this one: `live` = published and active; `draft` = set in their draft. */
  next: Array<{ id: string; name: string; status: "draft" | "active" | "paused" | "archived"; live: boolean; published: boolean; draft: boolean }>;
  /** The product's other journeys: what this one could continue from, or lead to. */
  journeys: Array<{
    id: string;
    name: string;
    status: "draft" | "active" | "paused" | "archived";
    publishedVersion: number | null;
    continuesFrom: string | null;
    timeline: TimelineSummary | null;
  }>;
}

export interface JourneyDetail {
  journey: LifecycleJourney;
  /** Product users, or a launch's waitlist (engine move). */
  audience: "product" | "waitlist";
  /** Waitlist journeys: their launch. */
  launch: { id: string; name: string; archived: boolean } | null;
  /** Waitlist journeys: people waiting while it's paused (or the launch archived). */
  held?: number;
  connection: {
    id: string;
    name: string;
    kind: "custom" | "sandbox";
    status: "active" | "paused" | "revoked";
    catalog: ConnectionCatalog;
    linkDomains: string[];
    defaults: { timezone: string; locale: string };
    contextConfigured: boolean;
    sandboxUsers: Array<{ userId: string; email: string; firstName: string | null }>;
  } | null;
  version: { version: number; publishedAt: string; publishedBy: string | null } | null;
  issues: GraphIssue[];
  sender: { verified: boolean; fromEmail: string | null; fromName: string | null };
  /** The footer's "sent by" brand when the journey names no sender (launches: the launch's sender). */
  footerBrand: string;
  /**
   * The brand's Email style, which previews wear as the send does; null = today's look (or the flag
   * is off). With journey styles on, the editor's preview draws the draft's own style over it.
   */
  emailStyle: ResolvedEmailStyle | null;
  postalAddress: string | null;
  modeCeiling: "test" | "shadow" | "live";
  features: {
    chatAuthoring: boolean;
    aiLines: boolean;
    consentAtSend: boolean;
    optInAfterSignup: boolean;
    entities: boolean;
    emailStyle: boolean;
    /** A journey can continue from another journey (LIFECYCLE_JOURNEY_LINKS_ENABLED); only sent while on. */
    journeyLinks?: boolean;
    /** A journey can start when a date passes (LIFECYCLE_DATE_START). */
    dateStart?: boolean;
    /** The journey's own Email style in Settings and the preview (EMAIL_JOURNEY_STYLE_ENABLED); only sent while on. */
    journeyEmailStyle?: boolean;
    /** A journey style's gradient and header text draw (EMAIL_HEADER_OPTIONS_ENABLED); only sent with journey styles on. */
    emailHeaderOptions?: boolean;
  };
  /**
   * With journey styles on: the brand's colours as the Email style section's quick picks, and the
   * name a band falls back on with no brand style saved (as the send's). Absent while off.
   */
  journeyStyle?: { palette: PaletteChip[]; fallbackName: string };
  /** With journey links on: what this journey continues from and leads to. Absent while off (and for a launch's journey). */
  chain?: JourneyChain;
}

export type EnrolmentRow = LifecycleEnrolment & {
  user: { email: string | null; firstName: string | null; status: string } | null;
};

export type FieldKind = "boolean" | "number" | "string";

export interface FieldOption {
  value: string;
  label: string;
  group: string;
  kind: FieldKind;
}

const RESERVED_EVENTS = ["user.signed_up", "onboarding.step_completed", "onboarding.completed", "email_preferences.updated"];

/** Every condition field this connection's catalog supports. Uncatalogued `fact.*` ids are free-form strings. */
export function fieldOptions(catalog: ConnectionCatalog | undefined): FieldOption[] {
  const out: FieldOption[] = [
    { value: "onboarding.complete", label: "Onboarding complete", group: "Onboarding", kind: "boolean" },
    { value: "onboarding.steps_done", label: "Steps done", group: "Onboarding", kind: "number" },
    { value: "onboarding.steps_remaining", label: "Steps remaining", group: "Onboarding", kind: "number" },
  ];
  for (const s of catalog?.onboardingSteps ?? []) {
    out.push({ value: `step.${s.id}`, label: `Step done: ${s.label}`, group: "Onboarding", kind: "boolean" });
  }
  for (const t of catalog?.traits ?? []) {
    out.push({
      value: `trait.${t.key}`,
      label: t.label || t.key,
      group: "Traits",
      kind: t.type === "number" ? "number" : t.type === "boolean" ? "boolean" : "string",
    });
  }
  for (const f of catalog?.facts ?? []) {
    if (f.type === "date") {
      // A date is read as whole days from now, worked out when the journey checks.
      out.push(
        { value: `days_since.${f.id}`, label: `Days since: ${f.label}`, group: "Facts", kind: "number" },
        { value: `days_until.${f.id}`, label: `Days until: ${f.label}`, group: "Facts", kind: "number" },
      );
      continue;
    }
    out.push({ value: `fact.${f.id}`, label: f.unit ? `${f.label} (${f.unit})` : f.label, group: "Facts", kind: f.type });
  }
  const events = new Set([...RESERVED_EVENTS, ...(catalog?.events ?? []).map((e) => e.name)]);
  for (const e of events) out.push({ value: `milestone.${e}`, label: `Has done: ${e}`, group: "Events", kind: "boolean" });
  out.push(
    { value: "consent.basis", label: "Consent basis", group: "Consent", kind: "string" },
    { value: "enrolment.emails_sent", label: "Emails sent so far", group: "Journey", kind: "number" },
    { value: "enrolment.days_since_enrol", label: "Days since sign-up", group: "Journey", kind: "number" },
  );
  return out;
}

/**
 * The fields a waitlist journey's conditions read: the original waitlist
 * engine's signup fields (same labels, same logic), plus the journey's own.
 */
export function waitlistFieldOptions(): FieldOption[] {
  return [
    ...CONDITION_FIELDS.map((f) => ({ value: `signup.${f.key}`, label: f.label, group: "Signup", kind: f.valueType })),
    { value: "enrolment.emails_sent", label: "Emails sent so far", group: "Journey", kind: "number" },
    { value: "enrolment.days_since_enrol", label: "Days since joining", group: "Journey", kind: "number" },
  ];
}

export function fieldKind(field: string, options: FieldOption[]): FieldKind {
  const known = options.find((o) => o.value === field);
  if (known) return known.kind;
  return "string"; // fact.* — whatever the product returns
}

export const OPERATORS: Record<FieldKind, Array<{ value: ConditionOperator; label: string }>> = {
  boolean: [
    { value: "is_true", label: "is true" },
    { value: "is_false", label: "is false" },
  ],
  number: [
    { value: "eq", label: "=" },
    { value: "neq", label: "≠" },
    { value: "gt", label: ">" },
    { value: "gte", label: "≥" },
    { value: "lt", label: "<" },
    { value: "lte", label: "≤" },
  ],
  string: [
    { value: "eq", label: "is" },
    { value: "neq", label: "is not" },
    { value: "contains", label: "contains" },
    { value: "gt", label: ">" },
    { value: "lt", label: "<" },
  ],
};

export function conditionText(c: LifecycleCondition, options: FieldOption[]): string {
  const f = options.find((o) => o.value === c.field)?.label ?? c.field;
  const kind = fieldKind(c.field, options);
  const op = OPERATORS[kind].find((o) => o.value === c.operator)?.label ?? c.operator;
  return c.operator === "is_true" || c.operator === "is_false" ? `${f} ${op}` : `${f} ${op} ${String(c.value ?? "")}`;
}

/** `start`: what the journey's clock counts from ("sign-up", or "the journey before" when it continues from one). */
export function waitSummary(w: WaitConfig | undefined, start = "sign-up"): string {
  if (!w) return "Not set";
  const parts: string[] = [];
  parts.push(w.minHours < 1 ? `${Math.round(w.minHours * 60)} min` : `${w.minHours} h`);
  if (w.after === "previous_step") parts.push("after the previous step");
  if (w.sinceEnrolHours) parts.push(`≥ ${w.sinceEnrolHours} h since ${start}`);
  if (w.differentLocalDay) parts.push("next day");
  if (w.windowExemptHours) parts.push("sends right away");
  return parts.join(" · ");
}

export function poolLabel(pools: ContentPool[], poolId: string | undefined): string {
  return pools.find((p) => p.id === poolId)?.label ?? (poolId ? `Missing pool "${poolId}"` : "No content chosen");
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 7)}`;
}

/** A readable name for where an enrolment is up to. */
export function nodeLabel(draft: LifecycleDraft, nodeId: string | undefined | null): string {
  if (!nodeId) return "—";
  const n: LifecycleNode | undefined = draft.graph.nodes.find((x) => x.id === nodeId);
  if (!n) return nodeId;
  return n.data.label || (n.type === "email" ? poolLabel(draft.pools, n.data.poolId) : n.type);
}

export const ISSUE_TEXT: Record<string, string> = {
  no_trigger: "The journey needs a trigger.",
  multiple_triggers: "Only one trigger is allowed.",
  trigger_has_incoming: "Nothing may lead into the trigger.",
  trigger_leads_nowhere: "Connect the trigger to the first step.",
  duplicate_node: "Two steps share an id.",
  dangling_edge: "A connection points at a step that no longer exists.",
  cycle: "The journey loops back on itself.",
  unreachable: "This step can't be reached from the trigger.",
  pool_missing: "Choose the content this email sends.",
  multiple_outgoing: "An email can lead to only one next step.",
  wait_without_config: "Set how long this wait is.",
  wait_leads_nowhere: "Connect this wait to exactly one next step.",
  consecutive_waits: "Two waits in a row — merge them.",
  condition_without_branches: "Add at least one branch.",
  bad_branch_id: "A branch id is reserved or repeated.",
  unknown_field: "A condition uses a field this product doesn't send.",
  condition_missing_default_edge: "Connect the Default path (everyone who matches no branch — including unknowns).",
  branch_unwired: "Connect every branch to a next step.",
  exit_has_outgoing: "An exit is the end — remove its outgoing connection.",
  no_email: "Add at least one email.",
  duplicate_pool: "Two content pools share an id.",
  duplicate_pool_item: "Two emails in a pool share an id.",
  pool_item_empty: "An email has no subject or body.",
  about_kind_missing: "Choose which kind of thing this journey is about (Settings → About).",
  about_kind_unknown: "This journey is about a kind of thing the product's catalog doesn't have — add it in Products → Catalog, or pick another.",
  about_fact_missing: "Choose the fact that decides which one each email is about.",
  entity_token_needs_one:
    "An email uses {{entity.name}} or {{entity.kind}} with no fallback, but the journey isn't about one of their entities — add a fallback, e.g. {{entity.name|your brand}}, or set About to one or each.",
  needs_onboarding_steps:
    "An email shows the onboarding checklist or next step, but this product has no onboarding steps yet. Add them in Products → your product → Catalog (or Learn from repo).",
  field_not_for_waitlist: "A welcome journey can only branch on signup details.",
  field_not_for_product: "Signup details are only for a launch's welcome journey.",
  hard_stop_required: "Set when the journey stops (Settings).",
  wait_too_long: "A wait can be at most 60 days here.",
  exit_target_waitlist_only: "Only a launch's welcome journey can hand people to the weekly newsletter.",
  ab_test_waitlist_only: "A/B tests are for a launch's welcome journey.",
  ab_test_needs_variants: "An A/B test needs a control and at least one variant.",
  continue_from_missing: "Choose the journey this one continues from (Settings → Starts when).",
  continue_from_not_found: "The journey this one continues from is gone — choose another (Settings → Starts when).",
  continue_from_self: "A journey can't continue from itself (Settings → Starts when).",
  continue_from_other_product: "A journey can only continue from a journey on the same product (Settings → Starts when).",
  continue_from_loop: "This journey and the one it continues from lead back into each other — change one of them (Settings → Starts when).",
  continue_from_product_only: "Only a product journey can continue from another journey.",
  date_start_missing: "Choose the date this journey starts from (Settings → Starts when).",
  date_start_fact_unknown: "The date this journey starts from isn't in the product's catalog any more — choose another (Settings → Starts when).",
  date_start_fact_not_a_date: "The fact this journey starts from isn't a date — choose a date fact (Settings → Starts when).",
  date_start_fact_per_entity:
    "The date this journey starts from is kept per one of the person's things, so the journey must be about one, or each, of that kind (Settings → About).",
  date_start_unavailable: "Starting a journey when a date passes isn't switched on in this environment yet.",
  date_start_product_only: "Only a product journey can start when a date passes.",
};

/**
 * A date start in words: "Last active was 14 or more days ago". Null when the journey doesn't
 * start that way (or no date is chosen yet). The fact's label comes from the catalog.
 */
export function dateStartText(settings: { trigger: { event: string; date?: DateStart | null } }, catalog: ConnectionCatalog | undefined): string | null {
  const start = dateStartOf(settings);
  if (!start) return null;
  const label = (catalog?.facts ?? []).find((f) => f.id === start.fact)?.label ?? start.fact;
  return `${label} was ${start.days} or more ${start.days === 1 ? "day" : "days"} ago`;
}

/** What a journey's start says: the product event, the journey it continues from, or the date it starts from. */
export function startLabel(
  settings: { trigger: { event: string; afterJourneyId?: string | null; date?: DateStart | null } },
  chain: JourneyChain | undefined,
  catalog?: ConnectionCatalog,
): string {
  if (settings.trigger.event === DATE_PASSED_EVENT) return dateStartText(settings, catalog) ?? "when a date passes (choose one)";
  if (settings.trigger.event !== JOURNEY_COMPLETED_EVENT) return settings.trigger.event;
  const id = settings.trigger.afterJourneyId;
  if (!id) return "after another journey (choose one)";
  return `after ${chain?.journeys.find((j) => j.id === id)?.name ?? "a journey that's gone"}`;
}

export function issueText(i: GraphIssue): string {
  const base = ISSUE_TEXT[i.code] ?? i.code;
  return i.detail ? `${base} (${i.detail})` : base;
}
