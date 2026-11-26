import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { shapeRecordingFirestore } from "@/lib/tenant/testing/queryShape";
import { countProductEventsExact, productEventCount } from "./counted";
import { LUMEN_US } from "./testing/fixtures";

/**
 * The composite indexes Work's queries need (ADR-0020), by shape, in firestore.indexes.json (one
 * file for all three databases, firebase.json). Only Firestore refuses a query with no index (the
 * emulator and the fake serve anything), so a shape added without its index passes every other
 * test and fails once deployed. src/lib/tenant/work.test.ts records each query's shape.
 *
 * Work's shapes start with organisationId, not tenantId: an organisation's records carry no
 * tenant, like Connectors 3's. The Used count reads product_events through the tenant layer, so
 * its shapes start with tenantId. Every other Work read is by id or by equality alone, in
 * document id order, which needs no composite index.
 */

interface Shape {
  collection: string;
  fields: string[];
  by: string;
}

/** The exact Used count's index, approved for all three databases. */
const EXACT = ["tenantId:ASCENDING", "connectionId:ASCENDING", "event:ASCENDING", "receivedAt:ASCENDING"];
/** The Connected product's events list index, which the Used count falls back to. */
const NEWEST = ["tenantId:ASCENDING", "connectionId:ASCENDING", "receivedAt:DESCENDING"];

const SHAPES: Shape[] = [
  // The list across the organisation's brands: open or closed, newest closed first.
  { collection: "work_tasks", fields: ["organisationId:ASCENDING", "open:ASCENDING", "closedAt:DESCENDING"], by: "listWorkTasks (src/lib/tenant/work.ts), with no brand" },
  // The Log: a day's rows, newest first.
  { collection: "work_log", fields: ["organisationId:ASCENDING", "at:DESCENDING"], by: "listWorkLog (src/lib/tenant/work.ts)" },
  // A Used measure's product event count: an exact count() of the brand's events with that name
  // from Done to the check.
  { collection: "product_events", fields: EXACT, by: "the exact Used count, countProductEventsExact (src/lib/work/counted.ts)" },
  // While that index is missing or still building, the newest 2,000 events instead, through the
  // index the Connected product's events list already has.
  { collection: "product_events", fields: NEWEST, by: "the Used count's fallback to the newest 2,000 events (src/lib/work/counted.ts)" },
];

type IndexField = { fieldPath: string; order?: string; arrayConfig?: string };
const FILE = JSON.parse(readFileSync(join(process.cwd(), "firestore.indexes.json"), "utf8")) as {
  indexes: Array<{ collectionGroup: string; queryScope: string; fields: IndexField[] }>;
  fieldOverrides: Array<{ collectionGroup: string; fieldPath: string; indexes: unknown[]; ttl?: boolean }>;
};
const has = (f: IndexField) => `${f.fieldPath}:${f.order ?? f.arrayConfig ?? "?"}`;
const indexed = (collection: string, fields: string[]) =>
  FILE.indexes.some((i) => i.collectionGroup === collection && i.queryScope === "COLLECTION" && i.fields.map(has).join("|") === fields.join("|"));

describe("the indexes Work's queries need", () => {
  it.each(SHAPES.map((s) => [`${s.collection}: ${s.fields.join(", ")}`, s] as const))("%s", (_name, s) => {
    expect(indexed(s.collection, s.fields), `${s.by} needs ${s.collection} (${s.fields.join(", ")}) in firestore.indexes.json`).toBe(true);
  });

  it("adds only these two composite indexes for Work's own collections", () => {
    const mine = FILE.indexes.filter((i) => i.collectionGroup === "work_tasks" || i.collectionGroup === "work_log");
    expect(mine).toHaveLength(2);
  });
});

/**
 * Whether an index serves a query of these recorded shapes (src/lib/tenant/testing/queryShape.ts):
 * its equality fields first, in any order, then the one range field in the query's order
 * (ascending when the query sets none, as Firestore orders a range), and nothing else. The
 * recorder doesn't note an order's direction, so `dir` gives it.
 */
