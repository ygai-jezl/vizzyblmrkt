import { z } from "zod";
import { CONDITION_FIELD_KEYS, ConditionOperator } from "./journey";
import { EmailLayoutSchema } from "./emailLayout";
import { ENTITY_KIND_RE } from "./productConnection";
import { StoredJourneyStyleSchema } from "./tenant";

/**
 * Lifecycle journeys — branching email sequences for a CONNECTED PRODUCT's users
 * (e.g. vizzybl.ai's post-signup onboarding), run by the lifecycle runner
 * (src/lib/lifecycle/runner.ts): the recipient is a product user, conditions read
 * the product's catalog (steps, traits, facts), and sends follow a per-recipient
 * local-time send window.
 *
 * Engine move (D2): a journey's AUDIENCE can instead be a launch's WAITLIST —
 * the recipients are its verified signups, conditions read the signup
 * (`signup.*`, the same fields as the original waitlist engine), and it can send
 * at any time (see src/lib/lifecycle/waitlist/). Journeys without an `audience`
 * are product journeys.
 *
 * A journey holds an editable DRAFT; publishing snapshots it into an immutable
 * `lifecycle_versions` doc. Enrolments run on the version they started on, so
 * editing never changes an email already in flight.
 */

// ---- Conditions -------------------------------------------------------------------

/**
 * Fields a lifecycle condition can read. Prefixed families are checked against
 * the connection's catalog when publishing (trait/step/milestone); fact.* is
 * whatever the product's context endpoint returns (unknown when absent).
 * `days_since.*` / `days_until.*` (CONNECT_DATE_FACTS) read one of the catalog's
 * date facts as whole days from now.
 * `signup.*` (waitlist journeys only) are the original waitlist engine's fields
 * (src/lib/journey/conditions.ts), read the same way.
 */
export const LIFECYCLE_FIELD_RE = new RegExp(
  "^(?:(?:trait|step|fact|milestone)\\.[A-Za-z0-9][A-Za-z0-9_.-]{0,79}" +
    "|(?:days_since|days_until)\\.[a-z][a-z0-9_]{0,63}" +
    "|onboarding\\.(?:complete|steps_done|steps_remaining)|consent\\.basis" +
    "|enrolment\\.(?:emails_sent|days_since_enrol)" +
    "|entities\\.(?:count|finished|unfinished)" +
    "|entities\\.(?:any|all)\\.step\\.[a-z0-9][a-z0-9_-]{0,63}|entities\\.(?:min|max)\\.fact\\.[a-z][a-z0-9_]{0,63}" +
    `|signup\\.(?:${CONDITION_FIELD_KEYS.join("|")}))$`,
);

export const LifecycleConditionSchema = z.object({
  field: z.string().regex(LIFECYCLE_FIELD_RE),
  operator: ConditionOperator,
  value: z.union([z.number(), z.string(), z.boolean()]).optional(),
  /** `signup.surveyAnswer` only: which survey question it reads. */
  questionValue: z.string().max(200).optional(),
});
export type LifecycleCondition = z.infer<typeof LifecycleConditionSchema>;

export const LifecycleBranchSchema = z.object({
  /** Edge sourceHandle, e.g. "br_done". "default" is reserved for the else edge. */
  id: z.string().min(1).max(64),
  label: z.string().max(80).optional(),
  match: z.enum(["all", "any"]).optional(),
  conditions: z.array(LifecycleConditionSchema).min(1).max(10),
});
export type LifecycleBranch = z.infer<typeof LifecycleBranchSchema>;

export const EligibilitySchema = z.object({
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(LifecycleConditionSchema).max(10).default([]),
});
export type Eligibility = z.infer<typeof EligibilitySchema>;

// ---- Content pools -------------------------------------------------------------------

const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * `service` = onboarding/service messages that need no marketing consent (the
 * welcome); `marketing` = everything else, sent only on the connection's
 * marketing consent bases.
 */
export const MessageClass = z.enum(["service", "marketing"]);
export type MessageClass = z.infer<typeof MessageClass>;

