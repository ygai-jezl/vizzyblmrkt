import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every composite query piece B's code makes, by shape, and the index it needs in firestore.indexes.json:
 * the two it adds (settings and catalog history) and the ones it relies on from before (People filters,
 * the timeline, Review's suggestions, the tick's expiry). A person's page reads their suggestions by
 * equality filters only, which needs no composite index.
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
  /** An array-contains filter, after the equality filters. */
  contains?: string;
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
  // People by a field value or a product group (a memberOf tag), newest first, and only those we can email.
  { collection: "contacts", contains: "memberOf", order: "sortKey", desc: true, by: "loadPeople (src/lib/audience/peopleList.ts), field and group filters" },
  { collection: "contacts", eq: ["reach"], contains: "memberOf", order: "sortKey", desc: true, by: "loadPeople with Only people we can email (src/lib/audience/peopleList.ts)" },
  // A person's timeline, newest first.
  { collection: "ontology_events", eq: ["personId"], order: "at", desc: true, by: "listPersonEvents for loadPersonTimeline (src/lib/audience/personTimelineView.ts)" },
  // Open field suggestions and New person drafts in Review, newest first.
  { collection: "agent_actions", eq: ["action", "state"], order: "createdAt", desc: true, by: "listOpenAgentActions for Review (src/lib/review/summary.ts)" },
  // Actions past their expiry, on the lifecycle tick.
  { collection: "agent_actions", eq: ["state"], order: "expiresAt", by: "expireAgentActions via expireDueAgentActions (src/lib/lifecycle/runner.ts)" },
];

type IndexField = { fieldPath: string; order?: string; arrayConfig?: string };
const INDEXES = (JSON.parse(readFileSync(join(process.cwd(), "firestore.indexes.json"), "utf8")) as {
  indexes: Array<{ collectionGroup: string; queryScope: string; fields: IndexField[] }>;
}).indexes;

const want = (s: Shape): string[] => [
  "tenantId:ASCENDING",
  ...(s.eq ?? []).map((f) => `${f}:ASCENDING`),
  ...(s.contains ? [`${s.contains}:CONTAINS`] : []),
  `${s.order}:${s.desc ? "DESCENDING" : "ASCENDING"}`,
];
const has = (f: IndexField) => `${f.fieldPath}:${f.order ?? f.arrayConfig ?? "?"}`;

describe("the indexes piece B's queries need", () => {
  it.each(SHAPES.map((s) => [`${s.collection}: ${want(s).join(", ")}`, s] as const))("%s", (_name, shape) => {
    const found = INDEXES.some(
      (i) => i.collectionGroup === shape.collection && i.queryScope === "COLLECTION" && i.fields.map(has).join("|") === want(shape).join("|"),
    );
    expect(found, `${shape.by} needs ${shape.collection} (${want(shape).join(", ")}) in firestore.indexes.json`).toBe(true);
  });
});

/**
 * Maps and lists nobody queries: exempt from automatic indexing, or every key or entry is its own
 * index entry. These are the only field exemptions piece B adds.
 */
const EXEMPT = [
  { collection: "contacts", field: "fields", by: "setRecordFieldValues (src/lib/tenant/recordFieldWrites.ts)" },
  { collection: "companies", field: "fields", by: "setRecordFieldValues (src/lib/tenant/recordFieldWrites.ts)" },
  // A whole setting and its changed items, kept per version and only ever read by id or subject.
  { collection: "settings_versions", field: "snapshot", by: "commitSettingsChange (src/lib/tenant/settingsLog.ts)" },
  { collection: "settings_versions", field: "items", by: "commitSettingsChange (src/lib/tenant/settingsLog.ts)" },
];
const OVERRIDES = (JSON.parse(readFileSync(join(process.cwd(), "firestore.indexes.json"), "utf8")) as {
  fieldOverrides: Array<{ collectionGroup: string; fieldPath: string; indexes: unknown[] }>;
}).fieldOverrides;

describe("the values piece B stores", () => {
  it.each(EXEMPT.map((e) => [`${e.collection}.${e.field}`, e] as const))("%s is exempt from automatic indexing", (_name, e) => {
    const found = OVERRIDES.some((o) => o.collectionGroup === e.collection && o.fieldPath === e.field && o.indexes.length === 0);
    expect(found, `${e.by} writes ${e.collection}.${e.field}, which needs a field exemption in firestore.indexes.json`).toBe(true);
  });

  it("adds no other exemption on the collections it writes", () => {
    const mine = new Set(EXEMPT.map((e) => e.collection));
    const theirs = OVERRIDES.filter((o) => mine.has(o.collectionGroup) && !EXEMPT.some((e) => e.collection === o.collectionGroup && e.field === o.fieldPath));
    // contacts.products and contacts.optOuts were exempt before piece B.
    expect(theirs.map((o) => `${o.collectionGroup}.${o.fieldPath}`).sort()).toEqual(["contacts.optOuts", "contacts.products"]);
  });
});
