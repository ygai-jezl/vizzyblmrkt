import type { DeliveryMode, LifecycleEnrolment, LifecycleJourney, LifecycleVersion, SentItem } from "@/lib/types/lifecycle";
import { JOURNEY_ABOUT_DEFAULT } from "@/lib/types/lifecycle";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import { isEntitiesEnabled } from "@/lib/connect/v2/flags";
import { entityViewFor, viewedUser } from "@/lib/lifecycle/entities";
import { isLifecycleConsentAtSendEnabled } from "@/lib/lifecycle/flags";
import { afterSend, afterSkip, decideNext, PREVIEW_SEND_LAG_MS, type WalkState } from "@/lib/lifecycle/planner";
import { allowsMarketing } from "@/lib/lifecycle/policy";
import { recipientClock, walkEnvFor, walkStateOf } from "@/lib/lifecycle/walk";

/**
 * One person's place in one journey, for their page and for Vizzy's brief: what
 * they were sent, where they are now, why anything is waiting, and what comes
 * next. "Next" is the runner's own walk (planner.decideNext) carried forward from
 * where they stand, on the state the product last sent — no call to the product,
 * so it can change when they do something. Server-only.
 */

/** How many emails ahead the walk looks. */
const AHEAD = 6;
const WALK_LIMIT = 40;

export interface PersonJourneyStep {
  /**
   * Behind them: `sent`, `unknown` (the provider never confirmed it) or `skipped`.
   * Ahead: `next` (the email we expect next), `later`, or `would_skip` (it won't go out as things stand).
   */
  kind: "sent" | "unknown" | "skipped" | "next" | "later" | "would_skip";
  nodeId: string;
  poolId: string;
  itemId: string;
  label: string;
  /** When it went out, or when we expect it to. */
  at: string;
  /** Why it was skipped, or would be. */
  reason: string | null;
  /** An email with a per-person AI line (it goes through Approvals). */
  personalised: boolean;
}

export interface PersonJourney {
  enrolmentId: string;
  journeyId: string;
  name: string;
  journeyStatus: LifecycleJourney["status"];
  mode: DeliveryMode;
  status: LifecycleEnrolment["status"];
  enteredAt: string;
  /** When it finished or stopped. */
  endedAt: string | null;
  source: LifecycleEnrolment["source"];
  /** The brand, workspace… its emails are about, when the journey is about one. */
  about: string | null;
  /** Why it stopped, in plain words. */
  stopped: string | null;
  /** While active: when it runs next, and why it's held when something is in the way. */
  waiting: { until: string | null; why: string | null } | null;
  steps: PersonJourneyStep[];
  /** What the walk reaches after the steps ahead: the journey's end, or a stop (with why). Null when it's still further off. */
  then: { kind: "finishes" | "stops"; why: string | null } | null;
  /** "Run next step now" is for test and shadow entries only. */
  canRunNow: boolean;
}

const STOP_TEXT: Record<string, string> = {
  version_missing: "Its published version is missing",
  journey_archived: "The journey was archived",
  connection_revoked: "The product's connection was revoked",
  user_deleted: "The person was erased",
  entity_removed: "What it was about was removed",
  hard_stop: "It reached its last day",
  unsubscribed_in_product: "They opted out in your product",
  unsubscribed: "They unsubscribed from these emails",
  date_moved: "They came back",
  window_passed: "Their start window passed before the journey went live",
  stopped_by_admin: "Stopped by your team",
  send_failed: "Sending kept failing",
  run_failed: "It kept failing to run",
  too_many_steps: "The journey's path loops",
  too_many_hops: "The journey's path loops",
  dead_end: "The journey's path leads nowhere",
};

/** Why an enrolment stopped, in plain words (the runner's `stopReason`). */
export function stopText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason.startsWith("product_exit: ")) return `Your product ended it: ${reason.slice("product_exit: ".length)}`;
  if (reason.startsWith("excluded: ")) return `Excluded by your product: ${reason.slice("excluded: ".length)}`;
  return STOP_TEXT[reason] ?? reason.replace(/_/g, " ");
}

/** Why the walk ahead ends in a stop: the same reasons, as something still to come. */
function aheadStopText(reason: string): string | null {
  if (reason === "hard_stop") return "the journey reaches its last day first";
  const text = stopText(reason);
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : null;
}

const HOLD_TEXT: Record<string, string> = {
  journey_paused: "The journey is paused",
  connection_paused: "The product's connection is paused",
  mode_blocked: "The journey is in test mode and they aren't a test recipient",
  no_shadow_inbox: "Shadow mode has no inbox to send to",
  sender_unverified: "The sending domain isn't verified",
  postal_address_missing: "Marketing email needs your postal address (Settings › Sending)",
  unsubscribe_unconfigured: "Unsubscribe links aren't set up here",
  frequency_cap: "They had another email in the last 20 hours",
  entity_frequency_cap: "They had an email about another one today",
  waiting_for_consent: "They haven't given marketing consent",
  no_email: "They have no email address",
  daily_cap: "The journey reached its daily send limit",
  product_hold: "Your product asked us to wait",
  send_failed: "The last send failed; it will try again",
  run_failed: "The last run failed; it will try again",
};

const SKIP_TEXT: Record<string, string> = {
  no_marketing_consent: "No marketing consent",
  staff_skipped: "Skipped in Approvals",
  approval_required: "Not approved in time",
  declined: "Not sent",
  interrupted: "Interrupted: it may or may not have gone out",
};

