import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { recordingFirestore } from "@/lib/tenant/testing/recordingFirestore";
import { shapeRecordingFirestore } from "@/lib/tenant/testing/queryShape";
import type { TenantContext } from "@/lib/tenant/types";
import type { RecordField } from "@/lib/types/recordField";
import { viewBackend } from "./backend";
import { fieldsToRead, MAX_RUNS, readViewRows, runViewInMemory, takeRunSlot } from "./source";
import { emptyView, type ViewDefinition, type ViewFilter } from "./types";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" };
const at = "2026-11-01T00:00:00.000Z";
const TYPE = {
  key: "fld_type00000001",
  label: "Customer type",
  type: "select",
  object: "person",
  options: [
    { id: "opt_retail01", label: "Retail" },
    { id: "opt_whole001", label: "Wholesale" },
  ],
  archivedAt: null,
  createdAt: at,
  createdBy: null,
} as RecordField;
const SPEND = { key: "fld_spend0000001", label: "Spend", type: "currency", currency: "GBP", object: "person", archivedAt: null, createdAt: at, createdBy: null } as RecordField;
const FIELDS = [TYPE, SPEND];
const NOW = new Date("2026-11-26T12:00:00.000Z");

/** A made-up person, newer the higher `n` is. */
function seedPerson(db: FakeFirestore, n: number, over: Record<string, unknown> = {}, tenantId = "ten_A") {
  const activeAt = new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
  const id = `ct_${tenantId}_${String(n).padStart(5, "0")}`;
  db.seed("contacts", id, {
    tenantId,
    contactKey: `p${n}@example.com`,
    email: `p${n}@example.com`,
    firstName: `Person ${n}`,
    memberOf: ["all"],
    reach: "yes",
    activeAt,
    sortKey: `${activeAt}|${id}`,
    firstSeenAt: activeAt,
    searchTokens: [`p${n}@example.com`, `p${n}`],
    ...over,
  });
  return id;
}

const def = (filters: ViewFilter[], over: Partial<ViewDefinition> = {}): ViewDefinition => ({ ...emptyView(), filters, ...over });
const run = async (db: FakeFirestore, d: ViewDefinition, q?: string) => {
  const r = await runViewInMemory(ctx, { definition: d, q, fields: FIELDS, now: NOW }, db);
  if (!r.ok) throw new Error(r.error);
  return r.run;
};