/**
 * One email in a pool. `body` is HTML (or plain text) that may contain merge
 * tokens ({{user.first_name|there}}, {{fact.x}}, {{next_step.url}}…) and dynamic
 * blocks ({{block.checklist}}, {{block.next_step}}, {{block.insight}}), rendered
 * per recipient at send time. A `letter` is a plain founder-style note.
 */
export const PoolItemSchema = z.object({
  id: z.string().regex(SLUG),
  label: z.string().min(1).max(120),
  subject: z.string().max(200),
  previewText: z.string().max(200).nullable().optional(),
  body: z.string().max(20000),
  layout: EmailLayoutSchema.nullable().optional(),
  format: z.enum(["branded", "letter"]).default("branded"),
  messageClass: MessageClass.default("marketing"),
  /** Only sent when these hold (e.g. "the audit is done" for "Your audit, decoded"). */
  eligibility: EligibilitySchema.optional(),
  /** `ai_line`: a per-user AI sentence goes through the approvals queue (M3). */
  personalization: z.enum(["none", "ai_line"]).default("none"),
  /** Waitlist journeys: the image above the body (the original engine's hero image). */
  heroImageUrl: z.string().max(2048).nullable().optional(),
});
export type PoolItem = z.infer<typeof PoolItemSchema>;

/**
 * An ordered set of emails. An email node sends the FIRST item this user hasn't
 * had yet and is eligible for — so a user who finishes onboarding late still
 * starts the education pool at item one. A single email is a pool of one.
 */
export const ContentPoolSchema = z.object({
  id: z.string().regex(SLUG),
  label: z.string().min(1).max(120),
  items: z.array(PoolItemSchema).min(1).max(10),
  /**
   * Waitlist journeys: an A/B test. The first item is the control and the rest
   * are challengers; `splitPercent` of people enter the test (spread evenly over
   * the challengers) and everyone else gets the control — the original engine's
   * allocation (src/lib/journey/allocation.ts), so a person gets the same arm on
   * either engine. A promoted winner lives on the journey (`abWinners`).
   */
  abTest: z.object({ splitPercent: z.number().int().min(1).max(100) }).optional(),
});
export type ContentPool = z.infer<typeof ContentPoolSchema>;

// ---- Graph -------------------------------------------------------------------------------

/** Waits can be up to two years (the original waitlist engine had no limit). */
export const MAX_WAIT_HOURS = 24 * 730;

export const WaitConfigSchema = z.object({
  /** At least this long after the previous email (or enrolment, before the first). */
  minHours: z.number().min(0).max(MAX_WAIT_HOURS),
  /** And at least this long after enrolment. */
  sinceEnrolHours: z.number().min(0).max(MAX_WAIT_HOURS).optional(),
  /**
   * What `minHours` counts from: the previous email (the default) or the moment
   * the person reached this wait (`previous_step`, the original waitlist
   * engine's timing — a wait after a condition counts from the condition).
   */
  after: z.enum(["previous_email", "previous_step"]).optional(),
  /** Land on a later LOCAL day than the previous email. */
  differentLocalDay: z.boolean().optional(),
  /** Within this many hours of enrolment, send immediately (the welcome) instead of waiting for the window. */
  windowExemptHours: z.number().min(0).max(48).optional(),
});
export type WaitConfig = z.infer<typeof WaitConfigSchema>;

export const LifecycleNodeType = z.enum(["trigger", "email", "wait", "condition", "exit"]);
export type LifecycleNodeType = z.infer<typeof LifecycleNodeType>;

export const LifecycleNodeDataSchema = z.object({
  label: z.string().max(120).optional(),
  /** email: the pool it sends from. */
  poolId: z.string().max(40).optional(),
  /** wait: when the next step runs. */
  wait: WaitConfigSchema.optional(),
  /** condition: ordered branches; first match wins, else the "default" edge. */
  branches: z.array(LifecycleBranchSchema).max(10).optional(),
  /** exit (waitlist journeys): `weekly` hands the person to the launch's weekly newsletter. */
  exitTarget: z.enum(["weekly"]).optional(),
});
export type LifecycleNodeData = z.infer<typeof LifecycleNodeDataSchema>;

