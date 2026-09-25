import { z } from "zod";
import { ConsentBasis, EVENT_NAME_RE, STEP_ID_RE, TRAIT_KEY_RE } from "@/lib/types/productConnection";
import { RESERVED_EVENTS, TimestampSchema } from "../protocol";

/**
 * API v2 — the state-based contract a connected product calls. ONE module shared
 * by the routes, the OpenAPI spec, the docs and the SDK's tests, so they can't
 * drift.
 *
 * A product sends each user's CURRENT state with PATCH, as a JSON Merge Patch
 * (RFC 7396): fields sent replace ours, fields left out stay, `null` clears, and
 * the maps (`steps`, `facts`, `traits`) merge key by key. YouGrow keeps the state
 * and decides everything else — enrolment, exclusion, what to send and when.
 * Auth is HTTP Basic: the connection's key id and secret, over HTTPS.
 */

export const V2_PATHS = {
  user: "/api/v2/users/{userId}",
  batch: "/api/v2/users/batch",
  events: "/api/v2/users/{userId}/events",
} as const;

export const V2_LIMITS = {
  /** Request body, for every endpoint. */
  maxBodyBytes: 512 * 1024,
  /** Users per batch. */
  maxBatch: 100,
  maxTraits: 50,
  maxFacts: 50,
  maxSteps: 50,
  /** One event's properties, serialised. */
  maxPropertiesBytes: 4 * 1024,
} as const;

/** `batch` is a route, so it can't be a user id. */
export const RESERVED_USER_IDS = new Set(["batch"]);

const LOCALE_RE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/;
/** Profile fields that are top-level in v2 — not accepted as traits. */
const IDENTITY_KEYS = new Set(["email", "firstName", "first_name", "lastName", "last_name", "timezone", "locale"]);

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const UserIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((id) => !RESERVED_USER_IDS.has(id), { message: '"batch" is reserved' });

const FactValueSchema = z.union([z.string().max(200), z.number().finite(), z.boolean()]);
const TraitValueSchema = z.union([z.string().max(500), z.number().finite(), z.boolean()]);

