import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * Drift guard: the product-map schema lives in two places because the
 * knowledge-scraper worker is an isolated package that can't import the app.
 * The worker WRITES maps with its copy; the app re-validates and accepts them
 * with this one. They must stay byte-identical — edit the worker's
 * workers/knowledge-scraper/src/productMap/schema.ts and copy it here.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("product map schema ⟷ worker sync", () => {
  it("is identical to the worker's copy", () => {
    expect(read("./productMapSchema.ts")).toBe(read("../../../workers/knowledge-scraper/src/productMap/schema.ts"));
  });
});
