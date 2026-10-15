import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import type { TenantContext } from "./types";
import { brandMapRecords, MAX_IN, recordDocId } from "./brandMapRecords";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "idtoken" };

describe("the brand map's records, one brand at a time", () => {
  it("keys each document by brand and record, so two brands' records never meet", async () => {
    const db = new FakeFirestore();
    expect(recordDocId("sub", "ten_A", "sub_aaaaaaaa")).not.toBe(recordDocId("sub", "ten_B", "sub_aaaaaaaa"));
    await brandMapRecords(A, db).create("sub", "sub_aaaaaaaa", { name: "Share of voice" });
    await brandMapRecords(B, db).create("sub", "sub_aaaaaaaa", { name: "Something else" });
    expect((await brandMapRecords(A, db).get("sub", "sub_aaaaaaaa"))?.name).toBe("Share of voice");
    expect((await brandMapRecords(B, db).get("sub", "sub_aaaaaaaa"))?.name).toBe("Something else");
    expect(await brandMapRecords(A, db).get("sub", "sub_bbbbbbbb")).toBeNull();
    expect((await brandMapRecords(A, db).find("sub")).map((r) => [r.id, r.tenantId])).toEqual([["sub_aaaaaaaa", "ten_A"]]);
  });

  it("never lets a filter widen the brand", async () => {
    const db = new FakeFirestore();
    await brandMapRecords(B, db).create("sub", "sub_bbbbbbbb", { name: "B's" });
    const asA = brandMapRecords(A, db);
    expect(await asA.find("sub", { where: [["tenantId", "==", "ten_B"]] })).toEqual([]);
    expect(await asA.pageAll("sub", { where: [["tenantId", "==", "ten_B"]] })).toEqual([]);
    expect(await asA.findIn("sub", "tenantId", ["ten_B"])).toEqual([]);
  });

  it("creates only what isn't there yet, and keeps a record's own id on a claim", async () => {
    const db = new FakeFirestore();
    const store = brandMapRecords(A, db);
    expect(await store.createIfAbsent("q", "q_aaaaaaaa", { text: "What is it?" })).not.toBeNull();
    expect(await store.createIfAbsent("q", "q_aaaaaaaa", { text: "Again" })).toBeNull();
    const claimed = await store.claim("q", "q_aaaaaaaa", () => ({ text: "What is it, really?", ref: "q_hijacked" }));
    expect(claimed).toMatchObject({ id: "q_aaaaaaaa", ref: "q_aaaaaaaa", text: "What is it, really?" });
    expect(await store.claim("q", "q_missing", () => ({ text: "x" }))).toBeNull();
  });

  it("asks `in` past Firestore's 30 values, and returns each record once", async () => {
    const db = new FakeFirestore();
    const store = brandMapRecords(A, db);
    const refs = Array.from({ length: 70 }, (_, i) => `q_${String(i).padStart(8, "0")}`);
    for (const ref of refs) await store.create("q", ref, { textKey: `question ${ref}`, subjectId: "sub_aaaaaaaa" });
    const wanted = [...refs.slice(0, 65), refs[0]!, "q_notthere"];
    expect(wanted.length).toBeGreaterThan(2 * MAX_IN);
    const found = await store.findIn("q", "ref", wanted);
    expect(found.map((r) => r.id).sort()).toEqual(refs.slice(0, 65));
  });

  it("pages through every record in id order, reading only the fields asked for", async () => {
    const db = new FakeFirestore();
    const store = brandMapRecords(A, db);
    const refs = Array.from({ length: 1203 }, (_, i) => `sub_${String(i).padStart(8, "0")}`);
    for (const ref of refs) await store.create("sub", ref, { name: `Subject ${ref}`, groupId: null, answeredIds: ["q_aaaaaaaa"] });
    const all = await store.pageAll("sub", { fields: ["name"], pageSize: 500 });
    expect(all.map((r) => r.id)).toEqual(refs);
    expect(all[0]).toEqual({ id: refs[0], ref: refs[0], tenantId: "ten_A", name: `Subject ${refs[0]}` });
    expect(await store.count("sub")).toBe(1203);
  });
});
