import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every query the map at any size makes, by shape, and the index it needs in
 * firestore.indexes.json. Only Firestore itself refuses a query with no index (the fake
 * serves anything), so a new query shape added without its index would pass every other
 * test and fail on dev. Add a line here with every new query.
 *
 * Every shape filters on `tenantId ==` first (the tenant layer adds it). Equality-only
 * shapes (a record by `nameKey`, rows by `subjectId`) are served by Firestore merging its
 * single-field indexes, and a brand's rows in document-id order by the single-field
 * `tenantId` index, so neither is listed.
 */
interface Shape {
  collection: string;
  /** Equality filters besides the tenant, in index order. */
  eq?: string[];
  /** An `array-contains` / `array-contains-any` filter. */
  contains?: string;
  /** The order, ascending unless `desc`. */
  order?: string;
  desc?: boolean;
  /** A nearest-neighbour search on this vector field. */
  vector?: string;
}

const SHAPES: Shape[] = [
  // brandMapRecords().pageAll(): a brand's records of a kind, a page at a time in `ref` order.
  { collection: "brand_map_groups", order: "ref" },
  { collection: "brand_map_subjects", order: "ref" },
  { collection: "brand_map_subjects", eq: ["groupId"], order: "ref" },
  { collection: "brand_map_subjects", eq: ["status"], order: "ref" },
  { collection: "brand_map_questions", eq: ["subjectId"], order: "ref" },
  { collection: "brand_map_questions", eq: ["status"], order: "ref" },
  { collection: "brand_map_questions", contains: "situationIds", order: "ref" },
  { collection: "brand_map_situations", order: "ref" },
  { collection: "brand_map_situations", eq: ["status"], order: "ref" },
  // A brand's imports, newest first.
  { collection: "brand_map_imports", order: "at", desc: true },
  // One subject's coverage: rows by question id, by question words, and close wording.
  { collection: "brand_map_pages", contains: "refs" },
  { collection: "brand_map_pages", contains: "textKeys" },
  { collection: "brand_map_pages", contains: "words" },
  // The subjects and buying situations nearest an article, a situation or a PDF's question.
  { collection: "brand_map_vectors", eq: ["kind"], vector: "embedding" },
];

type IndexField = { fieldPath: string; order?: string; arrayConfig?: string; vectorConfig?: unknown };
const INDEXES = (JSON.parse(readFileSync(join(process.cwd(), "firestore.indexes.json"), "utf8")) as {
  indexes: Array<{ collectionGroup: string; queryScope: string; fields: IndexField[] }>;
}).indexes;

const want = (s: Shape): string[] => [
  "tenantId:ASCENDING",
  ...(s.eq ?? []).map((f) => `${f}:ASCENDING`),
  ...(s.contains ? [`${s.contains}:CONTAINS`] : []),
  ...(s.order ? [`${s.order}:${s.desc ? "DESCENDING" : "ASCENDING"}`] : []),
  ...(s.vector ? [`${s.vector}:VECTOR`] : []),
];
const has = (f: IndexField) => `${f.fieldPath}:${f.order ?? f.arrayConfig ?? (f.vectorConfig ? "VECTOR" : "?")}`;

describe("the indexes the map at any size needs", () => {
  it.each(SHAPES.map((s) => [want(s).join(", "), s] as const))("%s", (_name, shape) => {
    const found = INDEXES.some((i) => i.collectionGroup === shape.collection && i.queryScope === "COLLECTION" && i.fields.map(has).join("|") === want(shape).join("|"));
    expect(found, `${shape.collection}: ${want(shape).join(", ")}`).toBe(true);
  });

  it("keeps the vector index the same size as the embeddings", () => {
    const vector = INDEXES.find((i) => i.collectionGroup === "brand_map_vectors")!.fields.find((f) => f.vectorConfig);
    expect(vector?.vectorConfig).toEqual({ dimension: 768, flat: {} });
  });
});
