import { z } from "zod";

/**
 * Product event — one identify/track message accepted from a connected product.
 * Lives in the tenant-scoped `product_events` collection (regional DB). The id is
 * `pe_<sha256(connectionId:messageId)>`: the atomic create of this row is the
 * idempotency gate, so a replayed or retried message is a no-op ("duplicate").
 * Kept 90 days (`ttlAt`, a Firestore TTL) for the debugger and analytics.
 */
export const ProductEventSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  connectionId: z.string(),
  productUserId: z.string(),
  externalUserId: z.string(),
  messageId: z.string(),
  /** `erase`: an API v2 DELETE (no user id kept). */
  type: z.enum(["identify", "track", "erase"]),
  /** Track only. */
  event: z.string().nullable().optional(),
  /** Track properties or identify traits (≤4 KB serialised). */
  payload: z.record(z.string(), z.unknown()).default({}),
  /** When it happened, per the product. */
  timestamp: z.string(),
  receivedAt: z.string(),
  /** False when it changed nothing (e.g. an identify older than the latest). */
  applied: z.boolean(),
  /** API v2: why a write changed nothing — YouGrow held something newer. */
  skipped: z.enum(["stale_write", "deleted_later"]).nullable().optional(),
  /** API v2: profile fields whose invalid value was left as it was. */
  ignoredFields: z.array(z.string()).optional(),
  ttlAt: z.unknown().optional(),
});
export type ProductEvent = z.infer<typeof ProductEventSchema>;

/**
 * Per-connection diagnostics for the setup wizard and event debugger: which event
 * names and trait keys have actually arrived (so the catalog can be inferred) and
 * the most recent rejections (so an integrator can see what went wrong). Id =
 * connection id; lives in `connection_diagnostics` (regional DB).
 */
export const ConnectionDiagnosticsSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  observedEvents: z
    .record(z.string(), z.object({ count: z.number().int(), lastAt: z.string() }))
    .default({}),
  observedTraits: z
    .record(z.string(), z.object({ type: z.string(), lastAt: z.string() }))
    .default({}),
  recentRejections: z
    .array(
      z.object({
        at: z.string(),
        messageId: z.string().nullable().optional(),
        reason: z.string().max(300),
      }),
    )
    .max(50)
    .default([]),
  updatedAt: z.string(),
});
export type ConnectionDiagnostics = z.infer<typeof ConnectionDiagnosticsSchema>;
