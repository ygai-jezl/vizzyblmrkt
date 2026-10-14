import { afterEach, describe, expect, it, vi } from "vitest";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { describeChange, fold } from "./changes";
import { checkProposal, parseMapProposal, proposeBrandMap, type ProposalContext } from "./research";

vi.mock("@/lib/tenant", () => ({
  getTenantById: vi.fn(async () => ({ id: "ten_acme", tenantName: "Acme", rootDomain: "acme.example", allowedOrigins: [], brandVoice: { summary: "Plain and direct." } })),
  forTenant: () => ({ workspaces: { find: async () => [{ id: "ws1", name: "Blog", updatedAt: "2026-10-01" }] } }),
}));
vi.mock("@/lib/tenant/workspaceContent", () => ({ listContentPlans: vi.fn(async () => []) }));

afterEach(() => vi.clearAllMocks());

const ANSWER = [
  "Here is the map:",
  "IS: Acme measures how your brand shows up in AI answers, for marketing teams.",
  "CATEGORY: AI visibility tracking",
  "NOT: A general SEO suite",
  "AVOID: GEO tool | AI visibility tracking",
  "AVOID: AI magic | Something nobody named",
  "SUBJECT: Share of voice",
  "Q: What is share of voice in AI search? | definition",
  "Q: Acme vs Rivalco: which fits a small team? | comparison",
  "Q: Rivalco vs Peec? | comparison",
  "Q: Acme vs Peec? | comparison",
  "SUBJECT: Citation gaps",
  "Q: How do I find my citation gaps? | how to",
  "NAME: Acme Pulse | product | Pulse; acme pulse",
  "NAME: Acme Atlas | product | none",
  "NAME: Rivalco | alternative | Rivalco Inc",
  "NAME: ExampleCRM | integration |",
  "NAME: Marketing teams | audience |",
  "NAME: See https://evil.example/x | alternative |",
  "HOME: Share of voice | 2",
  "HOME: Acme Pulse | 1",
  "HOME: Rivalco | 1",
  "HOME: Citation gaps | 99",
].join("\n");

const context = (over: Partial<ProposalContext> = {}): ProposalContext => ({
  current: BrandMapDecidedSchema.parse({}),
  firstParty: fold("Acme Pulse sends a weekly report. Marketing teams use it."),
  pages: [
    { url: "https://acme.example/pulse", title: "Pulse" },
    { url: "https://acme.example/share-of-voice", title: "Share of voice" },
  ],
  profiles: ["https://www.linkedin.com/company/acme-example"],
  brandName: "Acme",
  site: "https://acme.example",
  ...over,
});

