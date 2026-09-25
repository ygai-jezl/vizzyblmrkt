import { z } from "zod";
import { ContextRequestSchema, ContextResponseSchema, LIMITS, TimestampSchema, WebhookPayloadSchema } from "@/lib/connect/protocol";
import {
  BatchResponseSchema,
  ErrorSchema,
  EventRequestSchema,
  EventResponseSchema,
  FieldErrorSchema,
  MeResponseSchema,
  PatchResponseSchema,
  UserIdSchema,
  UserPatchSchema,
  UserStateSchema,
  UserViewSchema,
  V2_LIMITS,
  V2_PATHS,
} from "@/lib/connect/v2/contract";
import { BATCH_ITEM_NOTES, BatchItemDocSchema, BatchRequestDocSchema, describeProperties, tidy, toJson, USER_NOTES, type Io } from "./schemas";
import { STATE_NOTES, USER_ID_NOTES } from "./userFields";

/**
 * API v2 as an OpenAPI 3.1 document, built from the contract's Zod schemas
 * (src/lib/connect/v2/contract.ts) — so the spec, the routes and the docs can't
 * drift. What you send is the schemas' input side, what we send is their output.
 * The top-level `webhooks` describe what YouGrow sends YOU: the optional context
 * request and webhook notifications. Served at /developers/openapi.json and
 * rendered at /developers/api.
 */

type Json = Record<string, unknown>;

const kb = (bytes: number) => `${bytes / 1024} KB`;

interface Component {
  schema: z.ZodType;
  /** input: you send it; output: we send it. */
  io: Io;
  description: string;
  /** Descriptions for its properties. */
  notes?: Record<string, string>;
}

