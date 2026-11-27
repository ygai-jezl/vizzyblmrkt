import { describe, expect, it } from "vitest";
import { columnsKey, idsToRead, keepRead, nextAsked, readRowsInPages, rowsToShow, type ReadRows, type RowRead } from "./rowPages";
import { VIEW_LIMITS } from "./types";

type Row = { id: string; cols: string };
const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${String(i).padStart(3, "0")}`);

/** A rows route as the server answers it: at most 50 ids, and nobody who has gone. */
function route(gone: Set<string> = new Set()): { read: RowRead<Row>; asked: string[][] } {
  const asked: string[][] = [];
  const read: RowRead<Row> = async (want, columns) => {
    asked.push(want);
    if (want.length > VIEW_LIMITS.page) return { ok: false, error: "invalid_input" };
    return { ok: true, rows: want.filter((id) => !gone.has(id)).map((id) => ({ id, cols: columnsKey(columns) })) };
  };
  return { read, asked };
}

describe("reading a view's rows by id", () => {
  it("reads more than 50 ids in requests of 50, in order, so new columns after Load more still read", async () => {
    const { read, asked } = route();
    const r = await readRowsInPages(ids(128), ["person", "fld_repot0000001"], read);
    expect(asked.map((a) => a.length)).toEqual([50, 50, 28]);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.rows.map((x) => x.id)).toEqual(ids(128));
      expect(r.rows.every((x) => x.cols === "person,fld_repot0000001")).toBe(true);
    }
  });

  it("stops at the first failure and says why", async () => {
    let n = 0;
    const read: RowRead<Row> = async (want) => (++n === 2 ? { ok: false, error: "rate_limited" } : { ok: true, rows: want.map((id) => ({ id, cols: "" })) });
    expect(await readRowsInPages(ids(120), ["person"], read)).toEqual({ ok: false, error: "rate_limited" });
    expect(n).toBe(2);
  });

  it("pages by the ids asked, so someone gone since the run is never shown twice and Load more ends", async () => {
    const all = ids(60);
    const { read: fetch, asked } = route(new Set([all[10]!]));
    const read: ReadRows<Row> = new Map();
    // The first page: 50 asked, one of them gone.
    let shown = nextAsked(0, all.length);
    let missing = idsToRead(all, shown, read);
    let r = await readRowsInPages(missing, ["person"], fetch);
    if (r.ok) keepRead(read, missing, r.rows);
    expect(rowsToShow(all, shown, read)).toHaveLength(49);
    // Load more asks for the next 10 ids, not the last one shown again.
    shown = nextAsked(shown, all.length);
    missing = idsToRead(all, shown, read);
    expect(missing).toEqual(all.slice(50));
    r = await readRowsInPages(missing, ["person"], fetch);
    if (r.ok) keepRead(read, missing, r.rows);
    const rows = rowsToShow(all, shown, read);
    expect(rows).toHaveLength(59);
    expect(new Set(rows.map((x) => x.id)).size).toBe(59);
    expect(shown).toBe(all.length);
    // Nothing is asked for again: the gone person is kept as gone.
    expect(idsToRead(all, shown, read)).toEqual([]);
    expect(asked.flat().filter((id) => id === all[10])).toHaveLength(1);
  });

  it("asks only for what isn't read yet with these columns", () => {
    const all = ids(5);
    const read: ReadRows<Row> = new Map();
    keepRead(read, all.slice(0, 3), all.slice(0, 3).map((id) => ({ id, cols: "" })));
    expect(idsToRead(all, 5, read)).toEqual(all.slice(3));
    expect(idsToRead(all, 5, undefined)).toEqual(all);
    expect(rowsToShow(all, 5, undefined)).toEqual([]);
    expect(nextAsked(0, 0)).toBe(0);
    expect(nextAsked(50, 75)).toBe(75);
  });
});