export const LifecycleNodeSchema = z.object({
  id: z.string().min(1).max(64),
  type: LifecycleNodeType,
  position: z.object({ x: z.number(), y: z.number() }),
  data: LifecycleNodeDataSchema.default({}),
});
export type LifecycleNode = z.infer<typeof LifecycleNodeSchema>;

export const LifecycleEdgeSchema = z.object({
  id: z.string().min(1).max(96),
  source: z.string().min(1).max(64),
  target: z.string().min(1).max(64),
  sourceHandle: z.string().max(64).nullable().optional(),
});
export type LifecycleEdge = z.infer<typeof LifecycleEdgeSchema>;

export const LifecycleGraphSchema = z.object({
  nodes: z.array(LifecycleNodeSchema).max(200),
  edges: z.array(LifecycleEdgeSchema).max(400),
});
export type LifecycleGraph = z.infer<typeof LifecycleGraphSchema>;

// ---- Settings -------------------------------------------------------------------------------

/**
 * The trigger of a journey that CONTINUES FROM another journey (LIFECYCLE_JOURNEY_LINKS_ENABLED):
 * nothing a product sends starts it — the runner does, when someone reaches the end of the
 * journey named in `trigger.afterJourneyId`.
 */
export const JOURNEY_COMPLETED_EVENT = "journey.completed";

/**
 * The trigger of a journey that STARTS WHEN A DATE PASSES (LIFECYCLE_DATE_START): nothing a
 * product sends starts it either — a daily check does (src/lib/lifecycle/dateStart.ts), for
 * everyone whose date fact (`trigger.date.fact`) is at least `days` days ago. "Hasn't been
 * active for 14 days" is this with a last-active date.
 */
export const DATE_PASSED_EVENT = "date.passed";

/** The limits of a date start, shared by the schema, the editor and Vizzy. */
export const DATE_START_LIMITS = { maxDays: 365, defaultDays: 14, defaultWindowDays: 7, defaultReenterAfterDays: 30 } as const;

export const DateStartSchema = z.object({
  /** The catalog's date fact the journey reads. */
  fact: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  /** Start once the date is at least this many whole days ago. */
  days: z.number().int().min(1).max(DATE_START_LIMITS.maxDays).default(DATE_START_LIMITS.defaultDays),
  /**
   * Don't start for someone already more than this many days past the line, so the first
   * check after going live doesn't take everyone who ever went quiet.
   */
  windowDays: z.number().int().min(1).max(DATE_START_LIMITS.maxDays).default(DATE_START_LIMITS.defaultWindowDays),
  /** Stop the journey when the date moves on after they entered (they came back). */
  stopWhenDateMoves: z.boolean().default(true),
  /**
   * Let someone enter again once their date has moved on and passed the line again, but no
   * sooner than this many days after they last entered. Null = each person enters once.
   */
  reenterAfterDays: z.number().int().min(1).max(DATE_START_LIMITS.maxDays).nullable().default(DATE_START_LIMITS.defaultReenterAfterDays),
});
export type DateStart = z.infer<typeof DateStartSchema>;


export const SendPolicySchema = z.object({
  /** Allowed LOCAL weekdays, 0 = Sunday … 6 = Saturday. */
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
  startHour: z.number().int().min(0).max(23).default(9),
  startMinute: z.number().int().min(0).max(59).default(0),
  /** Sends spread over this many minutes after the start (stable per user). */
  windowMinutes: z.number().int().min(15).max(720).default(90),
  /**
   * Send at any time of day, on any day: no window (waitlist journeys, like the
   * original engine). `days`/`startHour`/`windowMinutes` are then ignored.
   */
  anytime: z.boolean().optional(),
  /** Nothing sends after this many days from enrolment. Null = no limit (waitlist journeys only). */
  hardStopDays: z.number().int().min(1).max(60).nullable().default(12),
  /** Used when neither the user nor the connection has a valid timezone. */
  fallbackTimezone: z.string().max(64).default("Europe/London"),
}).refine((p) => p.startHour * 60 + p.startMinute + p.windowMinutes <= 24 * 60, {
  message: "the send window must end by midnight",
});
export type SendPolicy = z.infer<typeof SendPolicySchema>;