/** Why an email was skipped (or its send is unknown), in plain words. Null for an ordinary send. */
export function sendNote(sent: Pick<SentItem, "status" | "reason">): string | null {
  if (sent.status === "sent") return null;
  const first = (sent.reason ?? "").split(" · ")[0] ?? "";
  if (sent.status === "unknown") return SKIP_TEXT[first] ?? "The provider didn't confirm it";
  return SKIP_TEXT[first] ?? (first ? first.replace(/_/g, " ") : "Skipped");
}

/** What an active enrolment is held by, from the runner's last log line (null = just waiting for its time). */
function holdText(log: LifecycleEnrolment["log"]): string | null {
  const last = log.at(-1);
  if (!last) return null;
  const text = HOLD_TEXT[last.event];
  if (!text) return null;
  return last.event === "product_hold" && last.detail ? `${text}: ${last.detail}` : text;
}

type Design = Pick<LifecycleVersion, "graph" | "pools" | "settings">;

/** The emails ahead of an active enrolment, by the runner's own walk on the stored state. */
function stepsAhead(
  e: LifecycleEnrolment,
  version: Design,
  stored: ProductUser,
  connection: Pick<ProductConnection, "catalog" | "defaults" | "consentPolicy">,
  nowMs: number,
): Pick<PersonJourney, "steps" | "then"> {
  const about = isEntitiesEnabled() ? (version.settings.about ?? JOURNEY_ABOUT_DEFAULT) : null;
  const entities = about
    ? entityViewFor(stored, about, connection.catalog, { pinned: e.entityId ?? null, triggerId: e.entityId ?? null })
    : undefined;
  const user = entities ? viewedUser(stored, entities, connection.catalog) : stored;
  const { tz, offsetMin } = recipientClock(user, connection, version);
  // The runner looks again when the enrolment is next due, not before.
  const due = e.nextRunAt ? Date.parse(e.nextRunAt) : nowMs;
  let state: WalkState = walkStateOf(e, Math.max(nowMs, Number.isFinite(due) ? due : nowMs));
  const env = walkEnvFor({
    version,
    user,
    connection,
    context: null,
    tz,
    offsetMin,
    anchorMs: state.anchorMs,
    emailsSent: () => state.sent.filter((s) => s.status !== "skipped").length,
    entities,
  });
  const noMarketing = isLifecycleConsentAtSendEnabled() && !allowsMarketing(connection.consentPolicy, user.consent?.basis);
  const iso = (ms: number) => new Date(ms).toISOString();

  const steps: PersonJourneyStep[] = [];
  for (let i = 0; i < WALK_LIMIT && steps.length < AHEAD; i += 1) {
    const walk = decideNext(state, env);
    const d = walk.decision;
    if (d.kind === "run_at") {
      state = { ...walk.state, nowMs: d.runAtMs };
      continue;
    }
    if (d.kind !== "send") return { steps, then: { kind: d.kind === "complete" ? "finishes" : "stops", why: d.kind === "exit" ? aheadStopText(d.reason) : null } };
    // A marketing email without consent is skipped at send time, never sent late.
    const skip = noMarketing && d.item.messageClass === "marketing";
    steps.push({
      kind: skip ? "would_skip" : steps.some((s) => s.kind === "next") ? "later" : "next",
      nodeId: d.nodeId,
      poolId: d.pool.id,
      itemId: d.item.id,
      label: d.item.label,
      at: iso(walk.state.nowMs),
      reason: skip ? SKIP_TEXT.no_marketing_consent! : null,
      personalised: d.item.personalization === "ai_line",
    });
    state = skip ? afterSkip(walk.state, d) : afterSend(walk.state, d, walk.state.nowMs + PREVIEW_SEND_LAG_MS, "sent");
  }
  return { steps, then: null };
}

export function personJourney(a: {
  enrolment: LifecycleEnrolment;
  journey: Pick<LifecycleJourney, "id" | "name" | "status">;
  /** The version the enrolment is on; null when it has gone (only what was sent can then be shown). */
  version: Design | null;
  user: ProductUser;
  connection: Pick<ProductConnection, "catalog" | "defaults" | "consentPolicy">;
  nowMs: number;
}): PersonJourney {
  const { enrolment: e, journey, version, user } = a;
  const item = (s: Pick<SentItem, "poolId" | "itemId">) => version?.pools.find((p) => p.id === s.poolId)?.items.find((i) => i.id === s.itemId);
  const behind: PersonJourneyStep[] = e.sentItems.map((s) => ({
    kind: s.status,
    nodeId: s.nodeId,
    poolId: s.poolId,
    itemId: s.itemId,
    label: item(s)?.label ?? s.itemId,
    at: s.at,
    reason: sendNote(s),
    personalised: item(s)?.personalization === "ai_line",
  }));
  const active = e.status === "active";
  const ahead = active && version ? stepsAhead(e, version, user, a.connection, a.nowMs) : { steps: [], then: null };
  const entity = e.entityId ? user.entities?.[e.entityId] : undefined;
  return {
    enrolmentId: e.id,
    journeyId: journey.id,
    name: journey.name,
    journeyStatus: journey.status,
    mode: e.mode,
    status: e.status,
    enteredAt: e.anchorAt,
    endedAt: active ? null : e.updatedAt,
    source: e.source,
    about: e.entityId ? (entity?.name ?? e.entityId) : null,
    stopped: e.status === "exited" ? stopText(e.stopReason) : null,
    waiting: active ? { until: e.nextRunAt ?? null, why: holdText(e.log) } : null,
    steps: [...behind, ...ahead.steps],
    then: ahead.then,
    canRunNow: active && e.mode !== "live",
  };
}
