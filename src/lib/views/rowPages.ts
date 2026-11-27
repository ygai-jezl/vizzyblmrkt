import { VIEW_LIMITS } from "./types";

/**
 * The rows a view shows, read by id (piece C). A run answers every matching id in order; the screen
 * shows the first `asked` of them (Load more asks for 50 more), each person read once for the
 * columns shown, at most 50 ids a request (the rows route's limit). Someone erased, or no longer in
 * Everyone, since the run is kept as gone (null) and never asked for again, so paging goes by the
 * ids asked, never by the rows that came back. Pure, apart from the read it is given.
 */

/** People read for one run with one set of columns, by id; null when they were asked for and aren't there. */
export type ReadRows<R> = Map<string, R | null>;

export type RowRead<R> = (ids: string[], columns: string[]) => Promise<{ ok: true; rows: R[] } | { ok: false; error: unknown }>;

/** One string for a set of columns, in order. */
export const columnsKey = (columns: readonly string[]) => columns.join(",");

/** How many ids a view shows at first, or after one more Load more. */
export function nextAsked(asked: number, total: number): number {
  return Math.min(asked + VIEW_LIMITS.page, total);
}

/** The ids among the first `asked` not read yet with these columns. */
export function idsToRead<R>(ids: readonly string[], asked: number, read: ReadRows<R> | undefined): string[] {
  return ids.slice(0, asked).filter((id) => !read?.has(id));
}

/** The rows to show: the first `asked` ids that were read and are there, in the run's order. */
export function rowsToShow<R>(ids: readonly string[], asked: number, read: ReadRows<R> | undefined): R[] {
  if (!read) return [];
  return ids.slice(0, asked).flatMap((id) => {
    const row = read.get(id);
    return row ? [row] : [];
  });
}

/** Keep what a read answered: each row by id, and anyone asked for who didn't come back as gone. */
export function keepRead<R extends { id: string }>(read: ReadRows<R>, asked: readonly string[], rows: readonly R[]): void {
  const back = new Map(rows.map((r) => [r.id, r]));
  for (const id of asked) read.set(id, back.get(id) ?? null);
}

/** Read people by id in requests of at most 50, in order; the first failure stops it. */
export async function readRowsInPages<R extends { id: string }>(
  ids: readonly string[],
  columns: string[],
  read: RowRead<R>,
): Promise<{ ok: true; rows: R[] } | { ok: false; error: unknown }> {
  const rows: R[] = [];
  for (let i = 0; i < ids.length; i += VIEW_LIMITS.page) {
    const r = await read(ids.slice(i, i + VIEW_LIMITS.page), columns);
    if (!r.ok) return r;
    rows.push(...r.rows);
  }
  return { ok: true, rows };
}