/**
 * What a journey's emails are about when people have several of something
 * (API v2 `entities`): the person; one of their entities, picked by a rule;
 * all of them in one email; or each one separately.
 */
export const JourneyAboutSchema = z.object({
  mode: z.enum(["person", "one", "all", "each"]).default("person"),
  /** The entity kind (the catalog's), for one / all / each. */
  kind: z.string().regex(ENTITY_KIND_RE).nullable().default(null),
  /**
   * For "one": which. `focus` follows their onboarding (a finished one first, else the
   * one furthest along, then the most recent); the others are fixed once chosen —
   * `trigger` (the entity the trigger happened to), `recent`, `fact_high`, `fact_low`.
   */
  pick: z.enum(["focus", "trigger", "recent", "fact_high", "fact_low"]).default("focus"),
  /** The fact `fact_high` / `fact_low` compare. */
  fact: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable().default(null),
  /** Count entities they only belong to or were invited to, not just the ones they own. */
  includeJoined: z.boolean().default(false),
  /** For "all": how many one email lists before "and N more". */
  maxListed: z.number().int().min(1).max(20).default(5),
});
export type JourneyAbout = z.infer<typeof JourneyAboutSchema>;
export const JOURNEY_ABOUT_DEFAULT: JourneyAbout = JourneyAboutSchema.parse({});

export const LifecycleSettingsSchema = z.object({
  trigger: z
    .object({
      event: z.string().max(80).default("user.signed_up"),
      /** Older trigger events (e.g. a backfill) don't enrol automatically. */
      maxEventAgeHours: z.number().int().min(1).max(720).default(72),
      /**
       * With `event` = JOURNEY_COMPLETED_EVENT: the journey this one continues from. People enter
       * when they reach the end of that journey, and this journey's clock starts then.
       */
      afterJourneyId: z.string().max(64).nullable().optional(),
      /** With `event` = DATE_PASSED_EVENT: which date, and how long after it. */
      date: DateStartSchema.nullable().optional(),
    })
    .default({ event: "user.signed_up", maxEventAgeHours: 72 }),
  sendPolicy: SendPolicySchema.default(SendPolicySchema.parse({})),
  sender: z
    .object({
      fromName: z.string().max(120).nullable().optional(),
      fromEmail: z.string().email().max(254).nullable().optional(),
      replyTo: z.string().email().max(254).nullable().optional(),
    })
    .default({}),
  /** The unsubscribe category (synced back to the product as email_preferences.updated). */
  category: z
    .object({
      key: z.string().regex(/^[a-z0-9_-]{1,64}$/).default("onboarding"),
      label: z.string().min(1).max(80).default("Onboarding tips"),
    })
    .default({ key: "onboarding", label: "Onboarding tips" }),
  tracking: z
    .object({ opens: z.boolean().default(false), clicks: z.boolean().default(false) })
    .default({ opens: false, clicks: false }),
  /**
   * Who may join. `requireMarketingConsent`: only people whose consent (as the
   * product sent it) the connection accepts for marketing — someone who opts in
   * later joins then, while the trigger's window still allows it.
   */
  entry: z
    .object({ requireMarketingConsent: z.boolean().default(false) })
    .default({ requireMarketingConsent: false }),
  about: JourneyAboutSchema.default(JOURNEY_ABOUT_DEFAULT),
  /**
   * The journey's own look (EMAIL_JOURNEY_STYLE_ENABLED), in the draft: its header and button
   * colours in place of the brand's Email style. Absent (or null) = the brand's. Publish copies it
   * to the journey's live `emailStyle`, which is what sends wear. Read leniently (a damaged style
   * reads as none, never a failed draft) and with no default, so settings without one carry no key.
   * Set by the editor's draft save (and Vizzy's journey-style kind), carried by import and
   * duplicate; every other draft save keeps what's stored (saveLifecycleDraft).
   */
  emailStyle: StoredJourneyStyleSchema.nullable().optional(),
});
export type LifecycleSettings = z.infer<typeof LifecycleSettingsSchema>;

