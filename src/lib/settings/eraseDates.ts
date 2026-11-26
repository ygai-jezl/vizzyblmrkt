import type { RecordField } from "@/lib/types/recordField";

/**
 * When an archived field's values can be erased (ADR-0021): 30 days after it was last archived,
 * and not once an erase has run since. Pure, so Data model shows the same dates the server checks.
 */

export const ERASE_AFTER_DAYS = 30;
const DAY_MS = 86_400_000;

/** When a field's values can be erased from: 30 days after it was last archived. */
export function erasableFrom(archivedAt: string): string {
  return new Date(Date.parse(archivedAt) + ERASE_AFTER_DAYS * DAY_MS).toISOString();
}

/** Whether an erase has run since the field was last archived. */
export function erasedSinceArchive(field: Pick<RecordField, "archivedAt" | "erasedAt">): boolean {
  return !!field.erasedAt && !!field.archivedAt && field.erasedAt >= field.archivedAt;
}

/** The field's own dates: archived 30 days or more, and not erased since. */
export function fieldErasable(
  field: Pick<RecordField, "archivedAt" | "erasedAt">,
  nowMs: number,
): { ok: true } | { ok: false; why: "not_archived" | "too_soon" | "already_erased"; from?: string } {
  if (!field.archivedAt) return { ok: false, why: "not_archived" };
  if (erasedSinceArchive(field)) return { ok: false, why: "already_erased" };
  const from = erasableFrom(field.archivedAt);
  if (Date.parse(from) > nowMs) return { ok: false, why: "too_soon", from };
  return { ok: true };
}