/** The body of PATCH /api/v2/users/{userId}: any subset of the user's state. */
export const UserPatchSchema = z
  .object({
    email: z.string().trim().email().max(254).nullable().optional(),
    firstName: z.string().max(100).nullable().optional(),
    lastName: z.string().max(100).nullable().optional(),
    timezone: z
      .string()
      .max(64)
      .refine(isValidTimezone, { message: "not an IANA time zone, e.g. Europe/London" })
      .nullable()
      .optional(),
    locale: z.string().max(16).regex(LOCALE_RE, { message: "not a BCP 47 locale, e.g. en-GB" }).nullable().optional(),
    /** When the account was created. Starts sign-up journeys while inside their window. */
    signedUpAt: TimestampSchema.optional(),
    /** The legal basis for marketing email. */
    consent: ConsentBasis.nullable().optional(),
    /** false = the person opted out of lifecycle email in your product. */
    subscribed: z.boolean().optional(),
    /** Never email this person, in any journey (staff, test accounts, invited teammates). */
    excluded: z.object({ reason: z.string().min(1).max(64) }).strict().nullable().optional(),
    /** Onboarding step id → when it was done (null: not done). */
    steps: z.record(z.string().regex(STEP_ID_RE, { message: "step ids are lower-case letters, digits, _ and -" }), TimestampSchema.nullable()).optional(),
    /** Fact id → its latest value (null removes it). */
    facts: z.record(z.string().min(1).max(64), FactValueSchema.nullable()).optional(),
    /** Anything else journeys branch on (null removes a key). */
    traits: z.record(z.string().regex(TRAIT_KEY_RE, { message: "trait keys start with a letter; letters, digits, _ and -" }), TraitValueSchema.nullable()).optional(),
    /** When you read this state. A write older than the stored one is ignored. */
    updatedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((patch, ctx) => {
    for (const key of Object.keys(patch.traits ?? {})) {
      if (IDENTITY_KEYS.has(key)) {
        ctx.addIssue({ code: "custom", path: ["traits", key], message: `send ${key} as a top-level field, not a trait` });
      }
    }
    if (Object.keys(patch.steps ?? {}).length > V2_LIMITS.maxSteps) {
      ctx.addIssue({ code: "custom", path: ["steps"], message: `at most ${V2_LIMITS.maxSteps} steps` });
    }
    if (Object.keys(patch.facts ?? {}).length > V2_LIMITS.maxFacts) {
      ctx.addIssue({ code: "custom", path: ["facts"], message: `at most ${V2_LIMITS.maxFacts} facts` });
    }
    if (Object.keys(patch.traits ?? {}).length > V2_LIMITS.maxTraits) {
      ctx.addIssue({ code: "custom", path: ["traits"], message: `at most ${V2_LIMITS.maxTraits} traits` });
    }
  });
export type UserPatch = z.infer<typeof UserPatchSchema>;

/** One entry of a batch: a user id plus a patch. Validated per item. */
export const BatchItemSchema = z.object({ userId: UserIdSchema }).passthrough();

/** The body of POST /api/v2/users/batch. Items are validated one by one, so one bad item never fails the rest. */
export const BatchRequestSchema = z.object({ users: z.array(z.unknown()).min(1).max(V2_LIMITS.maxBatch) }).strict();

const RESERVED = new Set<string>(Object.values(RESERVED_EVENTS));

/** The body of POST /api/v2/users/{userId}/events: a milestone. */
export const EventRequestSchema = z
  .object({
    event: z
      .string()
      .max(80)
      .regex(EVENT_NAME_RE, { message: "lower-case, dot-separated, e.g. report.exported" })
      .refine((e) => !RESERVED.has(e), { message: "reserved — send it as state (signedUpAt, steps, subscribed) or DELETE the user" }),
    properties: z.record(z.string(), z.unknown()).optional(),
    occurredAt: TimestampSchema.optional(),
    /** Makes a retry harmless: the same key is recorded once. */
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();
export type EventRequest = z.infer<typeof EventRequestSchema>;

// ---- Responses (also the OpenAPI response schemas) ----------------------------

/** The user's state as YouGrow holds it. */
export const UserStateSchema = z.object({
  userId: z.string(),
  email: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  timezone: z.string().nullable(),
  locale: z.string().nullable(),
  signedUpAt: z.string().nullable(),
  consent: ConsentBasis.nullable(),
  subscribed: z.boolean(),
  excluded: z.object({ reason: z.string() }).nullable(),
  steps: z.record(z.string(), z.string()),
  facts: z.record(z.string(), FactValueSchema),
  traits: z.record(z.string(), TraitValueSchema),
  updatedAt: z.string().nullable(),
});
export type UserState = z.infer<typeof UserStateSchema>;

/** GET adds what YouGrow decided: journeys and opt-outs. */
export const UserViewSchema = UserStateSchema.extend({
  enrolments: z.array(
    z.object({
      journeyId: z.string(),
      status: z.string(),
      mode: z.string(),
      enrolledAt: z.string(),
    }),
  ),
  /** Unsubscribes made in YouGrow's emails. They hold until the person lifts them; the API can't. */
  optOuts: z.array(z.object({ scope: z.enum(["all", "category"]), category: z.string().nullable(), at: z.string().nullable() })),
});
export type UserView = z.infer<typeof UserViewSchema>;

export const SkipReason = z.enum(["stale_write", "deleted_later"]);
export type SkipReason = z.infer<typeof SkipReason>;

export const PatchResponseSchema = z.union([
  z.object({ applied: z.literal(true), user: UserStateSchema }),
  z.object({
    applied: z.literal(false),
    reason: SkipReason,
    storedUpdatedAt: z.string().nullable().optional(),
    user: UserStateSchema.optional(),
  }),
]);
export type PatchResponse = z.infer<typeof PatchResponseSchema>;

export const FieldErrorSchema = z.object({ path: z.string(), message: z.string() });

export const BatchResponseSchema = z.object({
  applied: z.number().int(),
  ignored: z.number().int(),
  failed: z.number().int(),
  /** Only the ignored and failed items; applied ones are counted. */
  results: z.array(
    z.object({
      index: z.number().int(),
      userId: z.string().nullable(),
      status: z.enum(["ignored", "failed"]),
      reason: z.string(),
      fields: z.array(FieldErrorSchema).optional(),
    }),
  ),
});
export type BatchResponse = z.infer<typeof BatchResponseSchema>;

export const EventResponseSchema = z.object({ recorded: z.boolean(), duplicate: z.boolean() });

export const ErrorSchema = z.object({
  error: z.string(),
  fields: z.array(FieldErrorSchema).optional(),
  message: z.string().optional(),
});

/** Zod issues → the `fields` of a 400 (`path` like "traits.plan"). */
export function fieldErrors(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.slice(0, 20).map((i) => ({ path: i.path.length ? i.path.join(".") : "(body)", message: i.message }));
}
