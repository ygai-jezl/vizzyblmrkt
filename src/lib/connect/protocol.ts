import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  ConsentBasis,
  EVENT_NAME_RE,
  STEP_ID_RE,
  TRAIT_KEY_RE,
} from "@/lib/types/productConnection";

/**
 * The product-connection wire protocol — ONE module shared by the ingest API,
 * the context client and the webhook sender. The Node SDK (sdk/node) implements
 * the same signing independently; both are pinned by the shared test vectors in
 * sdk/node/test/vectors.json.
 *
 * Every request in every direction carries:
 *   X-YouGrow-Key-Id:    the connection's public key id
 *   X-YouGrow-Timestamp: unix seconds
 *   X-YouGrow-Signature: v1=<hex HMAC-SHA256(secret, `${direction}:${timestamp}.${rawBody}`)>
 * The direction prefix (events | context | webhook) means a signature captured
 * in one direction can never be replayed in another. The timestamp bounds replay
 * to ±5 minutes, and ingest messageIds make an in-window replay a no-op.
 */

export const HEADER_KEY_ID = "x-yougrow-key-id";
export const HEADER_TIMESTAMP = "x-yougrow-timestamp";
export const HEADER_SIGNATURE = "x-yougrow-signature";

export type SignDirection = "events" | "context" | "webhook";

/** Accepted clock skew between signer and verifier. */
export const SIGNATURE_TOLERANCE_SEC = 300;

export const LIMITS = {
  /** Ingest request body. */
  maxBodyBytes: 512 * 1024,
  /** Messages per ingest request. */
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

// ---- Signing -----------------------------------------------------------------

export function signBody(
  secret: string,
  direction: SignDirection,
  timestampSec: number,
  rawBody: string,
): string {
  const mac = createHmac("sha256", secret)
    .update(`${direction}:${timestampSec}.${rawBody}`)
    .digest("hex");
  return `v1=${mac}`;
}

/** The three auth headers (plus content-type) for an outbound signed request. */
export function signedHeaders(
  keyId: string,
  secret: string,
  direction: SignDirection,
  rawBody: string,
  nowMs = Date.now(),
): Record<string, string> {
  const ts = Math.floor(nowMs / 1000);
  return {
    "content-type": "application/json",
    [HEADER_KEY_ID]: keyId,
    [HEADER_TIMESTAMP]: String(ts),
    [HEADER_SIGNATURE]: signBody(secret, direction, ts, rawBody),
  };
}

export type VerifyFailure =
  | "missing_signature"
  | "bad_timestamp"
  | "stale_timestamp"
  | "bad_signature";

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

/**
 * Verify a signed request against any of `secrets` (current + a rotating-out
 * previous one). Constant-time comparison. The header may carry several
 * comma-separated `v1=` values (a signer mid-rotation can sign with both).
 */
export function verifySignature(input: {
  secrets: string[];
  direction: SignDirection;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowMs?: number;
  toleranceSec?: number;
}): VerifyResult {
  if (!input.timestamp || !input.signature) return { ok: false, reason: "missing_signature" };
  if (!/^\d{1,12}$/.test(input.timestamp)) return { ok: false, reason: "bad_timestamp" };
  const ts = Number(input.timestamp);
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - ts) > (input.toleranceSec ?? SIGNATURE_TOLERANCE_SEC)) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const provided = input.signature
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1="))
    .map((s) => Buffer.from(s));
  for (const secret of input.secrets) {
    const expected = Buffer.from(signBody(secret, input.direction, ts, input.rawBody));
    for (const p of provided) {
      if (p.length === expected.length && timingSafeEqual(p, expected)) return { ok: true };
    }
  }
  return { ok: false, reason: "bad_signature" };
}

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

export const IngestBodySchema = z.object({
  batch: z.array(z.unknown()).min(1),
});

/** Events the platform gives meaning to (any other event is a plain milestone). */
export const RESERVED_EVENTS = {
  signedUp: "user.signed_up",
  stepCompleted: "onboarding.step_completed",
  onboardingCompleted: "onboarding.completed",
  userDeleted: "user.deleted",
  preferencesUpdated: "email_preferences.updated",
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
