import { enterpriseFeature } from "@/lib/enterprise/registry";
import type { TenantContext } from "@/lib/tenant";
import type { RecordFieldObject } from "@/lib/types/recordField";

/**
 * Legal hold, as an erase asks it (ADR-0023): may this field's values be erased now? The core asks
 * the Enterprise registry whether legal hold runs in this deployment. While its code is absent (no
 * src/ee code for it yet, so every deployment today) nothing is held. Once piece M supplies the code,
 * it passes a reader here and callers don't change; a deployment that runs legal hold with no reader
 * refuses every erase rather than guess.
 */

export interface HoldAnswer {
  held: boolean;
  /** Why, as a code, when held. */
  reason?: "legal_hold" | "legal_hold_unreadable";
}

/** Reads whether a hold covers a brand's field (piece M supplies it). */
export type HoldReader = (ctx: TenantContext, what: { object: RecordFieldObject; fieldId: string }) => Promise<boolean>;

export async function legalHoldOn(
  ctx: TenantContext,
  what: { object: RecordFieldObject; fieldId: string },
  deps: { feature?: typeof enterpriseFeature; reader?: HoldReader } = {},
): Promise<HoldAnswer> {
  const answer = (deps.feature ?? enterpriseFeature)("legal_hold");
  if (!answer.on) return { held: false };
  if (!deps.reader) return { held: true, reason: "legal_hold_unreadable" };
  try {
    return (await deps.reader(ctx, what)) ? { held: true, reason: "legal_hold" } : { held: false };
  } catch {
    return { held: true, reason: "legal_hold_unreadable" };
  }
}
