import type { EmailSuppression } from "@/lib/types/emailSuppression";
import type { DeliveryMode, LifecycleEnrolment, LifecycleJourney, LifecycleVersion, SentItem } from "@/lib/types/lifecycle";
import { JOURNEY_ABOUT_DEFAULT, dateStartOf } from "@/lib/types/lifecycle";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import { parseFactDate } from "@/lib/connect/dateFacts";
import { isEntitiesEnabled } from "@/lib/connect/v2/flags";
import { DAY_MS, LEASE_MS } from "@/lib/lifecycle/enrolmentRun";
import { entityViewFor, viewedUser, type EntityView } from "@/lib/lifecycle/entities";
import { isLifecycleConsentAtSendEnabled, isLifecycleDateStartEnabled, isLifecycleGoLiveSweepEnabled, lifecycleModeCeiling } from "@/lib/lifecycle/flags";
import { afterSend, afterSkip, decideNext, PREVIEW_SEND_LAG_MS, type WalkState } from "@/lib/lifecycle/planner";
import { allowsMarketing, isTestRecipient, lowestMode } from "@/lib/lifecycle/policy";
import { recipientClock, walkEnvFor, walkStateOf } from "@/lib/lifecycle/walk";

/**
 * One person's place in one journey, for their page and for Vizzy's brief: what
 * they were sent, where they are now, why anything is waiting, and what comes
 * next.
 *
 * "Next" is what the sender would do at its next run, on the state the product
 * last sent — no call to the product, so it can change when they do something.
 * First the checks the sender makes before it looks at the path at all (the
 * journey archived or paused, the person opted out, a test-mode journey they
 * aren't a test recipient of…: `standingOf`, in the sender's own order), then its
 * own walk (planner.decideNext) carried forward. What only the moment of sending
 * can tell — another journey's email in the last 20 hours, a daily limit, the
 * product asking to wait — shows afterwards, as what the entry is held by.
 * Server-only.
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
  /** The mode its emails go out in now: the most careful of the entry's, the journey's and the environment's. */
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
  /**
   * What comes after the steps ahead: the journey's end, or a stop (with why). `atNextRun`: the
   * sender stops it the next time it looks, before any email. Null when it's still further off.
   */
  then: { kind: "finishes" | "stops"; why: string | null; atNextRun?: boolean } | null;
  /** "Run next step now" is for entries whose emails go out in test or shadow mode. */
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

/** Holds that only the run itself can know: the rest are read from how things stand now (`standingOf`). */
const LOGGED_HOLDS = new Set(["sender_unverified", "postal_address_missing", "unsubscribe_unconfigured", "frequency_cap", "entity_frequency_cap", "waiting_for_consent", "daily_cap", "product_hold", "send_failed", "run_failed"]);

/**
 * What the last run held an active enrolment for, from its log (null = just waiting for its
 * time). A run that only books a wait writes no log line, so a hold counts only while its run
 * is the last thing that happened to the enrolment.
 */
function loggedHold(e: Pick<LifecycleEnrolment, "log" | "updatedAt">): string | null {
  const last = e.log.at(-1);
  if (!last || !LOGGED_HOLDS.has(last.event)) return null;
  if (Date.parse(e.updatedAt) - Date.parse(last.at) > LEASE_MS) return null;
  const text = HOLD_TEXT[last.event]!;
  return last.event === "product_hold" && last.detail ? `${text}: ${last.detail}` : text;
}

type Design = Pick<LifecycleVersion, "graph" | "pools" | "settings">;
type Journey = Pick<LifecycleJourney, "id" | "name" | "status"> & Partial<Pick<LifecycleJourney, "deliveryMode" | "testRecipients" | "shadowInbox">>;
type Connection = Pick<ProductConnection, "status" | "catalog" | "defaults" | "consentPolicy">;
/** An opt-out made in one of our emails (a row of `email_suppressions` for their address). */
export type JourneyOptOut = Pick<EmailSuppression, "scope"> & { category?: string | null };

