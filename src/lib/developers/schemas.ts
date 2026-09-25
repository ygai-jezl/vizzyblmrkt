import { z } from "zod";
import { ContextRequestSchema, ContextResponseSchema, LIMITS, WebhookPayloadSchema } from "@/lib/connect/protocol";
import {
  BatchResponseSchema,
  EventRequestSchema,
  PatchResponseSchema,
  UserIdSchema,
  UserPatchSchema,
  UserViewSchema,
  V2_LIMITS,
} from "@/lib/connect/v2/contract";
import { STATE_NOTES, USER_FIELDS, USER_ID_NOTES } from "./userFields";

/**
 * The API as JSON Schema, generated from the validators the API itself uses —
 * so the published contract can't drift from what we accept. `io` is the side a
 * customer sees: what they SEND is the Zod input (fields with defaults are
 * optional); what we send THEM is the output. The OpenAPI spec (openapi.ts) is
 * built from the same schemas and the same tidying.
 */

export type Io = "input" | "output";
type Json = Record<string, unknown>;

/**
 * One batch item, for documentation: a user id plus the PATCH fields. The API
 * checks items one by one (BatchItemSchema, then UserPatchSchema), so the
 * envelope's own schema only says "an array"; this one says what goes in it.
 */
export const BatchItemDocSchema = z.object({ userId: UserIdSchema, ...UserPatchSchema.shape }).strict();
export const BatchRequestDocSchema = z.object({ users: z.array(BatchItemDocSchema).min(1).max(V2_LIMITS.maxBatch) }).strict();

export const USER_NOTES: Record<string, string> = Object.fromEntries(USER_FIELDS.map((f) => [f.name, f.notes]));
export const BATCH_ITEM_NOTES: Record<string, string> = { userId: USER_ID_NOTES, ...USER_NOTES };

/** Per-user map limits, which the validators check in code rather than in the schema. */
const MAP_LIMITS: Record<string, number> = { steps: V2_LIMITS.maxSteps, facts: V2_LIMITS.maxFacts, traits: V2_LIMITS.maxTraits };

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Tidy a generated schema for publishing, in place:
 * - what we send may gain fields, so output objects don't forbid unknown keys;
 * - integers don't spell out the safe-integer bounds;
 * - the `steps`, `facts` and `traits` maps carry their size limits.
 */
export function tidy<T>(node: T, io: Io): T {
  if (Array.isArray(node)) {
    for (const n of node) tidy(n, io);
    return node;
  }
  if (!isObject(node)) return node;
  if (io === "output" && node.additionalProperties === false) delete node.additionalProperties;
  if (node.minimum === Number.MIN_SAFE_INTEGER) delete node.minimum;
  if (node.maximum === Number.MAX_SAFE_INTEGER) delete node.maximum;
  const props = node.properties;
  if (isObject(props)) {
    for (const [key, max] of Object.entries(MAP_LIMITS)) {
      const map = props[key];
      if (isObject(map) && map.type === "object" && "propertyNames" in map) map.maxProperties = max;
    }
  }
  for (const v of Object.values(node)) tidy(v, io);
  return node;
}

/** Set `description` on an object schema's properties (only those it has). */
export function describeProperties(schema: unknown, notes: Record<string, string>): void {
  const props = isObject(schema) ? schema.properties : undefined;
  if (!isObject(props)) return;
  for (const [key, text] of Object.entries(notes)) {
    const p = props[key];
    if (isObject(p)) p.description = text;
  }
}

/** A Zod schema as a standalone JSON Schema (draft 2020-12), tidied. */
export function toJson(schema: z.ZodType, io: Io): Json {
  return tidy(z.toJSONSchema(schema, { io, target: "draft-2020-12" }) as Json, io);
}

const kb = (bytes: number) => `${bytes / 1024} KB`;

interface SchemaEntry {
  title: string;
  description: string;
  io: Io;
  schema: z.ZodType;
  /** Field notes for the schema's own properties (from userFields). */
  annotate?: (json: Json) => void;
}

export const SCHEMAS = {
  "user-patch.json": {
    title: "User patch",
    description: `The body of PATCH /api/v2/users/{userId}: any subset of a user's state, as a JSON Merge Patch. At most ${kb(V2_LIMITS.maxBodyBytes)}.`,
    io: "input",
    schema: UserPatchSchema,
    annotate: (json) => describeProperties(json, USER_NOTES),
  },
  "batch-request.json": {
    title: "Batch request",
    description: `The body of POST /api/v2/users/batch: 1–${V2_LIMITS.maxBatch} users, each a userId plus the same fields as a PATCH. At most ${kb(V2_LIMITS.maxBodyBytes)}.`,
    io: "input",
    schema: BatchRequestDocSchema,
    annotate: (json) => {
      const users = isObject(json.properties) ? json.properties.users : undefined;
      describeProperties(isObject(users) ? users.items : undefined, BATCH_ITEM_NOTES);
    },
  },
  "event.json": {
    title: "Event",
    description: `The body of POST /api/v2/users/{userId}/events: an optional milestone, with properties of at most ${kb(V2_LIMITS.maxPropertiesBytes)}.`,
    io: "input",
    schema: EventRequestSchema,
  },
  "user.json": {
    title: "User",
    description: "A user as GET /api/v2/users/{userId} returns them: their state, their journeys and their opt-outs.",
    io: "output",
    schema: UserViewSchema,
    annotate: (json) => describeProperties(json, STATE_NOTES),
  },
  "patch-response.json": {
    title: "Patch response",
    description: "What PATCH /api/v2/users/{userId} returns with 200: the write applied, or skipped as stale_write or deleted_later.",
    io: "output",
    schema: PatchResponseSchema,
  },
  "batch-response.json": {
    title: "Batch response",
    description: "What POST /api/v2/users/batch returns with 200: how many users were applied, ignored and failed, and which ones weren't applied.",
    io: "output",
    schema: BatchResponseSchema,
  },
  "context-request.json": {
    title: "Context request",
    description: "What YouGrow POSTs to your context endpoint about one user.",
    io: "output",
    schema: ContextRequestSchema,
  },
  "context-response.json": {
    title: "Context response",
    description: `What your context endpoint returns for that user, at most ${kb(LIMITS.maxContextBytes)}.`,
    io: "input",
    schema: ContextResponseSchema,
  },
  "webhook.json": {
    title: "Webhook",
    description: "What YouGrow POSTs to your webhook endpoint.",
    io: "output",
    schema: WebhookPayloadSchema,
  },
} as const satisfies Record<string, SchemaEntry>;

export type SchemaName = keyof typeof SCHEMAS;

/** One schema, ready to serve at `<origin>/developers/schema/<name>`; null for an unknown name. */
export function jsonSchema(name: string, origin: string): Record<string, unknown> | null {
  if (!Object.hasOwn(SCHEMAS, name)) return null;
  const s: SchemaEntry = SCHEMAS[name as SchemaName];
  const { $schema, ...rest } = toJson(s.schema, s.io);
  s.annotate?.(rest);
  return { $schema, $id: `${origin}/developers/schema/${name}`, title: s.title, description: s.description, ...rest };
}