describe("reading people for a view", () => {
  it("reads at most the 5,000 most recently active, in pages of 1,000, with the real total", async () => {
    const db = new FakeFirestore();
    for (let n = 1; n <= 5003; n++) seedPerson(db, n);
    const ops: string[] = [];
    const r = await run(shapeRecordingFirestore(db, ops), def([]));
    expect(r).toMatchObject({ count: 5000, total: 5003, capped: true, start: { kind: "everyone" } });
    expect(r.ids[0]).toBe("ct_ten_A_05003");
    expect(r.ids[4999]).toBe("ct_ten_A_00004");
    // Five pages: the first, then four after a cursor.
    expect(ops.filter((o) => o === "startAfter")).toHaveLength(4);
    // Only the indexes the People list already uses: tenant, one memberOf array-contains, sortKey.
    expect(new Set(ops)).toEqual(new Set(["where tenantId ==", "where memberOf array-contains", "orderBy sortKey", "startAfter", "select sortKey,memberOf,reach"]));
  });

  it("starts a match all view from its smallest group, so a view under 5,000 is exact in a bigger brand", async () => {
    const db = new FakeFirestore();
    for (let n = 1; n <= 5010; n++) {
      const tags = ["all", ...(n % 50 === 0 ? ["launch:spring"] : []), ...(n % 500 === 0 ? [`field:${TYPE.key}:opt_whole001`] : [])];
      seedPerson(db, n, { memberOf: tags, fields: n % 500 === 0 ? { [TYPE.key]: "opt_whole001" } : {} });
    }
    const filters: ViewFilter[] = [
      { on: "launch", op: "any_of", value: ["spring"] },
      { on: TYPE.key, op: "any_of", value: ["opt_whole001"] },
    ];
    const all = await run(db, def(filters));
    expect(all).toMatchObject({ count: 10, total: 10, capped: false, start: { kind: "group", tag: `field:${TYPE.key}:opt_whole001` } });
    // A view rebuilt from a group counts the same as the group.
    expect(await run(db, def([filters[0]!]))).toMatchObject({ count: 100, total: 100, capped: false, start: { kind: "group", tag: "launch:spring" } });
    // Any of these has no group every match is in: it reads Everyone, capped.
    expect(await run(db, def(filters, { match: "any" }))).toMatchObject({ start: { kind: "everyone" }, total: 5010, capped: true });
  });

  it("reads only the fields the filters and sort use", async () => {
    expect(fieldsToRead(def([{ on: TYPE.key, op: "any_of", value: ["opt_whole001"] }, { on: "last_active", op: "in_last", value: 30 }]), FIELDS).sort()).toEqual(
      ["activeAt", `fields.${TYPE.key}`, "memberOf", "reach", "sortKey"].sort(),
    );
    expect(fieldsToRead(def([], { sort: { by: "person", dir: "asc" } }), FIELDS)).toEqual(expect.arrayContaining(["firstName", "lastName", "email"]));
    expect(fieldsToRead(def([], { sort: { by: SPEND.key, dir: "desc" } }), FIELDS)).toContain(`fields.${SPEND.key}`);
    expect(fieldsToRead(def([{ on: "email_domain", op: "not_empty" }, { on: "first_seen", op: "in_last", value: 7 }]), FIELDS)).toEqual(
      expect.arrayContaining(["emailDomain", "firstSeenAt"]),
    );

    // The run asks for exactly that projection, so names and addresses are never read for it.
    const db = new FakeFirestore();
    seedPerson(db, 1, { memberOf: ["all", `field:${TYPE.key}:opt_whole001`], fields: { [TYPE.key]: "opt_whole001", [SPEND.key]: 100 } });
    const ops: string[] = [];
    const d = def([{ on: TYPE.key, op: "any_of", value: ["opt_whole001"] }]);
    expect((await run(shapeRecordingFirestore(db, ops), d)).count).toBe(1);
    expect(ops.filter((o) => o.startsWith("select "))).toEqual([`select ${fieldsToRead(d, FIELDS).join(",")}`]);
  });

  it("with words in the search box, reads that search's people and keeps to Everyone", async () => {
    const db = new FakeFirestore();
    seedPerson(db, 1, { searchTokens: ["greenroom"], fields: { [TYPE.key]: "opt_whole001" } });
    seedPerson(db, 2, { searchTokens: ["greenroom"], fields: { [TYPE.key]: "opt_retail01" } });
    // Found by the search, but no longer in Everyone: never in a view.
    seedPerson(db, 3, { searchTokens: ["greenroom"], memberOf: [] });
    seedPerson(db, 4, { searchTokens: ["other"] });
    const ops: string[] = [];
    const r = await run(shapeRecordingFirestore(db, ops), def([]), "Greenroom");
    expect(r).toMatchObject({ count: 2, total: 3, capped: false, start: { kind: "search" } });
    expect(ops).toContain("where searchTokens array-contains");
    expect(ops).not.toContain("where memberOf array-contains");
    expect((await run(db, def([{ on: TYPE.key, op: "any_of", value: ["opt_whole001"] }]), "greenroom")).ids).toEqual(["ct_ten_A_00001"]);
  });

  it("never reads another brand's people", async () => {
    const db = new FakeFirestore();
    seedPerson(db, 1, { memberOf: ["all", "launch:spring"] });
    seedPerson(db, 2, { memberOf: ["all", "launch:spring"] }, "ten_B");
    seedPerson(db, 3, { searchTokens: ["shared"] }, "ten_B");
    const asked: string[] = [];
    const rec = recordingFirestore(db, asked);
    expect((await run(rec, def([{ on: "launch", op: "any_of", value: ["spring"] }]))).ids).toEqual(["ct_ten_A_00001"]);
    expect((await run(rec, def([]), "shared")).count).toBe(0);
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(["ten_A"]));
    expect(await readViewRows(ctx, ["ct_ten_B_00002"], ["person"], FIELDS, db)).toEqual([]);
  });

  it("runs at most two views at a time on an instance", async () => {
    const db = new FakeFirestore();
    seedPerson(db, 1);
    const slots = Array.from({ length: MAX_RUNS }, () => takeRunSlot());
    expect(slots.every(Boolean)).toBe(true);
    expect(takeRunSlot()).toBeNull();
    expect(await runViewInMemory(ctx, { definition: def([]), fields: FIELDS }, db)).toEqual({ ok: false, error: "views_busy" });
    slots[0]!();
    slots[0]!(); // releasing twice frees one slot only
    expect((await viewBackend().run(ctx, { definition: def([]), fields: FIELDS }, db)).ok).toBe(true);
    expect(takeRunSlot()).not.toBeNull();
    expect(takeRunSlot()).toBeNull();
  });
});

describe("a view's rows", () => {
  it("are read by id in the order asked, with values only for the field columns in use", async () => {
    const db = new FakeFirestore();
    const a = seedPerson(db, 1, { fields: { [TYPE.key]: "opt_whole001", [SPEND.key]: 4820 } });
    const b = seedPerson(db, 2, { fields: { [TYPE.key]: "opt_retail01" } });
    const gone = seedPerson(db, 3, { memberOf: [] });
    const rows = await readViewRows(ctx, [b, a, gone, "ct_missing", "../bad"], ["person", SPEND.key, "fld_gone00000001"], FIELDS, db);
    expect(rows.map((r) => r.id)).toEqual([b, a]);
    expect(rows[1]).toMatchObject({ email: "p1@example.com", fields: { [SPEND.key]: 4820 }, firstSeenAt: expect.any(String) });
    expect(rows[1]!.fields).not.toHaveProperty(TYPE.key);
  });
});
