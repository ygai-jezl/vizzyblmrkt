import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { agentActionReviewItem, listOpenAgentActions } from "@/lib/ontology/agentActions";
import type { ReviewItem } from "@/lib/review/summary";
import type { AgentAction } from "@/lib/types/agentAction";
import { PASTE_REVIEW, reviewDetail } from "./words";

/**
 * A pasted list waiting for an admin (RAISE_PASTE_ENABLED): one agent action of action
 * `paste.add_rows`, target the brand, shown in Review's Pasted lists for admins and opened as the
 * Paste a list sheet on People. Its words never hold a name, an address or a cell: only how many
 * people and companies it adds, and where the list is from in the admin's own words.
 */

export const PASTE_ACTION = "paste.add_rows";
/** How long a pasted list waits before the tick's sweep declines it and clears its rows. */
export const PASTE_DAYS = 7;
/** Open lists read for Review. */
const REVIEW_READ = 20;

/** Where a pasted list opens: People, with the list's id only. */
export function pasteHref(id: string): string {
  return `/admin/crm?paste=${encodeURIComponent(id)}`;
}

/** This brand's pasted list: the action, aimed at the brand itself. */
export function isPasteBatch(ctx: TenantContext, a: AgentAction): boolean {
  return a.action === PASTE_ACTION && a.target.type === "brand" && a.target.id === ctx.tenantId;
}

/** How many people and companies a stored list adds, and where it is from, or null once its rows are gone. */
export function pasteCounts(a: AgentAction): { people: number; companies: number; source: string } | null {
  const p = a.proposal as { rows?: unknown; source?: unknown } | null;
  if (!p || !Array.isArray(p.rows) || typeof p.source !== "string") return null;
  const rows = p.rows as Array<{ kind?: unknown }>;
  return { people: rows.filter((r) => r?.kind === "person").length, companies: rows.filter((r) => r?.kind === "company").length, source: p.source };
}

/** A waiting list as a Review item, or null once it is decided or its rows are gone. */
export function pasteBatchItem(a: AgentAction): ReviewItem | null {
  const counts = pasteCounts(a);
  if (!counts) return null;
  return agentActionReviewItem(a, { title: PASTE_REVIEW.itemTitle, detail: reviewDetail(counts, counts.source), action: PASTE_REVIEW.action });
}

/** The brand's pasted lists waiting for an admin, newest first (the existing action, state, createdAt index). */
export async function pasteBatchItems(ctx: TenantContext, db?: FirestoreLike, now?: string): Promise<ReviewItem[]> {
  const open = await listOpenAgentActions(ctx, { action: PASTE_ACTION, limit: REVIEW_READ, now, db });
  return open
    .filter((a) => isPasteBatch(ctx, a))
    .map(pasteBatchItem)
    .filter((i): i is ReviewItem => !!i);
}