describe("research for the brand map", () => {
  it("reads the answer's lines, a question under the subject before it, and drops any line with an address", () => {
    const p = parseMapProposal(ANSWER);
    expect(p.category).toBe("AI visibility tracking");
    expect(p.subjects.map((s) => [s.name, s.questions.length])).toEqual([
      ["Share of voice", 4],
      ["Citation gaps", 1],
    ]);
    expect(p.subjects[1]!.questions[0]!.intent).toBe("how_to");
    expect(p.names.map((n) => n.name)).toEqual(["Acme Pulse", "Acme Atlas", "Rivalco", "ExampleCRM", "Marketing teams"]);
    expect(p.names[0]!.aliases).toEqual(["Pulse"]);
    expect(p.homes).toEqual([
      { label: "Share of voice", n: 2 },
      { label: "Acme Pulse", n: 1 },
      { label: "Rivalco", n: 1 },
      { label: "Citation gaps", n: 99 },
    ]);
  });

  it("keeps only what code can stand behind", () => {
    const said = checkProposal(parseMapProposal(ANSWER), context()).map((i) => describeChange(i.change));
    expect(said).toEqual([
      "Call the brand “Acme”",
      "Your site is acme.example",
      "Say what you are as: “Acme measures how your brand shows up in AI answers, for marketing teams.”",
      "Call your category “AI visibility tracking”",
      "Add to what you are not: “A general SEO suite”",
      "Add a subject: “Share of voice”",
      "Add a question to Share of voice: “What is share of voice in AI search?”",
      // Two comparison questions at most per subject.
      "Add a question to Share of voice: “Acme vs Rivalco: which fits a small team?”",
      "Add a question to Share of voice: “Rivalco vs Peec?”",
      "Add a subject: “Citation gaps”",
      "Add a question to Citation gaps: “How do I find my citation gaps?”",
      // A product only as the brand's own material names it (Atlas is not; nor is the integration).
      "Add Acme Pulse as a product",
      "Add Rivalco as an alternative",
      "Add Marketing teams as who it is for",
      // A name to avoid only with a name to use that the map has.
      "Avoid “GEO tool”. Say “AI visibility tracking”.",
      // A home only by number, and only for a subject or the brand's own name.
      "Make acme.example/share-of-voice the page for Share of voice",
      "Make acme.example/pulse the page for Acme Pulse",
      "Add a profile link: linkedin.com/company/acme-example",
    ]);
  });

  it("never replaces what a person decided", () => {
    const current = BrandMapDecidedSchema.parse({
      identity: { name: "Acme Inc", category: "AI search visibility", statement: "Ours.", site: "https://acme.example" },
      subjects: [{ id: "sub_aaaaaaaa", name: "Share of voice", home: "https://acme.example/sov" }],
    });
    const said = checkProposal(parseMapProposal(ANSWER), context({ current })).map((i) => describeChange(i.change));
    expect(said.some((s) => s.startsWith("Call") || s.startsWith("Say what") || s.startsWith("Your site"))).toBe(false);
    expect(said.some((s) => s.includes("the page for Share of voice"))).toBe(false);
  });

  it("drafts from the brand's material and a web search, and writes nothing itself", async () => {
    const grounded = vi.fn(async (_prompt: string) => ({ text: ANSWER, model: "m", sources: [], supports: [] }));
    const r = await proposeBrandMap(
      { tenantId: "ten_acme", region: "us", source: "idtoken" },
      { current: BrandMapDecidedSchema.parse({}) },
      {
        grounded: grounded as never,
        modelReady: () => true,
        retrieve: (async () => ({ formatted: "[Source: Pulse — https://acme.example/pulse]\nAcme Pulse sends a weekly report.", chunks: [] })) as never,
        sitePages: async () => ({ pages: [{ url: "https://acme.example/pulse", title: "Pulse" }, { url: "https://elsewhere.example/x", title: "Not ours" }], repoPaths: [] }),
        fetchHome: async () => ({ html: '<a href="https://x.com/acme_example">X</a>', text: "Acme. Marketing teams use it.", baseUrl: "https://acme.example/" }),
        plans: (async () => []) as never,
        now: () => new Date("2026-10-14T09:00:00.000Z"),
      },
    );
    expect(r.ok).toBe(true);
    const prompt = grounded.mock.calls[0]![0];
    expect(prompt).toContain("1. Pulse — /pulse");
    expect(prompt).not.toContain("elsewhere.example");
    expect(prompt).toContain("UNTRUSTED DATA");
    expect(r.ok && r.items.some((i) => i.change.type === "add_profile" && i.change.url === "https://x.com/acme_example")).toBe(true);
  });

  it("refuses without a model, and with nothing to read", async () => {
    const ctx = { tenantId: "ten_acme", region: "us", source: "idtoken" } as const;
    const current = BrandMapDecidedSchema.parse({});
    expect(await proposeBrandMap(ctx, { current }, { modelReady: () => false })).toEqual({ ok: false, status: 503, error: "no_model" });
    const nothing = await proposeBrandMap(ctx, { current }, {
      modelReady: () => true,
      retrieve: (async () => null) as never,
      sitePages: async () => ({ pages: [], repoPaths: [] }),
      fetchHome: async () => null,
      plans: (async () => []) as never,
    });
    expect(nothing).toEqual({ ok: false, status: 409, error: "nothing_to_read" });
  });

  it("says when research came back with nothing usable", async () => {
    const r = await proposeBrandMap(
      { tenantId: "ten_acme", region: "us", source: "idtoken" },
      { current: BrandMapDecidedSchema.parse({}) },
      {
        grounded: (async () => ({ text: "I could not find anything.", model: "m", sources: [], supports: [] })) as never,
        modelReady: () => true,
        retrieve: (async () => ({ formatted: "Acme.", chunks: [] })) as never,
        sitePages: async () => ({ pages: [], repoPaths: [] }),
        fetchHome: async () => null,
        plans: (async () => []) as never,
      },
    );
    expect(r).toEqual({ ok: false, status: 502, error: "research_failed" });
  });
});
