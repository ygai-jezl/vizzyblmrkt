import { forTenant, TenantIsolationError } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { EmailEventType } from "@/lib/types/emailEvent";

/**
 * Record one email engagement event (tenant-scoped `email_events`). Idempotent +
 * UNIQUE-per-recipient: the document id encodes (journey, node, recipient,
 * variant, type), so a replayed Mandrill batch or a recipient's repeated
 * opens/clicks collapse to a single row — an atomic create rejects the duplicate
 * (same pattern as enqueueEmailJob).
 */
export interface RecordEventInput {
  campaignId: string;
  journeyId: string;
  nodeId: string;
  signupId: string;
  variantId: string;
  type: EmailEventType;
  ts: string;
  mandrillMessageId?: string | null;
  url?: string | null;
}

/** Build the deterministic dedupe id (= the document id). */
export function emailEventId(
  input: Pick<RecordEventInput, "journeyId" | "nodeId" | "signupId" | "variantId" | "type">,
): string {
  return `evt:${input.journeyId}:${input.nodeId}:${input.signupId}:${input.variantId}:${input.type}`;
}

export async function recordEmailEvent(
  ctx: TenantContext,
  input: RecordEventInput,
  db?: FirestoreLike,
): Promise<"recorded" | "duplicate"> {
  const id = emailEventId(input);
  const now = new Date().toISOString();
  try {
    await forTenant(ctx, db).emailEvents.create(id, {
      campaignId: input.campaignId,
      journeyId: input.journeyId,
      nodeId: input.nodeId,
      signupId: input.signupId,
      variantId: input.variantId,
      type: input.type,
      mandrillMessageId: input.mandrillMessageId ?? null,
      ts: input.ts,
      url: input.url ?? null,
      createdAt: now,
    });
    return "recorded";
  } catch (err) {
    if (err instanceof TenantIsolationError) return "duplicate";
    throw err;
  }
}
