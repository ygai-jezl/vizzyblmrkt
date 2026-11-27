import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { createRaiseDoc, readRaiseDoc } from "@/lib/raise/docs/store";
import { ACME, ACME_MEMBER, FERNHILL, NOW, block, preSeedSlides, weeksOf } from "@/lib/raise/docs/testing/fixtures";
import type { RaiseDoc } from "@/lib/raise/docs/types";
import type { TenantContext } from "@/lib/tenant/types";
import { authorRaiseDeck, type RaiseDeckDeps } from "./raiseDeck";
import { getCanvasKind } from "../registry";

let db: FakeFirestore;
let generate: ReturnType<typeof vi.fn>;
let granted: boolean;
let limited: Array<string>;
let over: string | null;

const sections = ["cover", "problem", "solution", "traction", "why_now", "market", "competition", "business_model", "team", "ask"];
const answer = () => ({
  title: "Acme pre-seed",
  slides: sections.map((section) => ({
    section,
    layout: section === "traction" ? "chart" : "statement",
    headline: section === "cover" ? "Acme" : `Acme helps small shops with ${section.replace(/_/g, " ")} every week`,
    points: [],
    notes: "Shop owners told us stock day takes a whole Sunday.",
    blocks: [],
    needs: [],
    sources: [],
  })),
});

const metrics = { weekly: async () => weeksOf([300, 310, 320, 330, 340, 350, 360, 370, 380, 390, 400, 660]), launches: async () => null };
const pack = {
  brandMap: async () => null,
  situations: async () => [],
  strategy: async () => null,
  competitors: async () => [],
  site: async () => [],
  repo: async () => [],
  authors: async () => [],
  facts: async () => [],
};
function deps(): RaiseDeckDeps {
  return {
    db,
    now: () => NOW,
    granted: async () => granted,
    limited: async (_ctx, limit) => (limited.push(limit.prefix), limit.prefix === over),
    draft: { generate: generate as never, loadTenant: async () => null, metrics, pack },
    revise: { generate: generate as never, loadTenant: async () => null, metrics, pack },
  };
}
const author = (input: Record<string, unknown>, ctx: TenantContext = ACME, brief = "") =>
  authorRaiseDeck({ ctx, input: { kind: "raise_deck", action: "save_draft", ...input }, brief }, deps());

