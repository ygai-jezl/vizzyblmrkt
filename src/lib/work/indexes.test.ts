import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The composite indexes Work's queries need (ADR-0020), by shape, in firestore.indexes.json (one
 * file for all three databases, firebase.json). Only Firestore refuses a query with no index (the
 * emulator and the fake serve anything), so a shape added without its index passes every other
 * test and fails once deployed. src/lib/tenant/work.test.ts records each query's shape.
 *
 * Work's shapes start with organisationId, not tenantId: an organisation's records carry no
 * tenant, like Connectors 3's. Every other Work read is by id or by equality alone, in document id
 * order, which needs no composite index.
 */

interface Shape {
  collection: string;
  fields: string[];
  by: string;
}

const SHAPES: Shape[] = [
  // The list across the organisation's brands: open or closed, newest closed first.
  { collection: "work_tasks", fields: ["organisationId:ASCENDING", "open:ASCENDING", "closedAt:DESCENDING"], by: "listWorkTasks (src/lib/tenant/work.ts), with no brand" },
  // The Log: a day's rows, newest first.
  { collection: "work_log", fields: ["organisationId:ASCENDING", "at:DESCENDING"], by: "listWorkLog (src/lib/tenant/work.ts)" },
  // A Used measure's product event count reads the newest 2,000 of the brand's events from Done to
  // the check, through the index the Connected product's events list already has.
  { collection: "product_events", fields: ["tenantId:ASCENDING", "connectionId:ASCENDING", "receivedAt:DESCENDING"], by: "the Used count's newest 2,000 events (src/lib/work/counted.ts)" },
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

  it("leaves out the exact product event count's index, which isn't approved yet", () => {
    // countProductEventsExact (src/lib/work/counted.ts) needs it and stays unwired until it is added.
    expect(indexed("product_events", ["tenantId:ASCENDING", "connectionId:ASCENDING", "event:ASCENDING", "receivedAt:ASCENDING"])).toBe(false);
    expect(indexed("product_events", ["tenantId:ASCENDING", "connectionId:ASCENDING", "event:ASCENDING", "receivedAt:DESCENDING"])).toBe(false);
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
