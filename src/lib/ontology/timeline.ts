import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { EVENT_ID, StoredEventSchema, type StoredEvent } from "@/lib/types/ontologyEvent";
import { isCanonicalInstant, subjectKey, type EventSubject, type StoredEventKind } from "./events";
import type { ContactPersonId } from "./person";

/**
 * Reading the event history (ontology_events): one person's rows, or one subject's, newest first,
 * a page at a time. A person's timeline is every row carrying their personId, which includes the
 * agent steps of actions about them. Email, product, journey and sign-up moments are not here:
 * they stay in their own stores and B5 reads them beside these.
 *
 * Ordered by time, then document id, both descending, on the indexes (tenantId, personId, at desc)
 * and (tenantId, subjectKey, at desc): the id order follows the last field's direction, so the
 * index serves the tie order. The cursor is opaque: base64url of [at, id].
 */

export const TIMELINE_PAGE = { default: 50, max: 100 } as const;

/** A cursor that isn't one this file made (a route answers 400). */
export class InvalidCursorError extends Error {
  constructor() {
    super("invalid_timeline_cursor");
    this.name = "InvalidCursorError";
  }
}

export function encodeTimelineCursor(c: { at: string; id: string }): string {
  return Buffer.from(JSON.stringify([c.at, c.id]), "utf8").toString("base64url");
}

/** The cursor's time and id, or null when it is malformed or its time is not canonical. */
export function decodeTimelineCursor(s: string): { at: string; id: string } | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]{1,400}$/.test(s)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [at, id] = value as unknown[];
    if (!isCanonicalInstant(at) || typeof id !== "string" || !EVENT_ID.test(id)) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export interface TimelineOptions {
  cursor?: string | null;
  /** Default 50, at most 100. */
  limit?: number;
  /** Only these kinds; filtered after the read, so a page can come back short. */
  kinds?: readonly StoredEventKind[];
  db?: FirestoreLike;
}

export interface TimelinePage {
  events: StoredEvent[];
  /** The next page's cursor while the page read came back full: keep paging while it is set. */
  next: string | null;
}

function pageSize(limit: number | undefined): number {
  const n = Math.floor(limit ?? TIMELINE_PAGE.default);
  return Math.min(Math.max(1, Number.isFinite(n) ? n : TIMELINE_PAGE.default), TIMELINE_PAGE.max);
}

async function page(ctx: TenantContext, field: "personId" | "subjectKey", value: string, opts: TimelineOptions): Promise<TimelinePage> {
  const limit = pageSize(opts.limit);
  let after: { at: string; id: string } | null = null;
  if (opts.cursor) {
    after = decodeTimelineCursor(opts.cursor);
    if (!after) throw new InvalidCursorError();
  }
  const rows = await forTenant(ctx, opts.db).ontologyEvents.find({
    where: [[field, "==", value]],
    orderBy: [
      ["at", "desc"],
      ["__name__", "desc"],
    ],
    ...(after ? { startAfter: [after.at, after.id] } : {}),
    limit,
  });
  const events: StoredEvent[] = [];
  let dropped = 0;
  for (const row of rows) {
    const parsed = StoredEventSchema.safeParse(row);
    if (!parsed.success) {
      dropped += 1;
      continue;
    }
    const e = parsed.data as StoredEvent;
    if (!opts.kinds || opts.kinds.includes(e.kind)) events.push(e);
  }
  if (dropped > 0) console.warn(`[ontology] timeline dropped ${dropped} unreadable events tenant=${ctx.tenantId}`);
  const last = rows[rows.length - 1];
  return { events, next: rows.length === limit && last ? encodeTimelineCursor({ at: String(last.at), id: last.id }) : null };
}

/** One person's events, newest first (index a). */
export function listPersonEvents(ctx: TenantContext, personId: ContactPersonId, opts: TimelineOptions = {}): Promise<TimelinePage> {
  return page(ctx, "personId", personId, opts);
}

/** One subject's events (a company's, an idea's, an agent action's), newest first (index b). */
export function listSubjectEvents(ctx: TenantContext, subject: EventSubject, opts: TimelineOptions = {}): Promise<TimelinePage> {
  return page(ctx, "subjectKey", subjectKey(subject), opts);
}
