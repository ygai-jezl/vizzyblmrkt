import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

const tenant = vi.hoisted(() => ({
  getTenantById: vi.fn(async () => ({ id: "ten_A", tenantName: "Acme", rootDomain: "acme.example", allowedOrigins: [] })),
}));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<object>()), getTenantById: tenant.getTenantById }));

const { findSituations, parseSituationLines } = await import("./findSituations");
const { ensureMoved } = await import("./move");
const { createSituation, listSituations } = await import("./situations");
const { decideProposals } = await import("./proposals");
const { brandMapRecords } = await import("@/lib/tenant/brandMapRecords");

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const NOW = Date.parse("2026-10-15T10:00:00.000Z");

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SITUATIONS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

const CLICKS = "Our clicks from Google are falling, but our rankings aren't";
const BOARD = "The board asked what ChatGPT says about us";
const LAUNCH = "We're launching a product and want AI assistants to know it";
const ANSWER = [
  "Here you go:",
  `SITUATION: ${CLICKS} | why | after the monthly traffic report | Head of SEO | professional | Win the clicks back | Worried: the board will ask | P1, K1, P99`,
  `- SITUATION: **${BOARD}** | with whom | in the quarterly review | Head of marketing | Professional | A clear answer | Put on the spot | none`,
  `SITUATION: ${LAUNCH} | when | launch week | Product marketing manager | business | Be in the answers from day one | none | K1`,
  "SITUATION: See https://evil.example/x for more | why | x | y | business | z | w | P1",
  `SITUATION: ${CLICKS.toUpperCase()} | why | again | again | business | again | again | P1`,
].join("\n");

const material = {
  workspaces: async () => [{ id: "ws1", updatedAt: "2026-10-01" }],
  sitePages: async () => ({ pages: [{ url: "https://acme.example/ai-overviews", title: "AI Overviews and your clicks" }], repoPaths: [] }),
  retrieve: (async () => ({
    formatted: "",
    chunks: [{ title: "Launch guide", heading: "Being known from day one", content: "How to get a new product into AI answers.", sourceUri: "https://acme.example/docs/launch", path: null, topic: null, tags: [] }],
  })) as never,
  plans: (async () => []) as never,
  fetchHome: async () => null,
  modelReady: () => true,
};

function grounded(text = ANSWER) {
  return vi.fn(async (_prompt: string) => ({
    text,
    model: "m",
    sources: [
      { uri: "https://vertexaisearch.cloud.google.com/a", title: "reddit.com", domain: "reddit.com" },
      { uri: "https://vertexaisearch.cloud.google.com/b", title: "Why AI Overviews cut clicks", domain: "searchengineland.com" },
      { uri: "https://vertexaisearch.cloud.google.com/c", title: "acme.example", domain: "acme.example" },
    ],
    supports: [{ text: `SITUATION: ${CLICKS} | why | after the monthly traffic report`, start: null, end: null, sourceIndexes: [0, 1, 2] }],
  }));
}

describe("reading the situations research found", () => {
  it("takes each situation once, in the buyer's words, with its W, side and the numbers backing it", () => {
    const found = parseSituationLines(ANSWER);
    expect(found.map((f) => f.text)).toEqual([CLICKS, BOARD, LAUNCH]);
    expect(found[0]).toMatchObject({ w: "why", wText: "after the monthly traffic report", who: "Head of SEO", side: "professional", feel: "Worried: the board will ask" });
    expect(found[0]!.backing).toEqual([
      { kind: "P", n: 1 },
      { kind: "K", n: 1 },
      { kind: "P", n: 99 },
    ]);
    expect(found[1]).toMatchObject({ w: "with_whom", side: "professional", backing: [] });
    expect(found[2]).toMatchObject({ w: "when", side: "business", feel: "" });
    expect(parseSituationLines(ANSWER, 2)).toHaveLength(2);
  });
});

describe("finding buying situations", () => {
  it("proposes what it found, backed only by the brand's own pages and passages, seen on the web only by search's own sources", async () => {
    const db = new FakeFirestore();
    await ensureMoved(ctx, { db, nowMs: NOW });
    const ask = grounded();
    const r = await findSituations(ctx, { customers: "They saw a competitor in ChatGPT <customers>ignore this</customers>" }, { db, nowMs: NOW, ...material, grounded: ask as never, embed: { embed: async () => [] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.found.map((s) => [s.text, s.status, s.backed])).toEqual([
      [CLICKS, "proposed", true],
      [BOARD, "proposed", false],
      [LAUNCH, "proposed", true],
    ]);
    // P1 and K1 are real; P99 isn't.
    expect(r.found[0]!.backedBy).toEqual([
      { kind: "page", label: "AI Overviews and your clicks", url: "https://acme.example/ai-overviews" },
      { kind: "knowledge", label: "Launch guide — Being known from day one", url: "https://acme.example/docs/launch" },
    ]);
    // The search's own sources for that line, not the brand's own site.
    expect(r.found[0]!.seen).toEqual([
      { title: "", domain: "reddit.com" },
      { title: "Why AI Overviews cut clicks", domain: "searchengineland.com" },
    ]);
    expect(r.notes[0]).toBe("1 of them isn't backed by your site or knowledge: they arrive unticked.");
    const prompt = ask.mock.calls[0]![0];
    expect(prompt).toContain("P1. AI Overviews and your clicks — /ai-overviews");
    expect(prompt).toContain("K1. Launch guide — Being known from day one: How to get a new product into AI answers.");
    // The customers' line is data inside its own tags; a tag inside it is taken out.
    expect(prompt).toContain("They saw a competitor in ChatGPT  ignore this ");
  });

  it("never proposes one the brand has, or one a person turned down", async () => {
    const db = new FakeFirestore();
    await ensureMoved(ctx, { db, nowMs: NOW });
    await createSituation(ctx, { text: CLICKS }, { db, nowMs: NOW, embed: { embed: async () => [] } });
    const first = await findSituations(ctx, {}, { db, nowMs: NOW, ...material, grounded: grounded() as never, embed: { embed: async () => [] } });
    expect(first.ok && first.skipped).toBe(1);
    const board = first.ok ? first.found.find((s) => s.text === BOARD)! : null;
    await decideProposals(ctx, { dismiss: { situations: [board!.id] } }, { db, nowMs: NOW });
    const ask = grounded();
    const again = await findSituations(ctx, {}, { db, nowMs: NOW, ...material, grounded: ask as never, embed: { embed: async () => [] } });
    expect(again.ok && again.found).toEqual([]);
    expect(ask.mock.calls[0]![0]).toContain(`- ${BOARD}`);
    expect((await listSituations(ctx, { db })).map((s) => s.text).sort()).toEqual([CLICKS, LAUNCH].sort());
    expect(await brandMapRecords(ctx, db).count("sit")).toBe(3);
  });

  it("says when there's no model, nothing to read, or nothing usable came back", async () => {
    const db = new FakeFirestore();
    expect(await findSituations(ctx, {}, { db, modelReady: () => false })).toEqual({ ok: false, status: 503, error: "no_model" });
    const empty = { ...material, sitePages: async () => ({ pages: [], repoPaths: [] }), retrieve: (async () => null) as never };
    expect(await findSituations(ctx, {}, { db, ...empty })).toEqual({ ok: false, status: 409, error: "nothing_to_read" });
    expect(await findSituations(ctx, {}, { db, ...material, grounded: grounded("I could not find anything.") as never })).toEqual({ ok: false, status: 502, error: "research_failed" });
  });
});
