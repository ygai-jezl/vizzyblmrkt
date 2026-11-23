import { queryKey } from "@/lib/signals/store";
import type { PlanningBy, RolledSpan, SnapshotBy } from "@/lib/types/metricSnapshot";
import { cleanPagePath } from "./paths";
import { todayIn } from "./period";

/**
 * The shared keys collected numbers join on (Connectors 2, ADR-0012), one way of writing each:
 * - page: a host and a path, the path cleaned as live reads clean it (no query string or
 *   fragment). The path is the join key; the host keeps Search Console's hosts apart.
 * - topic: a search's words as the brand map and Google lookups key them (queryKey), so case,
 *   spacing and punctuation don't make a new topic.
 * - day: YYYY-MM-DD in the provider's own time zone, never the brand's: a daily total can't be
 *   moved into another zone.
 */

/** "example.com/pricing", or the path alone when the provider gives no host. */
export function pageKey(host: string, path: string): string {
  return `${host.trim().toLowerCase()}${cleanPagePath(path)}`;
}

/** A search's words as a topic: the brand map's own key for the same words. */
export const topicKey = (text: string): string => queryKey(text);

/** The day it is at this moment in the provider's zone. */
export function dayKey(at: Date, timeZone: string): string {
  return todayIn(at, timeZone);
}

/** A day doc's id: connection, generation, stream, grouping and day. */
export function snapshotId(connectionId: string, gen: number, stream: string, by: SnapshotBy, day: string): string {
  return `${connectionId}_${gen}_${stream}_${by}_${day}`;
}

/** A rolled doc's id: the 28 or 90 days to the last collected day. */
export function rolledId(connectionId: string, gen: number, stream: string, by: SnapshotBy, span: RolledSpan): string {
  return `${connectionId}_${gen}_${stream}_${by}_${span}`;
}

/** A planning doc's id (Search Console): a line per brand map question or subject, over 28 days. */
export function planningId(connectionId: string, gen: number, stream: string, by: PlanningBy): string {
  return `${connectionId}_${gen}_${stream}_${by}_r28`;
}
