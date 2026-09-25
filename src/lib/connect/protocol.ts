import { z } from "zod";
import {
  ConsentBasis,
  EVENT_NAME_RE,
  STEP_ID_RE,
  TRAIT_KEY_RE,
} from "@/lib/types/productConnection";

/**
 * The product-connection protocol shared by the platform's internals, the
 * context client and the webhook sender. What a product calls — API v2 — lives
 * in ./v2/contract.ts (HTTP Basic auth, state writes).
 *
 * Platform → product (context pulls, webhooks) carries a JWT signed with the
 * platform's own KMS key, verified against our published JWKS (outboundToken.ts),
 * so nothing a product holds can be used to forge our requests. The Node SDK
 * implements the same checks independently; both are pinned by the shared test
 * vectors in sdk/node/test/vectors.json.
 *
 * (v1's per-request HMAC signing of POST /api/v1/events was removed with v1 on
 * 2026-09-25.)
 */

/** Sent on context pulls and webhooks: which connection the request is for. */
export const HEADER_KEY_ID = "x-yougrow-key-id";

export const LIMITS = {
  /** Messages per internal batch. */
  maxBatch: 100,
  /** One message's traits/properties, serialised. */
  maxPayloadBytes: 4 * 1024,
  /** Custom traits kept per product user. */
  maxTraits: 50,
  /** A context endpoint's response body. */
  maxContextBytes: 64 * 1024,
  /** How far in the future a message timestamp may be. */
  maxFutureSkewMs: 24 * 3600_000,
} as const;

// ---- Ingest messages -----------------------------------------------------------

/** ISO-8601 with a zone designator (Z or ±hh:mm) — local times are ambiguous. */
export const TimestampSchema = z.iso.datetime({ offset: true });

const MessageId = z.string().min(1).max(128);
const UserId = z.string().min(1).max(256);
const TraitValue = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
const Traits = z
  .record(z.string().regex(TRAIT_KEY_RE), TraitValue)
  .refine((t) => Object.keys(t).length <= LIMITS.maxTraits, "too many traits");

export const IdentifyMessageSchema = z.object({
  type: z.literal("identify"),
  messageId: MessageId,
  userId: UserId,
  timestamp: TimestampSchema,
  traits: Traits.default({}),
  consent: z
    .object({ basis: ConsentBasis, source: z.string().max(64).optional() })
    .optional(),
});

export const TrackMessageSchema = z.object({
  type: z.literal("track"),
  messageId: MessageId,
  userId: UserId,
  timestamp: TimestampSchema,
  event: z.string().max(80).regex(EVENT_NAME_RE),
  properties: z.record(z.string(), z.unknown()).default({}),
  traits: Traits.optional(),
});

export const IngestMessageSchema = z.discriminatedUnion("type", [
  IdentifyMessageSchema,
  TrackMessageSchema,
]);
export type IngestMessage = z.infer<typeof IngestMessageSchema>;
export type IdentifyMessage = z.infer<typeof IdentifyMessageSchema>;
export type TrackMessage = z.infer<typeof TrackMessageSchema>;


/** Events the platform gives meaning to (any other event is a plain milestone). */
export const RESERVED_EVENTS = {
  signedUp: "user.signed_up",
  stepCompleted: "onboarding.step_completed",
  onboardingCompleted: "onboarding.completed",
  userDeleted: "user.deleted",
  preferencesUpdated: "email_preferences.updated",
  /** Derived from state: someone YouGrow already knew moved to a consent basis the connection accepts for marketing. */
  marketingConsentGranted: "user.marketing_consent_granted",
} as const;

export const StepCompletedPropsSchema = z.object({ step: z.string().regex(STEP_ID_RE) });

export const PreferencesUpdatedPropsSchema = z.object({
  category: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  subscribed: z.boolean(),
});

// ---- Context endpoint ------------------------------------------------------------

export const ContextPurpose = z.enum(["send", "prepare", "condition", "test"]);
export type ContextPurpose = z.infer<typeof ContextPurpose>;

export const ContextRequestSchema = z.object({
  userId: UserId,
  purpose: ContextPurpose,
  journeyId: z.string().max(64).nullable().optional(),
  nodeId: z.string().max(64).nullable().optional(),
  requestId: z.string().min(1).max(64),
});
export type ContextRequest = z.infer<typeof ContextRequestSchema>;

const FactValue = z.union([z.string().max(200), z.number().finite(), z.boolean()]);

/**
 * What a product returns for one user. Facts carry the truth (numbers live only
 * here and in the product's deterministic insight sentences); `hold` / `exit`
 * let the product keep its own stop rules (staff, invitees, pending deletion).
 */
export const ContextResponseSchema = z.object({
  asOf: TimestampSchema,
  steps: z
    .array(
      z.object({
        id: z.string().regex(STEP_ID_RE),
        label: z.string().min(1).max(120),
        done: z.boolean(),
        doneAt: TimestampSchema.nullable().optional(),
        url: z.string().max(2000).nullable().optional(),
        blocked: z.string().max(200).nullable().optional(),
      }),
    )
    .max(20)
    .default([]),
  nextStep: z
    .object({
      id: z.string().regex(STEP_ID_RE),
      label: z.string().min(1).max(120),
      url: z.string().max(2000).nullable().optional(),
    })
    .nullable()
    .optional(),
  facts: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(120),
        value: FactValue,
        unit: z.string().max(20).nullable().optional(),
        display: z.string().max(200).nullable().optional(),
        source: z.string().max(120).nullable().optional(),
        observedAt: TimestampSchema.nullable().optional(),
      }),
    )
    .max(50)
    .default([]),
  insights: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        sentence: z.string().min(1).max(300),
        factIds: z.array(z.string().max(64)).max(10).default([]),
        weight: z.number().min(0).max(1).default(0.5),
        supportsStep: z.string().max(64).nullable().optional(),
      }),
    )
    .max(20)
    .default([]),
  consent: z
    .object({ basis: ConsentBasis, categories: z.record(z.string(), z.boolean()).optional() })
    .nullable()
    .optional(),
  hold: z
    .object({ until: TimestampSchema.nullable().optional(), reason: z.string().max(200) })
    .nullable()
    .optional(),
  exit: z.object({ reason: z.string().max(200) }).nullable().optional(),
});
export type ProductContext = z.infer<typeof ContextResponseSchema>;

// ---- Webhooks (platform → product) -------------------------------------------------

export const WebhookPayloadSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(["email_preferences.updated", "email.suppressed", "connection.test"]),
  createdAt: TimestampSchema,
  data: z.record(z.string(), z.unknown()),
});
export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

/** A compact, single-line reason for a Zod failure (for rejections + debugger). */
export function zodReason(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "invalid";
  const path = issue.path.length ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`.slice(0, 300);
}