/** Whether these settings start the journey after another journey, not on a product event. */
export function startsAfterJourney(settings: { trigger: { event: string } }): boolean {
  return settings.trigger.event === JOURNEY_COMPLETED_EVENT;
}

/** Whether these settings start the journey when a date passes, not on a product event. */
export function startsOnDate(settings: { trigger: { event: string } }): boolean {
  return settings.trigger.event === DATE_PASSED_EVENT;
}

/** The date start of these settings; null when something else starts the journey (or no date is chosen yet). */
export function dateStartOf(settings: { trigger: { event: string; date?: DateStart | null } }): DateStart | null {
  return startsOnDate(settings) ? (settings.trigger.date ?? null) : null;
}

/** The journey these settings continue from; null when a product event starts it (or none is chosen yet). */
export function continuesFromId(settings: { trigger: { event: string; afterJourneyId?: string | null } }): string | null {
  return startsAfterJourney(settings) ? (settings.trigger.afterJourneyId ?? null) : null;
}

/**
 * test = only listed test users are enrolled, real sends to them;
 * shadow = everyone progresses but mail goes to the shadow inbox;
 * live = real sends (needs a verified sending domain).
 */
export const DeliveryMode = z.enum(["test", "shadow", "live"]);
export type DeliveryMode = z.infer<typeof DeliveryMode>;

export const LifecycleJourneyStatus = z.enum(["draft", "active", "paused", "archived"]);
export type LifecycleJourneyStatus = z.infer<typeof LifecycleJourneyStatus>;

export const LifecycleDraftSchema = z.object({
  graph: LifecycleGraphSchema,
  /** Up to 60: a waitlist journey moved from the original engine has one pool per email. */
  pools: z.array(ContentPoolSchema).max(60),
  settings: LifecycleSettingsSchema,
});
export type LifecycleDraft = z.infer<typeof LifecycleDraftSchema>;

/**
 * Who a journey emails: a connected product's users, or a launch's waitlist.
 * Journeys stored without one are product journeys (see `journeyAudience`).
 */
export const JourneyAudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("product"), connectionId: z.string() }),
  z.object({ kind: z.literal("waitlist"), campaignId: z.string() }),
]);
export type JourneyAudience = z.infer<typeof JourneyAudienceSchema>;