/** Every schema component, with its Zod source. The tests validate each example against these. */
export const COMPONENTS: Record<string, Component> = {
  // What you send.
  UserPatch: {
    schema: UserPatchSchema,
    io: "input",
    description:
      "Any subset of a user's state, as a JSON Merge Patch (RFC 7396): fields you send replace ours, fields you leave out stay, `null` clears one, and `steps`, `facts` and `traits` merge key by key. Unknown fields are refused.",
    notes: USER_NOTES,
  },
  BatchItem: { schema: BatchItemDocSchema, io: "input", description: "One user in a batch: their id plus the same fields as a PATCH.", notes: BATCH_ITEM_NOTES },
  BatchRequest: {
    schema: BatchRequestDocSchema,
    io: "input",
    description: `1–${V2_LIMITS.maxBatch} users. Each is checked and applied on its own, so one bad item never fails the rest.`,
  },
  EventRequest: {
    schema: EventRequestSchema,
    io: "input",
    description: "An optional milestone that journeys can start from or branch on.",
    notes: {
      event:
        "Lower-case, dot-separated, ≤ 80 chars, e.g. `report.exported`. `user.signed_up`, `onboarding.step_completed`, `user.marketing_consent_granted`, `user.deleted` and `email_preferences.updated` are refused: send `signedUpAt`, `steps`, `consent` or `subscribed`, or DELETE the user. `onboarding.completed` marks the user activated.",
      properties: `Anything useful, ≤ ${kb(V2_LIMITS.maxPropertiesBytes)} serialised.`,
      occurredAt: "When it happened (ISO 8601 with a timezone). Defaults to now.",
      idempotencyKey: "Makes a retry harmless: the same key is recorded once.",
    },
  },
  ContextResponse: {
    schema: ContextResponseSchema,
    io: "input",
    description: `What your context endpoint returns for one user: at most ${kb(LIMITS.maxContextBytes)}, within your timeout. Only \`asOf\` is required.`,
  },
  // What we send.
  UserState: { schema: UserStateSchema, io: "output", description: "A user's state as YouGrow holds it.", notes: STATE_NOTES },
  UserView: {
    schema: UserViewSchema,
    io: "output",
    description: "A user's state, plus what YouGrow decided: the journeys they're in and their opt-outs.",
    notes: STATE_NOTES,
  },
  PatchResponse: {
    schema: PatchResponseSchema,
    io: "output",
    description:
      "`applied: true` — saved; `user` is what we now hold, and `ignoredFields` lists any profile field (`email`, `firstName`, `lastName`, `timezone`, `locale`) whose value was invalid and so left as it was. `applied: false` — skipped because we hold something newer: `stale_write` (older than the stored `updatedAt`) or `deleted_later` (older than a later DELETE). Neither needs a retry.",
  },
  BatchResponse: {
    schema: BatchResponseSchema,
    io: "output",
    description:
      "How many users were applied, ignored and failed. `results` lists the items that weren't applied, and applied ones whose invalid profile fields were left as they were (`fields_ignored`); `index` is the item's position in your `users` array.",
    notes: {
      applied: "Users whose state was saved (some perhaps with `fields_ignored`, listed in `results`).",
      ignored: "Users skipped because we hold something newer (`stale_write` or `deleted_later`). Nothing to do.",
      failed: "Users not saved: `invalid` (see `fields`) — fix and resend — or `internal_error` — resend.",
    },
  },
  MeResponse: {
    schema: MeResponseSchema,
    io: "output",
    description: "The connection behind your key.",
    notes: {
      connection: "Its id, name, environment (`staging`, `production`, or null when it has none) and status.",
      keyId: "The key id you authenticated with.",
      rotating: "A new secret was issued in the last 24 hours; the previous one keeps working until then.",
    },
  },
  EventResponse: {
    schema: EventResponseSchema,
    io: "output",
    description: "`recorded: true` — saved. `duplicate: true` — an event with this `idempotencyKey` was already recorded, so this one wasn't.",
  },
  Error: {
    schema: ErrorSchema,
    io: "output",
    description: "An error. `error` is a stable code; a 400 lists what was wrong in `fields`.",
    notes: {
      error:
        "A stable code: `invalid`, `invalid_json`, `unauthorized`, `not_found`, `api_disabled`, `body_too_large`, `rate_limited`, `internal` or `unavailable`.",
      fields: "For `invalid`: each problem, by path.",
      message: "Sometimes: a hint in words.",
    },
  },
  FieldError: {
    schema: FieldErrorSchema,
    io: "output",
    description: "One problem with a request body.",
    notes: { path: "Where, e.g. `traits.plan` or `timezone`; `(body)` for the body as a whole.", message: "What's wrong." },
  },
  ContextRequest: { schema: ContextRequestSchema, io: "output", description: "What YouGrow POSTs to your context endpoint about one user." },
  WebhookPayload: { schema: WebhookPayloadSchema, io: "output", description: "What YouGrow POSTs to your webhook endpoint." },
  // Both sides.
  Timestamp: { schema: TimestampSchema, io: "input", description: "ISO 8601 with a timezone, e.g. `2026-09-25T10:00:00Z`." },
};

/** Components used on both sides of the wire (their input and output schemas are the same). */
const SHARED = new Set(["Timestamp"]);

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

function components(): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const io of ["input", "output"] as const) {
    const registry = z.registry<{ id: string }>();
    for (const [id, c] of Object.entries(COMPONENTS)) if (c.io === io || SHARED.has(id)) registry.add(c.schema, { id });
    const { schemas } = z.toJSONSchema(registry, { io, target: "draft-2020-12", uri: (id) => `#/components/schemas/${id}` });
    for (const [id, generated] of Object.entries(schemas)) {
      // "__shared" holds schemas extracted for reuse or cycles — none today; a contract change that adds some must register them.
      if (!Object.hasOwn(COMPONENTS, id)) throw new Error(`openapi: unexpected generated schema "${id}"`);
      if (out[id] && SHARED.has(id)) continue;
      const { $schema: _dialect, $id: _id, ...schema } = generated as Json;
      out[id] = tidy(schema, io);
    }
  }
  for (const [id, c] of Object.entries(COMPONENTS)) {
    const schema = out[id]!;
    schema.description = c.description;
    if (c.notes) describeProperties(schema, c.notes);
  }
  return out;
}

