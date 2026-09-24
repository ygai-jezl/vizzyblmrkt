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
import type { ConditionOperator } from "@/lib/types/journey";
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
  postalAddress: string | null;
  modeCeiling: "test" | "shadow" | "live";
  features: { chatAuthoring: boolean; aiLines: boolean };
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

export function waitSummary(w: WaitConfig | undefined): string {
  if (!w) return "Not set";
  const parts: string[] = [];
  parts.push(w.minHours < 1 ? `${Math.round(w.minHours * 60)} min` : `${w.minHours} h`);
  if (w.after === "previous_step") parts.push("after the previous step");
  if (w.sinceEnrolHours) parts.push(`≥ ${w.sinceEnrolHours} h since sign-up`);
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
  field_not_for_waitlist: "A welcome journey can only branch on signup details.",
  field_not_for_product: "Signup details are only for a launch's welcome journey.",
  hard_stop_required: "Set when the journey stops (Settings).",
  wait_too_long: "A wait can be at most 60 days here.",
  exit_target_waitlist_only: "Only a launch's welcome journey can hand people to the weekly newsletter.",
  ab_test_waitlist_only: "A/B tests are for a launch's welcome journey.",
  ab_test_needs_variants: "An A/B test needs a control and at least one variant.",
};

export function issueText(i: GraphIssue): string {
  const base = ISSUE_TEXT[i.code] ?? i.code;
  return i.detail ? `${base} (${i.detail})` : base;
}
