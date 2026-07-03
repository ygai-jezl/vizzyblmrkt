import { forTenant, TenantIsolationError } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { SocialEventType, SocialPlatform } from "@/lib/types/socialEvent";

/**
 * Record one social engagement event (tenant-scoped `social_events`). Idempotent:
 * the document id encodes (platform, type, remoteId), so a replayed webhook batch
 * collapses to a single row — an atomic create rejects the duplicate (same pattern
 * as recordEmailEvent / enqueueEmailJob).
 */
export interface RecordSocialEventInput {
  platform: SocialPlatform;
  type: SocialEventType;
  /** Unique per real-world event (see SocialEvent.remoteId). */
  remoteId: string;
  actorId: string;
  actorHandle?: string | null;
  actorName?: string | null;
  targetRemoteId?: string | null;
  text?: string | null;
  ts: string;
}

/** Build the deterministic dedupe id (= the document id). */
export function socialEventId(
  input: Pick<RecordSocialEventInput, "platform" | "type" | "remoteId">,
): string {
  return `sev:${input.platform}:${input.type}:${input.remoteId}`;
}

export async function recordSocialEvent(
  ctx: TenantContext,
  input: RecordSocialEventInput,
  db?: FirestoreLike,
): Promise<"recorded" | "duplicate"> {
  const id = socialEventId(input);
  const now = new Date().toISOString();
  try {
    await forTenant(ctx, db).socialEvents.create(id, {
      platform: input.platform,
      type: input.type,
      remoteId: input.remoteId,
      actorId: input.actorId,
      actorHandle: input.actorHandle ?? null,
      actorName: input.actorName ?? null,
      targetRemoteId: input.targetRemoteId ?? null,
      text: input.text ?? null,
      ts: input.ts,
      createdAt: now,
    });
    return "recorded";
  } catch (err) {
    if (err instanceof TenantIsolationError) return "duplicate";
    throw err;
  }
}