export const LifecycleJourneySchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string().min(1).max(120),
  /** The product connection; "" for waitlist journeys. */
  connectionId: z.string(),
  audience: JourneyAudienceSchema.optional(),
  workspaceId: z.string().nullable().optional(),
  status: LifecycleJourneyStatus,
  deliveryMode: DeliveryMode,
  draft: LifecycleDraftSchema,
  publishedVersion: z.number().int().nullable(),
  liveSince: z.string().nullable().optional(),
  testRecipients: z
    .object({
      userIds: z.array(z.string().max(256)).max(50).default([]),
      emails: z.array(z.string().max(254)).max(50).default([]),
    })
    .default({ userIds: [], emails: [] }),
  shadowInbox: z.string().max(254).nullable().optional(),
  caps: z
    .object({
      sendsPerDay: z.number().int().min(1).max(10000).default(200),
      enrolmentsPerDay: z.number().int().min(1).max(10000).default(500),
    })
    .default({ sendsPerDay: 200, enrolmentsPerDay: 500 }),
  authoredBy: z.enum(["human", "agent"]).default("human"),
  /**
   * Waitlist journeys: A/B winners promoted after publishing, by pool id. A
   * promoted pool sends its winner to everyone, whatever the version says —
   * promotion doesn't need a new version.
   */
  abWinners: z.record(z.string(), z.string()).optional(),
  /**
   * The journey's live own look (EMAIL_JOURNEY_STYLE_ENABLED): the draft's `settings.emailStyle`
   * as last published, which every send from then on wears, whatever version an enrolment is on
   * (the brand's Email style works the same way). Null or absent = the brand's. Written only by
   * publish with the flag on; read leniently, like the draft's.
   */
  emailStyle: StoredJourneyStyleSchema.nullable().optional(),
  /**
   * The journey this one continues from, as last published (null = a product event starts it).
   * Publish copies it from the draft's trigger, so finding the journeys that follow one needs no
   * version reads; the published version's trigger stays the authority at hand-off.
   */
  continuesFrom: z.string().max(64).nullable().optional(),
  /**
   * Whether the published version starts when a date passes (LIFECYCLE_DATE_START). Publish
   * copies it from the draft's trigger, so the daily check finds its journeys without version reads.
   */
  startsOnDate: z.boolean().optional(),
  /**
   * Product sign-up journeys (LIFECYCLE_GO_LIVE_SWEEP): enrolling the people who
   * signed up inside the window once the journey can first email everyone (its
   * mode or the environment's ceiling rose to live). Resumable: the cursor is the
   * `lastSeenAt` reached. Cleared when it drops below live, so the next go-live
   * sweeps again.
   */
  goLiveSweep: z
    .object({
      status: z.enum(["running", "done"]),
      cursor: z.string().nullable(),
      enrolled: z.number().int().nonnegative(),
      updatedAt: z.string(),
    })
    .nullable()
    .optional(),
  /**
   * Journeys that start when a date passes (LIFECYCLE_DATE_START): today's check of the
   * product's people. `day` is the UTC day it's for; resumable across ticks (the cursor is the
   * `lastSeenAt` reached). `enrolled` counts that day's entries.
   */
  dateSweep: z
    .object({
      day: z.string(),
      status: z.enum(["running", "done"]),
      cursor: z.string().nullable(),
      enrolled: z.number().int().nonnegative(),
      /** People read so far today. */
      checked: z.number().int().nonnegative().default(0),
      updatedAt: z.string(),
    })
    .nullable()
    .optional(),
  /**
   * Waitlist journeys: enrolling the launch's existing signups on the first
   * publish (a launch that never ran on the original engine). Resumable: the
   * cursor is the last signup id enrolled.
   */
  backfill: z
    .object({
      status: z.enum(["running", "done"]),
      cursor: z.string().nullable(),
      enrolled: z.number().int().nonnegative(),
      updatedAt: z.string(),
    })
    .nullable()
    .optional(),
  createdBy: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LifecycleJourney = z.infer<typeof LifecycleJourneySchema>;

/** A journey's audience; journeys stored before audiences existed are product journeys. */
export function journeyAudience(j: Pick<LifecycleJourney, "audience" | "connectionId">): JourneyAudience {
  return j.audience ?? { kind: "product", connectionId: j.connectionId };
}

export function isWaitlistJourney(j: Pick<LifecycleJourney, "audience">): boolean {
  return j.audience?.kind === "waitlist";
}

/** An immutable published snapshot; id = `${journeyId}_v${version}`. */
export const LifecycleVersionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  journeyId: z.string(),
  version: z.number().int().min(1),
  graph: LifecycleGraphSchema,
  pools: z.array(ContentPoolSchema),
  settings: LifecycleSettingsSchema,
  publishedAt: z.string(),
  publishedBy: z.string().nullable().optional(),
});
export type LifecycleVersion = z.infer<typeof LifecycleVersionSchema>;

// ---- Runtime -------------------------------------------------------------------------------

export const EnrolmentStatus = z.enum(["active", "completed", "exited"]);
export type EnrolmentStatus = z.infer<typeof EnrolmentStatus>;

export const SentItemSchema = z.object({
  nodeId: z.string(),
  poolId: z.string(),
  itemId: z.string(),
  at: z.string(),
  /** `unknown` = the provider's answer was ambiguous; never resent. `skipped` = never sent (and never retried). */
  status: z.enum(["sent", "unknown", "skipped"]),
  mode: DeliveryMode,
  reason: z.string().max(120).nullable().optional(),
  /** For AI-line items: whether the reviewed AI line went out, or the standard version. */
  version: z.enum(["standard", "ai", "fallback"]).optional(),
});
export type SentItem = z.infer<typeof SentItemSchema>;

