import { describe, expect, it, vi } from "vitest";
import type { Strategy } from "@/lib/brandStrategy/store";
import type { BrandMap } from "@/lib/types/brandMap";
import type { BrandMapSituation } from "@/lib/types/brandMapRecords";
import type { Tenant } from "@/lib/types/tenant";
import { metricReader } from "./metrics";
import { raiseContext, type RaisePackDeps } from "./pack";
import { ACME, FERNHILL, NOW, weeksOf } from "./testing/fixtures";

const map = {
  identity: { name: "Acme", category: "stock software", categorySameAs: [], statement: "Acme counts stock for small shops so owners get their evenings back.", isNot: ["a till"], avoid: [], site: "https://acme.example", profiles: [] },
  subjects: [],
  names: [{ id: "n_1", name: "independent shop owners", kind: "audience", aliases: [], sameAs: [] }],
} as unknown as BrandMap;

const strategy = {
  audiences: ["Owners of one to three shops"],
  claims: [
    { id: "cl_aaaaaa", side: "you", text: "Counts a shop in ten minutes", competitor: null, proof: { kind: "site", url: "https://acme.example/how", title: "How" }, proposed: null },
    { id: "cl_bbbbbb", side: "you", text: "Loved by every shop owner", competitor: null, proof: null, proposed: null },
  ],
  competitorGroups: [{ kind: "most", competitors: [{ name: "Tally", site: null, foundTimes: 1, evidence: [], ticked: false, from: "finder" }] }],
  goal: { text: "Reach 50 paying shops", measure: "paying shops", measureKey: null, from: "person", setAt: "" },
} as unknown as Strategy;

function deps(over: Partial<RaisePackDeps> = {}): RaisePackDeps {
  return {
    loadTenant: async () => ({ tenantName: "Acme Ltd", brandVoice: { summary: "Warm and plain." } }) as unknown as Tenant,
    brandMap: async () => map,
    situations: async () => [{ text: "Stock count day eats my Sunday", want: "a quicker count", feel: "worn out", who: "shop owner" } as unknown as BrandMapSituation],
    strategy: async () => strategy,
    competitors: async () => [],
    site: async (_ctx, q) => (q.includes("prices") ? [{ text: "Plans start at a low monthly price.", url: "https://acme.example/pricing" }] : [{ text: "Acme is stock counting for small shops.", url: "https://acme.example" }]),
    repo: async () => [],
    authors: async () => [{ id: "au_1", tenantId: "ten_acme", name: "Sam Lee", role: "Founder", bio: "Ran two shops for ten years.", url: "https://acme.example/sam", updatedAt: "" }],
    facts: async () => [{ id: "bf_1", kind: "goal", text: "Raise a small round in spring", heardAt: "2026-11-02T00:00:00.000Z" } as never],
    metrics: { now: () => NOW, weekly: async () => weeksOf(Array(12).fill(3)), launches: async () => null },
    ...over,
  };
}

describe("the deck context pack", () => {
  it("reads each part from its source, with its label, ids and links", async () => {
    const pack = await raiseContext(ACME, { audience: "investor", stage: "pre_seed" }, deps());
    expect(pack.brandName).toBe("Acme");
    expect(pack.parts.identity.map((l) => l.label)).toEqual(["brand_map", "brand_map", "brand_map"]);
    expect(pack.parts.identity[0]).toMatchObject({ id: "P1", text: map.identity.statement, url: "https://acme.example" });
    expect(pack.parts.customers.map((l) => [l.label, l.text])).toEqual([
      ["brand_map", "Who buys: independent shop owners."],
      ["brand_strategy", "Owners of one to three shops"],
    ]);
    expect(pack.parts.problem[0]!.text).toBe('"Stock count day eats my Sunday", wanting a quicker count, feeling worn out (shop owner)');
    expect(pack.parts.site.map((l) => l.url)).toEqual(["https://acme.example", "https://acme.example/pricing"]);
    expect(pack.parts.team[0]).toMatchObject({ label: "team", text: "Sam Lee, Founder: Ran two shops for ten years.", url: "https://acme.example/sam" });
    expect(pack.parts.goal[0]).toMatchObject({ label: "about", at: "2026-11-02" });
    expect(pack.parts.competition[0]).toMatchObject({ label: "brand_strategy", text: "Does most of what you do: Tally." });
    expect(pack.authors).toEqual([{ ref: "A1", id: "au_1", name: "Sam Lee", role: "Founder", bio: "Ran two shops for ten years." }]);
    expect(pack.voice).toContain("Warm and plain.");
    expect(pack.numbers.waitlist.hasData).toBe(true);
    expect(pack.lines.map((l) => l.id)).toEqual(pack.lines.map((_, i) => `P${i + 1}`));
  });

  it("leaves out claims without proof, and keeps the quarter's goal", async () => {
    const pack = await raiseContext(ACME, { audience: "investor", stage: "seed" }, deps());
    expect(pack.parts.edge.map((l) => l.text)).toEqual(["Counts a shop in ten minutes", "This quarter's goal: Reach 50 paying shops, measured by paying shops."]);
    expect(pack.parts.edge[0]!.url).toBe("https://acme.example/how");
  });

  it("turns what it couldn't see into missing lines", async () => {
    const bare = await raiseContext(ACME, { audience: "investor", stage: "pre_seed" }, deps({ brandMap: async () => null, strategy: async () => null, site: async () => [], authors: async () => [], metrics: { now: () => NOW, weekly: async () => weeksOf(Array(12).fill(0)) } }));
    expect(bare.missing).toEqual(["team", "competition", "site", "demand", "market", "raise"]);
    expect(bare.brandName).toBe("Acme Ltd");
    const lender = await raiseContext(FERNHILL, { audience: "lender", stage: "loan" }, deps());
    expect(lender.missing).toEqual(["sales", "borrow", "repayment"]);
  });

  it("keeps at most 5 lines a part and 220 characters a line", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ text: `Line ${i} ${"word ".repeat(80)}`, url: `https://acme.example/${i}` }));
    const pack = await raiseContext(ACME, { audience: "investor", stage: "pre_seed" }, deps({ site: async () => many }));
    expect(pack.parts.site).toHaveLength(5);
    for (const l of pack.lines) expect(l.text.length).toBeLessThanOrEqual(220);
    expect(pack.lines.length).toBeLessThanOrEqual(30);
  });

  it("fails soft on a read that throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = () => Promise.reject(new Error("down"));
    const pack = await raiseContext(ACME, { audience: "investor", stage: "pre_seed" }, deps({ brandMap: broken, strategy: broken, site: broken, authors: broken, facts: broken, reader: metricReader(ACME, { weekly: broken }) }));
    expect(pack.parts.identity).toEqual([]);
    expect(pack.missing).toContain("team");
    expect(pack.numbers.waitlist.hasData).toBe(false);
    warn.mockRestore();
  });
});