function serves(ops: string[], index: string[], dir: "ASCENDING" | "DESCENDING" = "ASCENDING"): boolean {
  const field = (o: string) => o.split(" ")[1]!;
  const eq = ops.filter((o) => / ==$/.test(o)).map(field);
  const ranges = [...new Set(ops.filter((o) => /^where \S+ (<|<=|>|>=)$/.test(o)).map(field))];
  const orders = [...new Set(ops.filter((o) => o.startsWith("orderBy ")).map(field))];
  if (ranges.length > 1 || orders.length > 1 || (ranges[0] && orders[0] && ranges[0] !== orders[0])) return false;
  const last = orders[0] ?? ranges[0];
  const lead = index.slice(0, eq.length).map((f) => f.split(":")[0]!);
  const rest = index.slice(eq.length);
  return new Set(lead).size === eq.length && eq.every((f) => lead.includes(f)) && rest.join("|") === (last ? `${last}:${dir}` : "");
}

describe("the exact Used count's index", () => {
  const ctx = { tenantId: LUMEN_US, region: "us" as const, source: "system" as const };
  const ask = { connectionId: "pc_lumen", event: "note_from_template", from: "2026-11-20T00:00:00.000Z", to: "2026-12-04T08:00:00.000Z" };
  afterEach(() => vi.restoreAllMocks());

  it("is listed once, in exactly this shape: the only product_events index with the event name in it", () => {
    const withEvent = FILE.indexes.filter((i) => i.collectionGroup === "product_events" && i.fields.some((f) => f.fieldPath === "event"));
    expect(withEvent.map((i) => `${i.queryScope} ${i.fields.map(has).join(", ")}`)).toEqual([`COLLECTION ${EXACT.join(", ")}`]);
  });

  it("serves the exact count's query as the tenant layer asks it: equality on the brand, connection and name, a range on receivedAt", async () => {
    const ops: string[] = [];
    await countProductEventsExact(ctx, ask, shapeRecordingFirestore(new FakeFirestore(), ops));
    expect(ops).toEqual(["where tenantId ==", "where connectionId ==", "where event ==", "where receivedAt >=", "where receivedAt <="]);
    expect(serves(ops, EXACT)).toBe(true);
    expect(serves(ops, NEWEST, "DESCENDING")).toBe(false);
  });

  it("is the index the Used count asks first, and the fallback uses only the events list's", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const exact: string[] = [];
    await productEventCount(ctx, ask, shapeRecordingFirestore(new FakeFirestore(), exact));
    expect(serves(exact, EXACT)).toBe(true);
    const both: string[] = [];
    await productEventCount(ctx, ask, shapeRecordingFirestore(failingFirestore(new FakeFirestore(), { countsNeedIndex: ["product_events"] }), both));
    const second = both.lastIndexOf("where tenantId ==");
    expect(serves(both.slice(0, second), EXACT)).toBe(true);
    expect(serves(both.slice(second), NEWEST, "DESCENDING")).toBe(true);
  });
});

/**
 * Maps, lists and long text nobody queries: exempt from automatic indexing, or every key, entry or
 * word is its own index entry. An exemption on a map covers its subfields, so measure.then,
 * measure.proposed, check.counted and decision.plan need no lines of their own.
 */
const EXEMPT: Record<string, string[]> = {
  work_tasks: ["description", "notes", "recent", "links", "typedLinks", "origin", "measure", "check"],
  work_log: ["note", "links", "before", "after", "decision", "check"],
};

describe("the values Work stores", () => {
  it.each(Object.entries(EXEMPT).flatMap(([c, fields]) => fields.map((f) => [`${c}.${f}`, c, f] as const)))("%s is exempt from automatic indexing", (_name, collection, field) => {
    expect(FILE.fieldOverrides.some((o) => o.collectionGroup === collection && o.fieldPath === field && o.indexes.length === 0)).toBe(true);
  });

  it("adds no other exemption, and no time to live, on its collections", () => {
    const mine = FILE.fieldOverrides.filter((o) => o.collectionGroup in EXEMPT);
    expect(mine.map((o) => `${o.collectionGroup}.${o.fieldPath}`).sort()).toEqual(Object.entries(EXEMPT).flatMap(([c, fs]) => fs.map((f) => `${c}.${f}`)).sort());
    expect(mine.some((o) => o.ttl)).toBe(false);
  });

  it("is in no time to live setup: work_log rows go only when the organisation's Work is erased", () => {
    const ttl = readFileSync(join(process.cwd(), "infra", "lifecycle", "setup.sh"), "utf8");
    expect(ttl).toContain("product_events");
    expect(ttl).not.toMatch(/work_(?:tasks|log)/);
  });
});