/** What every enrolment carries, whatever its audience — the runner's queue item. */
const EnrolmentRuntimeSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  journeyId: z.string(),
  versionId: z.string(),
  mode: DeliveryMode,
  status: EnrolmentStatus,
  stopReason: z.string().max(120).nullable().optional(),
  source: z.enum(["trigger", "manual", "backfill"]),
  /** Backfilled users: every personalised email needs approval (M3). */
  requireApproval: z.boolean().default(false),
  /** When the journey clock starts (the trigger event's time). */
  anchorAt: z.string(),
  /** The journey they finished to enter this one (a journey that continues from another). */
  fromJourneyId: z.string().nullable().optional(),
  /**
   * A journey that starts when a date passes: the date they entered on (UTC ISO). The journey
   * stops when their date moves past it, and one date is one entry.
   */
  dateAt: z.string().nullable().optional(),
  /**
   * Product journeys about one of the person's entities (a brand, a workspace):
   * the one this enrolment is about, fixed once chosen. Null for the person.
   */
  entityId: z.string().nullable().optional(),
  lastSentAt: z.string().nullable().optional(),
  /** The next node to process; null once finished. */
  cursor: z.object({ nodeId: z.string() }).nullable(),
  nextRunAt: z.string().nullable(),
  /** Until this time the next email may ignore the send window (the welcome). */
  windowExemptUntil: z.string().nullable().optional(),
  leaseId: z.string().nullable().optional(),
  leaseUntil: z.string().nullable().optional(),
  /** Set just before a provider call; if still set on the next run, the send is `unknown`. */
  pendingSend: z
    .object({ nodeId: z.string(), poolId: z.string(), itemId: z.string(), at: z.string() })
    .nullable()
    .optional(),
  sentItems: z.array(SentItemSchema).max(60).default([]),
  usedInsightIds: z.array(z.string().max(64)).max(60).default([]),
  /** Consecutive failed runs (backoff; exits after a limit). */
  failures: z.number().int().nonnegative().default(0),
  log: z
    .array(z.object({ at: z.string(), event: z.string().max(80), detail: z.string().max(300).nullable().optional() }))
    .max(40)
    .default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EnrolmentRuntime = z.infer<typeof EnrolmentRuntimeSchema>;

/**
 * One product user's progress through one journey — also the runner's queue
 * item (`nextRunAt` + lease). Id = `enr_<sha256(journeyId:productUserId)>`, so a
 * user enters a journey at most once — except a journey that starts when a date
 * passes and lets people enter again, whose ids also carry the date entered on
 * (src/lib/lifecycle/enrol.ts `enrolmentIdFor`).
 */
export const LifecycleEnrolmentSchema = EnrolmentRuntimeSchema.extend({
  connectionId: z.string(),
  productUserId: z.string(),
  externalUserId: z.string(),
});
export type LifecycleEnrolment = z.infer<typeof LifecycleEnrolmentSchema>;

/** Why a waitlist enrolment is parked out of the queue (`nextRunAt` null). */
export const WaitlistHeldReason = z.enum(["journey_paused", "launch_archived"]);
export type WaitlistHeldReason = z.infer<typeof WaitlistHeldReason>;

/**
 * One waitlist signup's progress through a launch's waitlist journey, in its own
 * collection (`waitlist_enrolments`) with its own due queue, so a big waitlist
 * never slows product journeys down. Id = `enr_<sha256(journeyId\nsignupId)>`,
 * so a person enters a journey at most once.
 */
export const WaitlistEnrolmentSchema = EnrolmentRuntimeSchema.extend({
  campaignId: z.string(),
  signupId: z.string(),
  /** Parked while the journey is paused or the launch archived; released on resume. */
  heldReason: WaitlistHeldReason.nullable().optional(),
  heldAt: z.string().nullable().optional(),
  /** A shadow rehearsal's enrolment: never stamps the person, deleted at the switch. */
  rehearsal: z.boolean().optional(),
});
export type WaitlistEnrolment = z.infer<typeof WaitlistEnrolmentSchema>;