// ---- Examples (the tests check each one against its schema) ---------------------

const ALEX: Json = {
  userId: "user_123",
  email: "alex@example.com",
  firstName: "Alex",
  lastName: null,
  timezone: "Europe/London",
  locale: "en-GB",
  signedUpAt: "2026-09-25T09:30:00.000Z",
  consent: "soft_opt_in",
  subscribed: true,
  excluded: null,
  steps: { create_project: "2026-09-25T10:02:00.000Z" },
  facts: { projects: 1 },
  traits: { plan: "pro" },
  updatedAt: "2026-09-25T10:05:00.000Z",
};

const INVALID = {
  error: "invalid",
  fields: [
    { path: "subscribed", message: "Invalid input: expected boolean, received string" },
    { path: "traits.email", message: "send email as a top-level field, not a trait" },
  ],
};

type Examples = Record<string, { summary: string; value: unknown }>;

const body = (schema: string, examples?: Examples) => ({ "application/json": { schema: ref(schema), ...(examples ? { examples } : {}) } });

function responses(): Record<string, Json> {
  return {
    Invalid: {
      description: "The body isn't valid (or the `userId` in the URL isn't): `fields` lists each problem. Fix it; don't retry it as it is.",
      content: body("Error", {
        invalid: { summary: "Invalid fields", value: INVALID },
        invalid_json: { summary: "Not JSON", value: { error: "invalid_json" } },
      }),
    },
    Unauthorized: {
      description: "The key id or secret is missing or wrong, or the connection was revoked.",
      headers: { "WWW-Authenticate": { description: 'Always `Basic realm="YouGrow API", charset="UTF-8"`.', schema: { type: "string" } } },
      content: body("Error", {
        unauthorized: {
          summary: "Wrong key id or secret",
          value: { error: "unauthorized", message: "Use HTTP Basic auth: your key id as the username, your secret as the password." },
        },
      }),
    },
    NotFound: {
      description: "YouGrow doesn't hold this user (never sent, or deleted) — or API v2 isn't switched on for this YouGrow.",
      content: body("Error", {
        not_found: { summary: "Unknown user", value: { error: "not_found" } },
        api_disabled: { summary: "API v2 is off here", value: { error: "api_disabled", message: "API v2 isn't enabled on this YouGrow." } },
      }),
    },
    TooLarge: {
      description: `The body is over ${kb(V2_LIMITS.maxBodyBytes)}.`,
      content: body("Error", { body_too_large: { summary: "Too large", value: { error: "body_too_large", message: `At most ${kb(V2_LIMITS.maxBodyBytes)}.` } } }),
    },
    RateLimited: {
      description: "Over the rate limit (600 requests a minute or 20,000 an hour, per key). Wait `Retry-After` seconds, then retry.",
      headers: { "Retry-After": { description: "Seconds to wait before retrying.", schema: { type: "integer", minimum: 0 } } },
      content: body("Error", { rate_limited: { summary: "Slow down", value: { error: "rate_limited" } } }),
    },
    ServerError: {
      description: "Something failed on our side. Retry with backoff (after `Retry-After`, when given) — every write is idempotent.",
      headers: { "Retry-After": { description: "Seconds to wait, when given.", schema: { type: "integer", minimum: 0 } } },
      content: body("Error", {
        internal: { summary: "500", value: { error: "internal" } },
        unavailable: { summary: "503", value: { error: "unavailable" } },
      }),
    },
  };
}

const use = (name: string) => ({ $ref: `#/components/responses/${name}` });

