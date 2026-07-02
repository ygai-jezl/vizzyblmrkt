import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import { ScheduledPostChannel, type ScheduledPost } from "@/lib/types/scheduledPost";

/**
 * Pure view-model helpers for the Distribute tab (schedulable-node selection +
 * calendar bucketing). Kept free of React/Date-now so they're unit-testable and
 * shared by the List and Calendar views.
 */

export interface SchedulableNode {
  planId: string;
  planName: string;
  node: ContentNode;
}

/**
 * A node is schedulable when it has generated/approved copy, a non-empty body,
 * and a channel Distribute can publish to (src/lib/types/scheduledPost.ts).
 */
export function isSchedulableNode(node: ContentNode): boolean {
  if (node.status !== "generated" && node.status !== "approved") return false;
  if (!node.body.trim()) return false;
  return ScheduledPostChannel.safeParse(node.channel).success;
}

/**
 * Nodes across the workspace's plans that can still be scheduled — publishable +
 * generated + not already represented by a scheduled post (any status). A
 * cancelled post is deleted, so its node reappears here.
 */
export function listSchedulableNodes(
  plans: ContentPlan[],
  posts: ScheduledPost[],
): SchedulableNode[] {
  const taken = new Set(posts.map((p) => `${p.contentPlanId}:${p.nodeId}`));
  const out: SchedulableNode[] = [];
  for (const plan of plans) {
    for (const node of plan.graph.nodes) {
      if (!isSchedulableNode(node)) continue;
      if (taken.has(`${plan.id}:${node.id}`)) continue;
      out.push({ planId: plan.id, planName: plan.name, node });
    }
  }
  return out;
}

// ---- Calendar week bucketing (UTC) ----------------------------------------
// NOTE: bucketing is by UTC date for determinism/testability. Per-tenant local
// timezone display is a later refinement; scheduledAt is stored as a UTC instant.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight UTC of the Monday of the ISO week containing `ms`. */
export function mondayUTC(ms: number): number {
  const d = new Date(ms);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const isoDow = dow === 0 ? 7 : dow; // 1=Mon..7=Sun
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight - (isoDow - 1) * DAY_MS;
}

/** The 7 UTC date keys (YYYY-MM-DD) of the week starting at `weekStartMs`. */
export function weekDateKeys(weekStartMs: number): string[] {
  return Array.from({ length: 7 }, (_, i) =>
    new Date(weekStartMs + i * DAY_MS).toISOString().slice(0, 10),
  );
}

/** UTC date key (YYYY-MM-DD) of an ISO instant. */
export function dateKeyOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Group posts by their UTC date key, each bucket sorted by time. */
export function groupPostsByDate(posts: ScheduledPost[]): Map<string, ScheduledPost[]> {
  const m = new Map<string, ScheduledPost[]>();
  for (const p of posts) {
    const k = dateKeyOf(p.scheduledAt);
    const arr = m.get(k);
    if (arr) arr.push(p);
    else m.set(k, [p]);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  }
  return m;
}

/**
 * Format a UTC ISO instant as a stable "YYYY-MM-DD HH:mm UTC" string by slicing —
 * NOT via Date/toLocaleString. Deterministic on server + client, so it can't cause
 * an SSR hydration mismatch, and it matches the calendar's UTC bucketing. (Per-tenant
 * local-timezone display is a later refinement.)
 */
export function formatUtc(iso: string): string {
  if (iso.length < 16 || iso[10] !== "T") return iso;
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Map a schedule-route error code to an operator-facing message. */
const SCHEDULE_ERROR_MESSAGES: Record<string, string> = {
  must_be_future: "Pick a time in the future.",
  too_far_ahead: "That's more than a year away — pick a sooner time.",
  node_not_ready: "That item isn't generated yet — finish it in Create first.",
  node_empty: "That item has no content yet.",
  channel_not_publishable: "That item's channel can't be scheduled.",
  already_publishing: "That item is already publishing and can't be changed.",
  plan_not_found: "The content plan no longer exists.",
  node_not_found: "That item no longer exists.",
  not_found: "Workspace not found.",
  invalid_input: "Something was off with that request — please try again.",
  unauthorized: "Your session expired — sign in again.",
  network_error: "Network error — check your connection and retry.",
};

export function friendlyScheduleError(code: string): string {
  return SCHEDULE_ERROR_MESSAGES[code] ?? "Couldn't complete that action. Please try again.";
}
