import { describe, expect, it } from "vitest";
import { MARK_CELLS_MAX, MARK_OUTPUTS_MAX } from "@/lib/types/loopLane";
import { TenantValidationError } from "./errors";
import { LANE_DOC_ID, LOOP_LANE, laneMarkId, readLaneMarkTx, readLoopLane, runLaneTransaction, writeLaneMarkTx, writeLoopLane } from "./loopLane";
import { FakeFirestore } from "./testing/fakeFirestore";

/**
 * `loop_lane` (learning loops steps 4 and 5): the lane's own document, and one mark per
 * organisation, each under the one map `d`, with ids built from the brand's own record.
 */

const week = "2026-W48";

describe("organisation marks", () => {
  it("marks a brand under its organisation, or under itself when it has none", () => {
    expect(laneMarkId({ tenantId: "ten_hearth", organisationId: "org_ten_hearth" })).toBe("o:org_ten_hearth");
    expect(laneMarkId({ tenantId: "ten_lumen_eu", organisationId: "org_ten_lumen" })).toBe("o:org_ten_lumen");
    expect(laneMarkId({ tenantId: "ten_acme" })).toBe("o:t:ten_acme");
    expect(laneMarkId({ tenantId: "ten_acme", organisationId: null })).toBe("o:t:ten_acme");
  });

  it("gives two brands of one organisation one mark, and never the lane's own document", () => {
    const a = laneMarkId({ tenantId: "ten_lumen_us", organisationId: "org_ten_lumen" });
    const b = laneMarkId({ tenantId: "ten_lumen_eu", organisationId: "org_ten_lumen" });
    expect(a).toBe(b);
    expect(a).not.toBe(LANE_DOC_ID);
  });

  it("refuses an id that could leave its document or run into another", () => {
    for (const organisationId of ["org/x", "org:x", "x".repeat(161)]) {
      expect(() => laneMarkId({ tenantId: "ten_hearth", organisationId }), organisationId).toThrow(TenantValidationError);
    }
    expect(() => laneMarkId({ tenantId: "ten/hearth" })).toThrow(TenantValidationError);
  });

  it("moves a mark in a transaction, under d, and reads it back", async () => {
    const db = new FakeFirestore();
    const id = laneMarkId({ tenantId: "ten_hearth", organisationId: "org_ten_hearth" });
    expect(await runLaneTransaction((txn) => readLaneMarkTx(txn, id, db), db)).toBeNull();
    await runLaneTransaction(async (txn) => {
      await readLaneMarkTx(txn, id, db);
      writeLaneMarkTx(txn, id, { week, cells: ["post_image.s.stamped.pro"], outputs: { "post_image.m.learned": 4 } }, db);
    }, db);
    expect(db.raw(LOOP_LANE, id)).toEqual({ d: { week, cells: ["post_image.s.stamped.pro"], outputs: { "post_image.m.learned": 4 } } });
    expect(await runLaneTransaction((txn) => readLaneMarkTx(txn, id, db), db)).toEqual({ week, cells: ["post_image.s.stamped.pro"], outputs: { "post_image.m.learned": 4 } });
  });

  it("keeps marks apart from the lane's own document", async () => {
    const db = new FakeFirestore();
    await writeLoopLane({ cursor: "ten_hearth" }, db);
    const id = laneMarkId({ tenantId: "ten_acme" });
    await runLaneTransaction(async (txn) => writeLaneMarkTx(txn, id, { week, cells: [], outputs: {} }, db), db);
    expect((await readLoopLane(db)).cursor).toBe("ten_hearth");
    expect(db.dump(LOOP_LANE).map((doc) => Object.keys(doc))).toEqual([["d"], ["d"]]);
  });

  it("reads a mark it can't parse as none, so the week starts afresh and can only undercount", async () => {
    const db = new FakeFirestore();
    const id = laneMarkId({ tenantId: "ten_acme" });
    await db.collection(LOOP_LANE).doc(id).set({ d: { week: "last week", cells: "all" } });
    expect(await runLaneTransaction((txn) => readLaneMarkTx(txn, id, db), db)).toBeNull();
  });

  it("refuses a mark id laneMarkId didn't build, and a mark past its bounds", async () => {
    const db = new FakeFirestore();
    for (const id of [LANE_DOC_ID, "o:", "x:org_ten_hearth", "o:t:", "o:org/x"]) {
      await expect(runLaneTransaction((txn) => readLaneMarkTx(txn, id, db), db), id).rejects.toThrow(TenantValidationError);
    }
    const id = laneMarkId({ tenantId: "ten_acme" });
    const cells = Array.from({ length: MARK_CELLS_MAX + 1 }, (_, i) => `c${i}`);
    const outputs = Object.fromEntries(Array.from({ length: MARK_OUTPUTS_MAX + 1 }, (_, i) => [`o${i}`, 1]));
    await expect(runLaneTransaction(async (txn) => writeLaneMarkTx(txn, id, { week, cells, outputs: {} }, db), db)).rejects.toThrow();
    await expect(runLaneTransaction(async (txn) => writeLaneMarkTx(txn, id, { week, cells: [], outputs }, db), db)).rejects.toThrow();
    await expect(runLaneTransaction(async (txn) => writeLaneMarkTx(txn, id, { week: "2026-48", cells: [], outputs: {} }, db), db)).rejects.toThrow();
    expect(db.dump(LOOP_LANE)).toEqual([]);
  });
});
