import { z } from "zod";
import { ConditionOperator } from "./journey";
import { EmailLayoutSchema } from "./emailLayout";

/**
 * Lifecycle journeys — branching email sequences for a CONNECTED PRODUCT's users
 * (e.g. vizzybl.ai's post-signup onboarding), run by the lifecycle runner
 * (src/lib/lifecycle/runner.ts). Separate from the waitlist Journey engine: the
 * recipient is a product user, conditions read the product's catalog (steps,
 * traits, facts), and sends follow a per-recipient local-time send window.
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
 */
export const LIFECYCLE_FIELD_RE =
  /^(?:(?:trait|step|fact|milestone)\.[A-Za-z0-9][A-Za-z0-9_.-]{0,79}|onboarding\.(?:complete|steps_done|steps_remaining)|consent\.basis|enrolment\.(?:emails_sent|days_since_enrol))$/;

export const LifecycleConditionSchema = z.object({
  field: z.string().regex(LIFECYCLE_FIELD_RE),
  operator: ConditionOperator,
  value: z.union([z.number(), z.string(), z.boolean()]).optional(),
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
});
export type ContentPool = z.infer<typeof ContentPoolSchema>;

// ---- Graph -------------------------------------------------------------------------------

export const WaitConfigSchema = z.object({
  /** At least this long after the previous email (or enrolment, before the first). */
  minHours: z.number().min(0).max(24 * 60),
  /** And at least this long after enrolment. */
  sinceEnrolHours: z.number().min(0).max(24 * 60).optional(),
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

export const SendPolicySchema = z.object({
  /** Allowed LOCAL weekdays, 0 = Sunday … 6 = Saturday. */
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
  startHour: z.number().int().min(0).max(23).default(9),
  startMinute: z.number().int().min(0).max(59).default(0),
  /** Sends spread over this many minutes after the start (stable per user). */
  windowMinutes: z.number().int().min(15).max(720).default(90),
  /** Nothing sends after this many days from enrolment. */
  hardStopDays: z.number().int().min(1).max(60).default(12),
  /** Used when neither the user nor the connection has a valid timezone. */
  fallbackTimezone: z.string().max(64).default("Europe/London"),
}).refine((p) => p.startHour * 60 + p.startMinute + p.windowMinutes <= 24 * 60, {
  message: "the send window must end by midnight",
});
export type SendPolicy = z.infer<typeof SendPolicySchema>;

export const LifecycleSettingsSchema = z.object({
  trigger: z
    .object({
      event: z.string().max(80).default("user.signed_up"),
      /** Older trigger events (e.g. a backfill) don't enrol automatically. */
      maxEventAgeHours: z.number().int().min(1).max(720).default(72),
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
});
export type LifecycleSettings = z.infer<typeof LifecycleSettingsSchema>;

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
  pools: z.array(ContentPoolSchema).max(20),
  settings: LifecycleSettingsSchema,
});
export type LifecycleDraft = z.infer<typeof LifecycleDraftSchema>;

export const LifecycleJourneySchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string().min(1).max(120),
  connectionId: z.string(),
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
  createdBy: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LifecycleJourney = z.infer<typeof LifecycleJourneySchema>;

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
  /** `unknown` = the provider's answer was ambiguous; never resent. */
  status: z.enum(["sent", "unknown", "skipped"]),
  mode: DeliveryMode,
  reason: z.string().max(120).nullable().optional(),
});
export type SentItem = z.infer<typeof SentItemSchema>;

/**
 * One product user's progress through one journey — also the runner's queue
 * item (`nextRunAt` + lease). Id = `enr_<sha256(journeyId:productUserId)>`, so a
 * user enters a journey at most once.
 */
export const LifecycleEnrolmentSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  journeyId: z.string(),
  versionId: z.string(),
  connectionId: z.string(),
  productUserId: z.string(),
  externalUserId: z.string(),
  mode: DeliveryMode,
  status: EnrolmentStatus,
  stopReason: z.string().max(120).nullable().optional(),
  source: z.enum(["trigger", "manual", "backfill"]),
  /** Backfilled users: every personalised email needs approval (M3). */
  requireApproval: z.boolean().default(false),
  /** When the journey clock starts (the trigger event's time). */
  anchorAt: z.string(),
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
export type LifecycleEnrolment = z.infer<typeof LifecycleEnrolmentSchema>;

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