/** A saved deck whose traction slide shows 4,310 sign-ups, frozen. */
async function deck(ctx: TenantContext = ACME): Promise<RaiseDoc> {
  const slides = preSeedSlides();
  slides[3] = { ...slides[3]!, layout: "chart", headline: "{{mb_aaaaaaaa}} sign-ups", blocks: [block()] };
  const r = await createRaiseDoc(ctx, { audience: "investor", stage: "pre_seed", title: "Acme pre-seed", slides, sources: [], outline: "investor_pre_seed", by: "vizzy", note: "First draft by Vizzy." }, { db, now: () => NOW });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

beforeEach(() => {
  db = new FakeFirestore();
  granted = true;
  limited = [];
  over = null;
  generate = vi.fn(async () => JSON.stringify(answer()));
  vi.stubEnv("RAISE_KIT_ENABLED", "true");
  vi.stubEnv("VIZZY_RAISE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("the raise_deck kind", () => {
  it("is registered", () => {
    expect(getCanvasKind("raise_deck")?.label).toBe("Deck or lender pack");
  });

  it("answers unavailable while off, and is for admins only", async () => {
    vi.stubEnv("VIZZY_RAISE_ENABLED", "false");
    expect(await author({ mode: "draft", audience: "investor" })).toMatchObject({ ok: false, status: 503, error: "unavailable" });
    vi.stubEnv("VIZZY_RAISE_ENABLED", "true");
    vi.stubEnv("RAISE_KIT_ENABLED", "false");
    expect(await author({ mode: "draft", audience: "investor" })).toMatchObject({ ok: false, status: 503 });
    vi.stubEnv("RAISE_KIT_ENABLED", "true");
    expect(await author({ mode: "draft", audience: "investor" }, ACME_MEMBER)).toMatchObject({ ok: false, status: 403, error: "forbidden" });
    expect(await author({ mode: "draft", audience: "investor" }, { ...ACME, role: undefined })).toMatchObject({ ok: false, status: 403 });
    expect(generate).not.toHaveBeenCalled();
  });

  it("checks the request, then the plan, then the limits", async () => {
    expect(await author({ mode: "pitch" })).toMatchObject({ ok: false, status: 400, error: "invalid_input" });
    expect(await author({ mode: "draft" })).toMatchObject({ ok: false, status: 400, issues: ["audience: investor or lender"] });
    expect(await author({ mode: "revise" })).toMatchObject({ ok: false, status: 400 });
    granted = false;
    expect(await author({ mode: "draft", audience: "investor" })).toMatchObject({ ok: false, status: 403, error: "not_included" });
    expect(limited).toEqual([]);
    granted = true;
    over = "raise_draft";
    expect(await author({ mode: "draft", audience: "investor" })).toMatchObject({ ok: false, status: 429, error: "rate_limited" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("drafts a deck as version 1 by Vizzy and returns its card", async () => {
    const r = await author({ mode: "draft", audience: "investor", stage: "pre_seed" }, ACME, "For a pre-seed round of £250,000");
    if (!r.ok) throw new Error(r.error);
    expect(r).toMatchObject({ status: "draft", url: `/admin/raise/${r.id}` });
    expect(r.card).toEqual({
      kind: "raise_deck",
      id: r.id,
      title: "Acme pre-seed",
      subtitle: "Investor deck, pre-seed",
      url: `/admin/raise/${r.id}`,
      stats: [
        { label: "slides", value: 10 },
        { label: "version", value: 1 },
        { label: "needs", value: 5 },
      ],
      warnings: expect.any(Number),
      note: "A draft. Nothing is sent or shared.",
      cta: "Open deck",
    });
    // With nothing in the pack, each slide says what it still needs.
    expect(r.summary).toMatch(
      /^Saved a first draft of 10 slides as version 1 \(Investor deck, pre-seed\)\. 5 slides still need something: what your website says you do, how many could buy, who you compete with, team bios, how much you're raising\./,
    );
    expect(r.summary).toMatch(/It's a draft: nothing is sent or shared\.$/);
    // The person's words go to the model fenced as the brief.
    expect(generate.mock.calls[0]![0]).toContain("For a pre-seed round of £250,000");
    const doc = await readRaiseDoc(ACME, r.id, { db });
    expect(doc?.versions[0]).toMatchObject({ n: 1, by: "vizzy" });
    expect(limited).toEqual(["raise_draft"]);
  });

  it("makes a lender pack for a shop, with no stage of its own", async () => {
    generate.mockResolvedValue(null);
    const r = await author({ mode: "draft", audience: "lender", stage: "seed", title: "Fernhill stock loan" }, FERNHILL);
    if (!r.ok) throw new Error(r.error);
    expect(r.card).toMatchObject({ title: "Fernhill stock loan", subtitle: "Lender pack", stats: [{ label: "slides", value: 5 }, { label: "version", value: 1 }, { label: "needs", value: 5 }] });
    expect(r.summary).toContain("I couldn't write the words just now");
  });

  it("stops at 20 decks", async () => {
    for (let i = 0; i < 20; i += 1) await deck();
    expect(await author({ mode: "draft", audience: "investor" })).toMatchObject({ ok: false, status: 409, error: "deck_limit" });
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("revising a deck from chat", () => {
  it("changes the deck in view by slide number, one new version per call, and says what changed", async () => {
    const doc = await deck();
    const ids = doc.current.slides.map((s) => s.id);
    const r = await author({ mode: "revise", scope: { kind: "raise_deck", docId: doc.id }, baseVersion: 1, note: "Moved why now up.", ops: [{ change: "move", slide: 5, to: 2 }] });
    if (!r.ok) throw new Error(r.error);
    expect(r.card).toMatchObject({ id: doc.id, stats: [{ label: "slides", value: 10 }, { label: "version", value: 2 }, { label: "needs", value: 0 }] });
    expect(r.summary).toMatch(/^Saved version 2\. Moved why now up\. No slide is waiting on anything\./);
    const saved = await readRaiseDoc(ACME, doc.id, { db });
    expect(saved?.current.slides.map((s) => s.id).slice(0, 3)).toEqual([ids[0], ids[4], ids[1]]);
    expect(saved?.changes.map((c) => [c.n, c.by])).toEqual([
      [2, "vizzy"],
      [1, "vizzy"],
    ]);
    expect(limited).toEqual(["raise_revise"]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("uses the newest deck when none is named, and 404s when there is none or it is another brand's", async () => {
    expect(await author({ mode: "revise", ops: [{ change: "remove", slide: 2 }] })).toMatchObject({ ok: false, status: 404, error: "doc_not_found" });
    const theirs = await deck(FERNHILL);
    expect(await author({ mode: "revise", scope: { docId: theirs.id }, ops: [{ change: "remove", slide: 2 }] })).toMatchObject({ ok: false, status: 404 });
    const ours = await deck();
    const r = await author({ mode: "revise", ops: [{ change: "remove", slide: 2 }] });
    expect(r).toMatchObject({ ok: true, id: ours.id });
  });

  it("refuses a stale base, a bad change and a number the person didn't say", async () => {
    const doc = await deck();
    await author({ mode: "revise", scope: { docId: doc.id }, baseVersion: 1, ops: [{ change: "remove", slide: 2 }] });
    expect(await author({ mode: "revise", scope: { docId: doc.id }, baseVersion: 1, ops: [{ change: "remove", slide: 2 }] })).toMatchObject({ ok: false, status: 409, error: "stale_version" });
    expect(await author({ mode: "revise", scope: { docId: doc.id }, ops: [{ change: "layout", slide: 2, layout: "poster" }] })).toMatchObject({ ok: false, status: 422, error: "invalid_ops" });
    expect(await author({ mode: "revise", scope: { docId: doc.id }, ops: [{ change: "remove", slide: 40 }] })).toMatchObject({ ok: false, status: 422, issues: ["ops.0: there is no slide 40, the deck has 9"] });
    const typed = { change: "typed_number", slide: 3, name: "Monthly sales", value: 6200, unit: "money", currency: "USD", per: "month" };
    expect(await author({ mode: "revise", scope: { docId: doc.id }, ops: [{ ...typed, quote: "about six grand a month" }] })).toMatchObject({ ok: false, status: 422, error: "quote_mismatch" });
    const r = await author({ mode: "revise", scope: { docId: doc.id }, ops: [{ ...typed, quote: "our MRR is $6,200" }] });
    if (!r.ok) throw new Error(r.error);
    const after = await readRaiseDoc(ACME, doc.id, { db });
    expect(after?.version).toBe(3);
    // Slide 3 of the version read is traction, which keeps its own number beside the new one.
    expect(after?.current.slides[2]!.blocks.map((b) => b.display)).toEqual(["4,310", "$6,200 a month"]);
    expect(after?.current.slides[2]!.blocks[1]).toMatchObject({ display: "$6,200 a month", source: { kind: "typed", saidInChat: true, quote: "our MRR is $6,200" } });
  });

  it("never changes a server block's value, except on a refresh", async () => {
    const doc = await deck();
    generate.mockResolvedValue(JSON.stringify({ slides: [{ task: "T1", headline: "{{mb_aaaaaaaa}} shops joined, and more each week", notes: "Shops keep joining." }] }));
    const r = await author({ mode: "revise", scope: { docId: doc.id }, ops: [{ change: "rewrite", slide: 4, ask: "Lead with the growth" }, { change: "move", slide: 4, to: 2 }] });
    if (!r.ok) throw new Error(r.error);
    const moved = await readRaiseDoc(ACME, doc.id, { db });
    expect(moved?.version).toBe(2);
    expect(moved?.current.slides[1]!.blocks).toEqual([block()]);
    expect(generate).toHaveBeenCalledTimes(1);

    const refreshed = await author({ mode: "revise", scope: { docId: doc.id }, ops: [{ change: "refresh_numbers" }] });
    if (!refreshed.ok) throw new Error(refreshed.error);
    expect(refreshed.summary).toMatch(/^Saved version 3\. Numbers refreshed: slide 2 sign-ups 4,310 to 4,510\./);
    expect(limited.at(-1)).toBe("raise_numbers");
    const again = await author({ mode: "revise", scope: { docId: doc.id }, ops: [{ change: "refresh_numbers" }] });
    expect(again).toMatchObject({ ok: true, summary: "Every number is up to date, so no new version was saved." });
    expect((await readRaiseDoc(ACME, doc.id, { db }))?.version).toBe(3);
  });
});
