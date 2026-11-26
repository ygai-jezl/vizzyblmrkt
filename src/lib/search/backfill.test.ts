import { afterEach, describe, expect, it, vi } from "vitest";
import { backfillTargets, costWords, parseKinds } from "./backfill";

// What scripts/search-backfill.ts decides before it reads anything (ADR-0025).
afterEach(() => vi.unstubAllEnvs());
const tenant = (id: string, grantedFeatures: string[] = []) => ({ id, region: "us", grantedFeatures }) as never;

describe("--kinds", () => {
  it("takes kinds and their old names, and names the first word that isn't one", () => {
    expect(parseKinds(["subject", "situation", "note", "question", "competitor"])).toEqual({ kinds: new Set(["subject", "situation", "note", "question", "competitor"]) });
    expect(parseKinds(["idea"])).toEqual({ kinds: new Set(["idea_board"]) });
    expect(parseKinds(["subject", "people"])).toEqual({ unknown: "people" });
  });
});

describe("the brands to fill", () => {
  it("takes brands granted search, or with --all-brands every brand, the others for the family only", () => {
    vi.stubEnv("GRANTED_ONLY_FEATURES", "brand_search");
    const tenants = [tenant("ten_a", ["brand_search"]), tenant("ten_b")];
    expect(backfillTargets(tenants, { allBrands: false }).map((t) => [t.tenant.id, t.familyOnly])).toEqual([["ten_a", false]]);
    expect(backfillTargets(tenants, { allBrands: true }).map((t) => [t.tenant.id, t.familyOnly])).toEqual([
      ["ten_a", false],
      ["ten_b", true],
    ]);
    expect(backfillTargets(tenants, { allBrands: true, tenant: "ten_b" }).map((t) => t.tenant.id)).toEqual(["ten_b"]);
  });
});

describe("the dry run's cost line", () => {
  it("says chunks, tokens at about 4 characters each and dollars at $0.15 a million, and what gets its status only", () => {
    expect(costWords({ chunks: 120, chars: 400_000, statusOnly: 3 })).toBe("120 chunks, about 100,000 tokens, about $0.0150; 3 records status only");
    expect(costWords({ chunks: 1, chars: 40, statusOnly: 0 })).toBe("1 chunk, about 10 tokens, under $0.0001; 0 records status only");
    expect(costWords({ chunks: 0, chars: 0, statusOnly: 5 })).toBe("0 chunks, about 0 tokens, $0; 5 records status only");
  });
});
