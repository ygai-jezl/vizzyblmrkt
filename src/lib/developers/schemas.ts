import { z } from "zod";
import {
  ContextRequestSchema,
  ContextResponseSchema,
  IngestMessageSchema,
  LIMITS,
  WebhookPayloadSchema,
} from "@/lib/connect/protocol";

/**
 * The wire protocol as JSON Schema, generated from the validators the API itself
 * uses — so the published contract can't drift from what we accept. `io` is the
 * side a customer sees: what they SEND is the Zod input (fields with defaults are
 * optional); what we send THEM is the output.
 */
export const SCHEMAS = {
  "events.json": {
    title: "Events request",
    description: `The body of POST /api/v1/events: 1–${LIMITS.maxBatch} identify or track messages, at most ${LIMITS.maxBodyBytes / 1024} KB.`,
    io: "input",
    schema: z.object({ batch: z.array(IngestMessageSchema).min(1).max(LIMITS.maxBatch) }),
  },
  "context-request.json": {
    title: "Context request",
    description: "What YouGrow POSTs to your context endpoint about one user.",
    io: "output",
    schema: ContextRequestSchema,
  },
  "context-response.json": {
    title: "Context response",
    description: `What your context endpoint returns for that user, at most ${LIMITS.maxContextBytes / 1024} KB.`,
    io: "input",
    schema: ContextResponseSchema,
  },
  "webhook.json": {
    title: "Webhook",
    description: "What YouGrow POSTs to your webhook endpoint.",
    io: "output",
    schema: WebhookPayloadSchema,
  },
} as const satisfies Record<string, { title: string; description: string; io: "input" | "output"; schema: z.ZodType }>;

export type SchemaName = keyof typeof SCHEMAS;

/** One schema, ready to serve at `<origin>/developers/schema/<name>`; null for an unknown name. */
export function jsonSchema(name: string, origin: string): Record<string, unknown> | null {
  if (!Object.hasOwn(SCHEMAS, name)) return null;
  const s = SCHEMAS[name as SchemaName];
  const { $schema, ...rest } = z.toJSONSchema(s.schema, { io: s.io, target: "draft-2020-12" }) as Record<string, unknown>;
  return { $schema, $id: `${origin}/developers/schema/${name}`, title: s.title, description: s.description, ...rest };
}
