import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles, stripComments } from "@/lib/ontology/storeScan";
import { LOOPS } from "@/lib/loops/registry";
import { addToFleetCells, FLEET_CELLS, FLEET_READ_MAX, FLEET_WRITE_MAX, fleetCellId, readFleetCells } from "./fleetCells";
import { TenantValidationError } from "./errors";
import { FakeFirestore } from "./testing/fakeFirestore";

/**
 * `fleet_cells` (learning loops step 5): counts across brands in the control plane, by row and
 * closed week, read and written by id only, every count under `n`, and nothing but counts.
 */

const ROOT = process.cwd();
const week = "2026-W48";

describe("fleet cell ids", () => {
  it("builds one row per kind and week, and the copy's own rows, from the server's names", () => {
    expect(fleetCellId.kind("post_image", week)).toBe("fh:post_image:2026-W48");
    expect(fleetCellId.kind("canvas.image_style", week)).toBe("fh:canvas.image_style:2026-W48");
    expect(fleetCellId.kind("image", week)).toBe("fh:image:2026-W48");
    expect([fleetCellId.orgs(week), fleetCellId.types(week), fleetCellId.calls(week)]).toEqual(["fh:_orgs:2026-W48", "fh:_types:2026-W48", "fh:_calls:2026-W48"]);
  });

  it("names every kind in the learning registry", () => {
    for (const kind of Object.keys(LOOPS)) expect(() => fleetCellId.kind(kind, week), kind).not.toThrow();
  });

  it("refuses a kind or week that isn't one, so no id, path or brand can make a row", () => {
    for (const kind of ["", "_orgs", "Post_Image", "post/image", "a:b", "ten_hearth/fleet", "x".repeat(65)]) {
      expect(() => fleetCellId.kind(kind, week), kind).toThrow(TenantValidationError);
    }
    for (const bad of ["2026-48", "2026-W54", "2026-W48:1", ""]) expect(() => fleetCellId.orgs(bad), bad).toThrow(TenantValidationError);
  });
});

describe("adding to fleet cells", () => {
  it("adds increments under n, summing the same row named twice, with no read", async () => {
    const db = new FakeFirestore();
    const id = fleetCellId.kind("post_image", week);
    const written = await addToFleetCells(
      [
        { id, n: { s: { stamped: { pro: 1 } }, m: { learned: 3 } } },
        { id, n: { s: { stamped: { pro: 2, free: 1 } } } },
        { id: fleetCellId.orgs(week), n: { p: { pro: 1 } } },
      ],
      db,
    );
    expect(written).toBe(2);
    expect(db.raw(FLEET_CELLS, id)).toEqual({ n: { s: { stamped: { pro: 3, free: 1 } }, m: { learned: 3 } } });
    await addToFleetCells([{ id, n: { m: { learned: 2, holdback: 1 } } }], db);
    expect(db.raw(FLEET_CELLS, id)).toEqual({ n: { s: { stamped: { pro: 3, free: 1 } }, m: { learned: 5, holdback: 1 } } });
  });

  it("keeps every row's data under the one exempt map n, and nothing else on it", async () => {
    const db = new FakeFirestore();
    await addToFleetCells([{ id: fleetCellId.types(week), n: { content_plan: { made: 4, orgs: 2 } } }, { id: fleetCellId.calls(week), n: { vizzy_chat: { calls: 9 } } }], db);
    expect(db.dump(FLEET_CELLS).map((doc) => Object.keys(doc))).toEqual([["n"], ["n"]]);
  });

  it("writes only whole amounts above 0, and skips a row with none", async () => {
    const db = new FakeFirestore();
    const written = await addToFleetCells(
      [
        { id: fleetCellId.kind("next_up", week), n: { made: 0, kept: -1, edited: 1.5 } },
        { id: fleetCellId.kind("post_image", week), n: { made: 2, kept: 0 } },
      ],
      db,
    );
    expect(written).toBe(1);
    expect(db.raw(FLEET_CELLS, fleetCellId.kind("next_up", week))).toBeUndefined();
    expect(db.raw(FLEET_CELLS, fleetCellId.kind("post_image", week))).toEqual({ n: { made: 2 } });
  });

  it("refuses an id it didn't build, a counter key that isn't one, and too many rows at once", async () => {
    const db = new FakeFirestore();
    for (const id of ["post_image:2026-W48", "fh:post_image", "fh:post_image:2026-W48:extra", "fh:../tenants:2026-W48", "lw:ten_hearth:2026-W48:0"]) {
      await expect(addToFleetCells([{ id, n: { made: 1 } }], db), id).rejects.toThrow(TenantValidationError);
    }
    await expect(addToFleetCells([{ id: fleetCellId.orgs(week), n: { "a/b": 1 } }], db)).rejects.toThrow(TenantValidationError);
    await expect(addToFleetCells([{ id: fleetCellId.orgs(week), n: { a: 1 } }, { id: fleetCellId.orgs(week), n: { a: { b: 1 } } }], db)).rejects.toThrow(TenantValidationError);
    const many = Array.from({ length: FLEET_WRITE_MAX + 1 }, (_, i) => ({ id: fleetCellId.kind(`k${i}`, week), n: { made: 1 } }));
    await expect(addToFleetCells(many, db)).rejects.toThrow(TenantValidationError);
    expect(db.dump(FLEET_CELLS)).toEqual([]);
  });
});

describe("reading fleet cells", () => {
  it("reads rows by id in order, a missing one as null", async () => {
    const db = new FakeFirestore();
    await addToFleetCells([{ id: fleetCellId.orgs(week), n: { p: { pro: 12 } } }], db);
    const rows = await readFleetCells([fleetCellId.orgs(week), fleetCellId.kind("post_image", week)], db);
    expect(rows).toEqual([{ id: "fh:_orgs:2026-W48", n: { p: { pro: 12 } } }, null]);
  });

  it("refuses an id it didn't build, and more than a bounded number at once", async () => {
    const db = new FakeFirestore();
    await expect(readFleetCells(["tenants"], db)).rejects.toThrow(TenantValidationError);
    const ids = Array.from({ length: FLEET_READ_MAX + 1 }, (_, i) => fleetCellId.kind(`k${i}`, week));
    await expect(readFleetCells(ids, db)).rejects.toThrow(TenantValidationError);
  });
});

describe("who reads counts across brands", () => {
  it("is only the lane, the Loops section and Work's Used counts: never Vizzy's routes, API v2 or a brand's pages", () => {
    const readers = sourceFiles("src", ROOT).filter((file) => /from\s+["']@\/lib\/tenant\/fleetCells["']|from\s+["']\.\/fleetCells["']/.test(stripComments(readFileSync(join(ROOT, file), "utf8"))));
    const allowed = /^src\/(?:lib\/loops\/|app\/admin\/account\/loops\/|lib\/work\/)/;
    expect(readers.filter((f) => !allowed.test(f))).toEqual([]);
  });
});