function paths(): Json {
  const errors = (...names: Array<[string, string]>) => Object.fromEntries(names.map(([code, name]) => [code, use(name)]));
  return {
    [V2_PATHS.user]: {
      parameters: [{ $ref: "#/components/parameters/UserId" }],
      patch: {
        operationId: "updateUser",
        tags: ["Users"],
        summary: "Send a user's state",
        description:
          "Merge a JSON Merge Patch (RFC 7396) into the user's state: fields you send replace ours, fields you leave out stay, `null` clears one, and `steps`, `facts` and `traits` merge key by key. The first write for an id creates the user. `signedUpAt` enrols them in sign-up journeys while they're inside the journey's window — checked on every write, so a retry or a late write still enrols, and a journey that goes live later picks them up at their next write. Sending the same state twice is harmless.",
        requestBody: {
          required: true,
          content: body("UserPatch", {
            signUp: {
              summary: "At sign-up",
              value: {
                signedUpAt: "2026-09-25T09:30:00Z",
                email: "alex@example.com",
                firstName: "Alex",
                timezone: "Europe/London",
                locale: "en-GB",
                consent: "soft_opt_in",
                traits: { plan: "pro" },
              },
            },
            progress: {
              summary: "Steps and facts, from a scheduled sync",
              value: { steps: { create_project: "2026-09-25T10:02:00Z" }, facts: { projects: 1 }, updatedAt: "2026-09-25T10:05:00Z" },
            },
            optOut: { summary: "Opted out in your product", value: { subscribed: false } },
            exclude: { summary: "Never email this person", value: { excluded: { reason: "staff" } } },
            clear: { summary: "Clear a field, a step and a trait", value: { lastName: null, steps: { invite_team: null }, traits: { role: null } } },
          }),
        },
        responses: {
          "200": {
            description: "Applied — or skipped because YouGrow holds something newer (`applied: false`). Neither needs a retry. A skipped write is a 200, not a 409.",
            content: body("PatchResponse", {
              applied: { summary: "Applied", value: { applied: true, user: ALEX } },
              fieldsIgnored: {
                summary: "Applied, with an invalid timezone left as it was",
                value: { applied: true, user: ALEX, ignoredFields: [{ path: "timezone", message: "not an IANA time zone, e.g. Europe/London" }] },
              },
              stale: {
                summary: "Skipped: older than the stored state",
                value: { applied: false, reason: "stale_write", storedUpdatedAt: "2026-09-25T10:05:00.000Z", user: ALEX },
              },
              deleted: { summary: "Skipped: older than a later DELETE", value: { applied: false, reason: "deleted_later", storedUpdatedAt: null } },
            }),
          },
          ...errors(["400", "Invalid"], ["401", "Unauthorized"], ["413", "TooLarge"], ["429", "RateLimited"], ["5XX", "ServerError"]),
        },
      },
      get: {
        operationId: "getUser",
        tags: ["Users"],
        summary: "Read a user back",
        description: "The state YouGrow holds, plus the journeys they're in and any opt-outs made in YouGrow's emails. 404 when YouGrow doesn't hold them.",
        responses: {
          "200": {
            description: "The user.",
            content: body("UserView", {
              user: {
                summary: "A user in a journey",
                value: {
                  ...ALEX,
                  enrolments: [{ journeyId: "lcj_4f8a2c", status: "active", mode: "live", enrolledAt: "2026-09-25T09:30:05.000Z" }],
                  optOuts: [],
                },
              },
            }),
          },
          ...errors(["400", "Invalid"], ["401", "Unauthorized"], ["404", "NotFound"], ["429", "RateLimited"], ["5XX", "ServerError"]),
        },
      },
      delete: {
        operationId: "deleteUser",
        tags: ["Users"],
        summary: "Erase a user",
        description:
          "Erases the profile, its events, journey progress, AI drafts and invite links. Opt-outs are kept with the email address removed — a one-way hash still matches it — so someone who unsubscribed stays unsubscribed. For 30 days a tombstone keeps only a one-way hash of your connection and user ids and the time of deletion: a later write starts a fresh person, unless its `updatedAt` is older than the deletion (`deleted_later`). Always 204, even for a user YouGrow never saw, so it's safe to repeat.",
        responses: {
          "204": { description: "Erased (or nothing to erase)." },
          ...errors(["400", "Invalid"], ["401", "Unauthorized"], ["429", "RateLimited"], ["5XX", "ServerError"]),
        },
      },
    },
    [V2_PATHS.batch]: {
      post: {
        operationId: "updateUsers",
        tags: ["Users"],
        summary: "Send many users' state",
        description: `1–${V2_LIMITS.maxBatch} users, each a \`userId\` plus the same fields as a PATCH. Each is checked and applied on its own — never all-or-nothing — so one bad item never fails the rest. A batch counts as one request against the rate limit.`,
        requestBody: {
          required: true,
          content: body("BatchRequest", {
            sync: {
              summary: "A scheduled sync",
              value: {
                users: [
                  { userId: "user_123", steps: { create_project: "2026-09-25T10:02:00Z" }, updatedAt: "2026-09-25T10:05:00Z" },
                  { userId: "user_456", facts: { projects: 0 }, updatedAt: "2026-09-25T10:00:00Z" },
                  { userId: "user_789", timezone: "Europe/Paris" },
                  { userId: "user_999", subscribed: false },
                ],
              },
            },
          }),
        },
        responses: {
          "200": {
            description: "Every item was tried. `results` lists the ones that weren't applied, and applied ones with `fields_ignored`.",
            content: body("BatchResponse", {
              mixed: {
                summary: "Two applied (one with a field ignored), one ignored, one failed",
                value: {
                  applied: 2,
                  ignored: 1,
                  failed: 1,
                  results: [
                    { index: 1, userId: "user_456", status: "ignored", reason: "stale_write" },
                    { index: 2, userId: "user_789", status: "applied", reason: "fields_ignored", fields: [{ path: "timezone", message: "not an IANA time zone, e.g. Europe/London" }] },
                    { index: 3, userId: "user_999", status: "failed", reason: "invalid", fields: [{ path: "subscribed", message: "Invalid input: expected boolean, received string" }] },
                  ],
                },
              },
            }),
          },
          "400": {
            description: `The body isn't \`{"users": [...]}\` with 1–${V2_LIMITS.maxBatch} items. (A bad item is reported in \`results\`, not here.)`,
            content: body("Error"),
          },
          ...errors(["401", "Unauthorized"], ["413", "TooLarge"], ["429", "RateLimited"], ["5XX", "ServerError"]),
        },
      },
    },
    [V2_PATHS.me]: {
      get: {
        operationId: "getConnection",
        tags: ["Connection"],
        summary: "Check your key",
        description:
          "The connection behind the key: its name, environment and status. Call it to check your credentials, and that they're the right environment's, before you send anything. It counts against the rate limit like any request.",
        responses: {
          "200": {
            description: "The key works.",
            content: body("MeResponse", {
              production: {
                summary: "A production connection",
                value: { connection: { id: "pcn_7d2f19", name: "Acme", environment: "production", status: "active" }, keyId: "ygk_3f9a2b7c", rotating: false },
              },
            }),
          },
          ...errors(["401", "Unauthorized"], ["404", "NotFound"], ["429", "RateLimited"], ["5XX", "ServerError"]),
        },
      },
    },
    [V2_PATHS.events]: {
      parameters: [{ $ref: "#/components/parameters/UserId" }],
      post: {
        operationId: "trackEvent",
        tags: ["Events"],
        summary: "Record a milestone",
        description:
          "Optional: journeys run on state. Record a moment that matters in itself, and a journey can start from it or branch on it. The user must exist — send their state first. Sign-ups, steps, opt-outs and deletion are state, so their v1 event names are refused.",
        requestBody: {
          required: true,
          content: body("EventRequest", {
            milestone: {
              summary: "A milestone",
              value: { event: "report.exported", properties: { format: "pdf" }, occurredAt: "2026-09-25T10:15:00Z", idempotencyKey: "export_8812" },
            },
            done: { summary: "Finished getting started (no step checklist)", value: { event: "onboarding.completed" } },
          }),
        },
        responses: {
          "200": {
            description: "Recorded — or already recorded with this `idempotencyKey`.",
            content: body("EventResponse", {
              recorded: { summary: "Recorded", value: { recorded: true, duplicate: false } },
              duplicate: { summary: "A repeat of the same idempotencyKey", value: { recorded: false, duplicate: true } },
            }),
          },
          ...errors(["400", "Invalid"], ["401", "Unauthorized"], ["404", "NotFound"], ["413", "TooLarge"], ["429", "RateLimited"], ["5XX", "ServerError"]),
        },
      },
    },
  };
}