/** A signed webhook waiting to be delivered to the product (retried with backoff). */
export const LifecycleWebhookSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  connectionId: z.string(),
  type: z.enum(["email_preferences.updated", "email.suppressed"]),
  data: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "done", "expired"]),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.string(),
  lastError: z.string().max(300).nullable().optional(),
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type LifecycleWebhook = z.infer<typeof LifecycleWebhookSchema>;

/** Exact daily send + enrolment counters per journey; id = `${journeyId}_${yyyymmdd}` (UTC day). */
export const LifecycleCounterSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  journeyId: z.string(),
  day: z.string(),
  sends: z.number().int().nonnegative(),
  enrolments: z.number().int().nonnegative().default(0),
  ttlAt: z.unknown().optional(),
});
export type LifecycleCounter = z.infer<typeof LifecycleCounterSchema>;

// ---- AI lines + approvals (M3) --------------------------------------------------------------

/**
 * pending → (prepared) awaiting_approval → approved | use_fallback | skipped
 * → used (consumed at send). `superseded`: the person's path changed, so this
 * email won't be the one they get.
 */
export const AiDraftStatus = z.enum([
  "pending",
  "awaiting_approval",
  "approved",
  "use_fallback",
  "skipped",
  "superseded",
  "used",
]);
export type AiDraftStatus = z.infer<typeof AiDraftStatus>;

/** Why the standard (non-AI) version went out instead of the AI line. */
export const FallbackReason = z.enum([
  "no_draft",
  "no_decision",
  "staff_choice",
  "insight_stale",
  "validation_failed",
  "generation_failed",
  "no_insight",
  "draft_cap",
  "superseded",
  "ai_off",
  "changed_during_send",
  "render_failed",
]);
export type FallbackReason = z.infer<typeof FallbackReason>;

/**
 * A per-person AI line for one upcoming `ai_line` email, prepared ~12 h ahead
 * and reviewed by staff. Id = `lcd_<sha256(enrolmentId:poolId:itemId)>`, so the
 * runner finds it directly at send time. No PII goes to the model: the line is
 * written from the product's insight + facts only.
 */
export const AiDraftSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  enrolmentId: z.string(),
  journeyId: z.string(),
  versionId: z.string(),
  connectionId: z.string(),
  productUserId: z.string(),
  externalUserId: z.string(),
  nodeId: z.string(),
  poolId: z.string(),
  itemId: z.string(),
  itemLabel: z.string().max(120),
  status: AiDraftStatus,
  requireApproval: z.boolean().default(false),
  /** When the email is expected to go out. */
  sendAt: z.string(),
  /** When to write the line (sendAt − 12 h, or now). */
  prepareAt: z.string(),
  /** Staff decisions close here (sendAt − 15 min). */
  approvalDeadline: z.string(),
  prepareLeaseUntil: z.string().nullable().optional(),
  insightId: z.string().max(64).nullable().optional(),
  insightSentence: z.string().max(300).nullable().optional(),
  aiLine: z.string().max(400).nullable().optional(),
  subjectVariant: z.string().max(120).nullable().optional(),
  standardSubject: z.string().max(200).nullable().optional(),
  factsSnapshot: z
    .array(z.object({ id: z.string().max(64), label: z.string().max(120), display: z.string().max(200) }))
    .max(20)
    .default([]),
  /** Names the validator accepts (facts, product, brand, glossary). */
  allowedTerms: z.array(z.string().max(200)).max(200).default([]),
  /** Extra names staff vouched for when editing. */
  attestedTerms: z.array(z.string().max(120)).max(20).default([]),
  validationIssues: z.array(z.string().max(200)).max(20).default([]),
  previewHtml: z.string().max(200_000).nullable().optional(),
  fallbackReason: FallbackReason.nullable().optional(),
  /** Bumped on every change; a decision must name the version it saw. */
  draftVersion: z.number().int().min(1),
  decidedBy: z.string().max(254).nullable().optional(),
  decidedAt: z.string().nullable().optional(),
  usedAt: z.string().nullable().optional(),
  usedVersion: z.enum(["ai", "fallback", "skip"]).nullable().optional(),
  ttlAt: z.unknown().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AiDraft = z.infer<typeof AiDraftSchema>;