/** One entry as the sender sees it at its next run. */
interface Entry {
  e: LifecycleEnrolment;
  journey: Journey;
  version: Design;
  connection: Connection;
  /** The person, seen through what the journey is about. */
  user: ProductUser;
  entities: EntityView | undefined;
  mode: DeliveryMode;
  /** When the sender next looks at it. */
  runMs: number;
}

/**
 * What the sender does with an entry before it looks at the journey's path — the checks at the
 * top of runner.processEnrolment, in its order, on what is stored — and the three holds at
 * send time that the stored state already decides. Null: it walks on.
 */
function standingOf(a: Entry & { entityMissing: boolean; optOuts: readonly JourneyOptOut[] }): { kind: "stops"; reason: string } | { kind: "held"; event: string } | null {
  const { e, journey, connection, user, mode, runMs } = a;
  const settings = a.version.settings;
  const stops = (reason: string) => ({ kind: "stops" as const, reason });
  const held = (event: string) => ({ kind: "held" as const, event });
  if (journey.status === "archived") return stops("journey_archived");
  if (journey.status !== "active") return held("journey_paused");
  if (connection.status === "revoked") return stops("connection_revoked");
  if (connection.status !== "active") return held("connection_paused");
  if (a.entityMissing) return stops("entity_removed");
  const anchorMs = Date.parse(e.anchorAt);
  const lastDay = settings.sendPolicy.hardStopDays;
  if (lastDay !== null && runMs > anchorMs + lastDay * DAY_MS) return stops("hard_stop");
  const category = settings.category.key;
  if (user.emailPreferences?.[category]?.subscribed === false) return stops("unsubscribed_in_product");
  if (user.excluded) return stops(`excluded: ${user.excluded.reason}`);
  if (user.subscribed === false) return stops("unsubscribed_in_product");
  if (user.email && a.optOuts.some((o) => o.scope !== "category" || o.category === category)) return stops("unsubscribed");
  // A journey that started when a date passed stops once that date has moved on (they came back).
  const start = isLifecycleDateStartEnabled() ? dateStartOf(settings) : null;
  const enteredMs = e.dateAt ? Date.parse(e.dateAt) : NaN;
  if (start?.stopWhenDateMoves && Number.isFinite(enteredMs)) {
    const dateMs = parseFactDate(user.facts?.[start.fact]?.value);
    if (dateMs !== null && dateMs > enteredMs) return stops("date_moved");
  }
  const outsideTest = mode === "test" && !isTestRecipient({ testRecipients: journey.testRecipients ?? { userIds: [], emails: [] } }, user);
  if (isLifecycleGoLiveSweepEnabled() && outsideTest && e.sentItems.length === 0 && runMs - anchorMs > settings.trigger.maxEventAgeHours * 3600_000) {
    return stops("window_passed");
  }
  if (!user.email) return held("no_email");
  if (outsideTest) return held("mode_blocked");
  if (mode === "shadow" && !journey.shadowInbox) return held("no_shadow_inbox");
  return null;
}