function webhooks(origin: string): Json {
  const keyIdHeader = {
    name: "X-YouGrow-Key-Id",
    in: "header",
    required: true,
    description: "Your connection's key id — the token's audience.",
    schema: { type: "string" },
  };
  const verify = `Verify the bearer token before trusting anything: ES256, a key from ${origin}/.well-known/jwks.json, \`iss\` = \`${origin}\`, \`aud\` = your key id, \`dir\`, \`exp\`, and \`body_sha256\` = the base64url SHA-256 of the raw body.`;
  return {
    contextRequest: {
      post: {
        operationId: "contextRequest",
        summary: "Context request (optional)",
        description: `Only while you've set a context endpoint: just before a journey acts for a user, YouGrow asks your server for their live state. Answer within your timeout (2 seconds by default, 5 at most). If it fails 3 times in a row, YouGrow uses the stored state for 15 minutes before asking again. ${verify} \`dir\` is \`context\`.`,
        security: [{ bearerAuth: [] }],
        parameters: [keyIdHeader],
        requestBody: {
          required: true,
          content: body("ContextRequest", {
            send: {
              summary: "Before an email",
              value: { userId: "user_123", purpose: "send", journeyId: "lcj_4f8a2c", nodeId: "email_2", requestId: "b5c1e6d2-8a0f-4c1e-9d55-3f1a2b7c9e10" },
            },
          }),
        },
        responses: {
          "200": {
            description: "The user's live state.",
            content: body("ContextResponse", {
              live: {
                summary: "Steps, facts and an insight",
                value: {
                  asOf: "2026-09-25T10:00:00Z",
                  steps: [
                    { id: "create_project", label: "Create a project", done: true, doneAt: "2026-09-25T10:02:00Z" },
                    { id: "invite_team", label: "Invite your team", done: false, url: "https://app.example.com/team/invite" },
                  ],
                  nextStep: { id: "invite_team", label: "Invite your team", url: "https://app.example.com/team/invite" },
                  facts: [{ id: "projects", label: "Projects", value: 1 }],
                  insights: [{ id: "first_project", sentence: "Your first project is set up and ready for your team.", factIds: ["projects"], supportsStep: "invite_team" }],
                },
              },
              exit: { summary: "Stop email for this user", value: { asOf: "2026-09-25T10:00:00Z", exit: { reason: "staff account" } } },
            }),
          },
          "401": { description: "The token didn't verify." },
          "404": { description: "You don't know this user." },
        },
      },
    },
    webhook: {
      post: {
        operationId: "webhook",
        summary: "Webhook",
        description: `Changes your product should mirror: \`email_preferences.updated\` (an unsubscribe from one of YouGrow's emails), \`email.suppressed\` (YouGrow stopped emailing a user because their address hard-bounced or they reported an email as spam) and \`connection.test\` (the Test webhook button). API writes never trigger one. Reply 2xx within 5 seconds; anything else is retried with backoff for 24 hours, with the same \`id\`. More types may be added: reply 2xx to any you don't handle. ${verify} \`dir\` is \`webhook\`.`,
        security: [{ bearerAuth: [] }],
        parameters: [keyIdHeader],
        requestBody: {
          required: true,
          content: body("WebhookPayload", {
            unsubscribe: {
              summary: "An unsubscribe",
              value: {
                id: "wh_7c1d9e",
                type: "email_preferences.updated",
                createdAt: "2026-09-25T10:00:00Z",
                data: { userId: "user_123", category: "onboarding", subscribed: false, scope: "category", source: "list-unsubscribe" },
              },
            },
            suppressed: {
              summary: "A spam complaint",
              value: { id: "wh_2b8e4f", type: "email.suppressed", createdAt: "2026-09-25T10:00:00Z", data: { userId: "user_123", reason: "complaint" } },
            },
            test: { summary: "Test webhook", value: { id: "wh_test_1", type: "connection.test", createdAt: "2026-09-25T10:00:00Z", data: {} } },
          }),
        },
        responses: {
          "2XX": { description: "Received." },
          "401": { description: "The token didn't verify." },
        },
      },
    },
  };
}

