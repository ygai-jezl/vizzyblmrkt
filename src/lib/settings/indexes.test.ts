import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every composite query piece B adds, by shape, and the index it needs in firestore.indexes.json.
 * Only Firestore itself refuses a query with no index (the emulator and the fake serve anything),
 * so a new query shape added without its index passes every other test and fails once deployed.
 * Add a line here with every new query (src/lib/brandMap/indexes.test.ts does the same for the map).
 *
 * Every shape filters on `tenantId ==` first: the tenant layer adds it.
 */
interface Shape {
  collection: string;
  /** Equality filters besides the tenant, in index order. */
  eq?: string[];
  order: string;
  desc?: boolean;
  /** Where the query is made. */
  by: string;
}

const SHAPES: Shape[] = [
  // One setting's history, newest first.
  { collection: "settings_versions", eq: ["subject"], order: "rev", desc: true, by: "listSettingsVersions (src/lib/settings/history.ts)" },
  // One catalog's history, newest first, now that every version is kept.
  { collection: "catalog_revisions", eq: ["connectionId"], order: "rev", desc: true, by: "listCatalogRevisions (src/lib/connect/catalogHistory.ts)" },
];

type IndexField = { fieldPath: string; order?: string; arrayConfig?: string };
const INDEXES = (JSON.parse(readFileSync(join(process.cwd(), "firestore.indexes.json"), "utf8")) as {
  indexes: Array<{ collectionGroup: string; queryScope: string; fields: IndexField[] }>;
}).indexes;

const want = (s: Shape): string[] => ["tenantId:ASCENDING", ...(s.eq ?? []).map((f) => `${f}:ASCENDING`), `${s.order}:${s.desc ? "DESCENDING" : "ASCENDING"}`];
const has = (f: IndexField) => `${f.fieldPath}:${f.order ?? f.arrayConfig ?? "?"}`;

describe("the indexes piece B's queries need", () => {
  it.each(SHAPES.map((s) => [`${s.collection}: ${want(s).join(", ")}`, s] as const))("%s", (_name, shape) => {
    const found = INDEXES.some(
      (i) => i.collectionGroup === shape.collection && i.queryScope === "COLLECTION" && i.fields.map(has).join("|") === want(shape).join("|"),
    );
    expect(found, `${shape.by} needs ${shape.collection} (${want(shape).join(", ")}) in firestore.indexes.json`).toBe(true);
  });
});

/** Maps whose keys are ids the brand makes: exempt from automatic indexing, or every key is its own index entry. */
const EXEMPT = [
  { collection: "contacts", field: "fields", by: "setRecordFieldValues (src/lib/tenant/recordFieldWrites.ts)" },
  { collection: "companies", field: "fields", by: "setRecordFieldValues (src/lib/tenant/recordFieldWrites.ts)" },
];
const OVERRIDES = (JSON.parse(readFileSync(join(process.cwd(), "firestore.indexes.json"), "utf8")) as {
  fieldOverrides: Array<{ collectionGroup: string; fieldPath: string; indexes: unknown[] }>;
}).fieldOverrides;

describe("the field values piece B stores", () => {
  it.each(EXEMPT.map((e) => [`${e.collection}.${e.field}`, e] as const))("%s is exempt from automatic indexing", (_name, e) => {
    const found = OVERRIDES.some((o) => o.collectionGroup === e.collection && o.fieldPath === e.field && o.indexes.length === 0);
    expect(found, `${e.by} writes ${e.collection}.${e.field}, which needs a field exemption in firestore.indexes.json`).toBe(true);
  });
});