/** The emails ahead of an active enrolment, by the runner's own walk on the stored state. */
function stepsAhead(a: Entry, nowMs: number): Pick<PersonJourney, "steps" | "then"> & { heldBy: string | null } {
  const { e, version, connection, user, entities } = a;
  const { tz, offsetMin } = recipientClock(user, connection, version);
  // The runner looks again when the enrolment is next due, not before.
  let state: WalkState = walkStateOf(e, Math.max(nowMs, a.runMs));
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
  const noMarketing = !allowsMarketing(connection.consentPolicy, user.consent?.basis);
  const iso = (ms: number) => new Date(ms).toISOString();

  const steps: PersonJourneyStep[] = [];
  for (let i = 0; i < WALK_LIMIT && steps.length < AHEAD; i += 1) {
    const walk = decideNext(state, env);
    const d = walk.decision;
    if (d.kind === "run_at") {
      state = { ...walk.state, nowMs: d.runAtMs };
      continue;
    }
    if (d.kind !== "send") return { steps, then: { kind: d.kind === "complete" ? "finishes" : "stops", why: d.kind === "exit" ? aheadStopText(d.reason) : null }, heldBy: null };
    // A marketing email without consent is skipped at send time, never sent late — or, with that
    // switched off, held there for as long as it takes: nothing past it can be promised.
    const skip = noMarketing && d.item.messageClass === "marketing";
    if (skip && !isLifecycleConsentAtSendEnabled()) return { steps, then: null, heldBy: steps.length === 0 ? "waiting_for_consent" : null };
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
  return { steps, then: null, heldBy: null };
}

export function personJourney(a: {
  enrolment: LifecycleEnrolment;
  journey: Journey;
  /** The version the enrolment is on; null when it has gone (only what was sent can then be shown). */
  version: Design | null;
  user: ProductUser;
  connection: Connection;
  /** Their opt-outs made in our emails: one for everything, or for this journey's category, stops it. */
  optOuts?: readonly JourneyOptOut[];
  nowMs: number;
}): PersonJourney {
  const { enrolment: e, journey, version, user: stored, connection } = a;
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
  // As the sender has it: the most careful of the entry's mode, the journey's and the environment's.
  const mode = journey.deliveryMode ? lowestMode(e.mode, journey.deliveryMode, lifecycleModeCeiling()) : e.mode;

  let ahead: ReturnType<typeof stepsAhead> = { steps: [], then: null, heldBy: null };
  let heldBy: string | null = null;
  if (active && !version) {
    ahead = { steps: [], then: { kind: "stops", why: aheadStopText("version_missing"), atNextRun: true }, heldBy: null };
  } else if (active && version) {
    // API v2 entities: which of their workspaces, brands or projects this entry is about.
    const about = isEntitiesEnabled() ? (version.settings.about ?? JOURNEY_ABOUT_DEFAULT) : null;
    const entities = about ? entityViewFor(stored, about, connection.catalog, { pinned: e.entityId ?? null, triggerId: e.entityId ?? null }) : undefined;
    const due = e.nextRunAt ? Date.parse(e.nextRunAt) : NaN;
    const entry: Entry = {
      e,
      journey,
      version,
      connection,
      user: entities ? viewedUser(stored, entities, connection.catalog) : stored,
      entities,
      mode,
      runMs: Math.max(a.nowMs, Number.isFinite(due) ? due : a.nowMs),
    };
    const standing = standingOf({ ...entry, entityMissing: about?.mode === "each" && !entities?.entity, optOuts: a.optOuts ?? [] });
    if (standing?.kind === "stops") ahead = { steps: [], then: { kind: "stops", why: aheadStopText(standing.reason), atNextRun: true }, heldBy: null };
    // Held by how things stand: nothing goes out until that changes, so nothing ahead is promised.
    else if (standing) heldBy = standing.event;
    else ahead = stepsAhead(entry, a.nowMs);
  }
  const why = heldBy ?? ahead.heldBy;
  const entity = e.entityId ? stored.entities?.[e.entityId] : undefined;
  return {
    enrolmentId: e.id,
    journeyId: journey.id,
    name: journey.name,
    journeyStatus: journey.status,
    mode,
    status: e.status,
    enteredAt: e.anchorAt,
    endedAt: active ? null : e.updatedAt,
    source: e.source,
    about: e.entityId ? (entity?.name ?? e.entityId) : null,
    stopped: e.status === "exited" ? stopText(e.stopReason) : null,
    waiting: active ? { until: e.nextRunAt ?? null, why: why ? HOLD_TEXT[why]! : loggedHold(e) } : null,
    steps: [...behind, ...ahead.steps],
    then: ahead.then,
    canRunNow: active && mode !== "live",
  };
}