/** The OpenAPI 3.1 document for this environment's origin. */
export function openApiSpec(origin: string): Json {
  const o = origin.replace(/\/+$/, "");
  const { $schema: _dialect, ...userId } = toJson(UserIdSchema, "input");
  return {
    openapi: "3.1.0",
    info: {
      title: "YouGrow API",
      version: "2.0.0",
      summary: "Send your users' state to YouGrow lifecycle journeys.",
      description: [
        "Your server sends YouGrow each user's **current state** — who they are, when they signed up, which onboarding steps they've done, facts about their account, and whether they've opted out. YouGrow keeps it and decides the rest: who enters which journey, what to send and when.",
        "",
        "- **Authentication:** HTTP Basic over HTTPS — your key id (`ygk_…`) as the username and your secret (`ygs_…`) as the password. After you rotate the secret, the previous one works for 24 hours.",
        "- **Writes are JSON Merge Patches** (RFC 7396): fields you send replace ours, fields you leave out stay, `null` clears one, and `steps`, `facts` and `traits` merge key by key. Sending the same state twice is harmless, so any write can be retried.",
        "- **Out-of-order writes:** send `updatedAt` (when you read the state), and a write older than the newest one applied is skipped: `200 {\"applied\": false, \"reason\": \"stale_write\"}` — a success, not a conflict.",
        `- **Limits:** 600 requests a minute and 20,000 an hour per key (a batch counts as one), ${kb(V2_LIMITS.maxBodyBytes)} per request, ${V2_LIMITS.maxBatch} users per batch.`,
        "- **Errors:** a `400` lists each problem in `fields` — fix it rather than retry. Retry a `429` after `Retry-After`, and a `5xx` or a network error with backoff. Where API v2 isn't switched on, every endpoint answers `404 api_disabled`.",
        "- **What YouGrow sends you** — the optional context request and webhooks — is under Webhooks. Each carries an ES256 JWT for you to verify.",
        "",
        `Guides and examples: ${o}/developers. API v1 (\`POST /api/v1/events\`, HMAC-signed) was removed on 2026-09-25.`,
      ].join("\n"),
    },
    externalDocs: { description: "Developer docs", url: `${o}/developers/users` },
    servers: [{ url: o }],
    security: [{ basicAuth: [] }],
    tags: [
      { name: "Users", description: "Send each user's current state, read it back, or erase it." },
      { name: "Events", description: "Optional milestones." },
      { name: "Connection", description: "Check the key you're using." },
    ],
    paths: paths(),
    webhooks: webhooks(o),
    components: {
      schemas: components(),
      parameters: {
        UserId: { name: "userId", in: "path", required: true, description: USER_ID_NOTES, schema: userId, example: "user_123" },
      },
      responses: responses(),
      securitySchemes: {
        basicAuth: {
          type: "http",
          scheme: "basic",
          description: "Username: your key id (`ygk_…`). Password: your secret (`ygs_…`). HTTPS only. After a rotation, the previous secret works for 24 hours.",
        },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: `On YouGrow's requests to you: an ES256 JWT. Verify it with the public keys at ${o}/.well-known/jwks.json — \`iss\` = \`${o}\`, \`aud\` = your key id, \`dir\` = \`context\` or \`webhook\`, \`exp\`, and \`body_sha256\` = the base64url SHA-256 of the raw body.`,
        },
      },
    },
  };
}
