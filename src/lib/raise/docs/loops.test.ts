import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { loopWeekOf } from "@/lib/loops/count";
import { sumWeek } from "@/lib/loops/testing/sumWeek";
import { draftDeck, type DraftDeps } from "./draft";
import { reviseDeck, type ReviseDeps } from "./revise";
import { createRaiseDoc } from "./store";
import { ACME, NOW, block, preSeedSlides, weeksOf } from "./testing/fixtures";
import type { RaiseDoc } from "./types";

/**
 * Decks under the learning loops (LOOPS_ENABLED, learning loops step 5): the words the model writes
 * on a deck are raise_write's, read where the deck or its version is saved. A draft with the
 * model's words counts made once, by Vizzy when the chat asked for it; an outline saved without
 * them counts none. A revise counts made once for a version with the model's words, and nothing for
 * a change made in code or a version saved over nothing. The deck keeps no stamp of its own, and
 * nothing answers it yet (UNANSWERED). With the switch off nothing is counted. Acme is made up.
 */

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

let db: FakeFirestore;
let generate: ReturnType<typeof vi.fn>;
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
const metrics = { weekly: async () => weeksOf([300, 310, 320, 330, 340, 350, 360, 370, 380, 390, 400, 660]), launches: async () => null };
const deps = (): DraftDeps & ReviseDeps => ({ db, now: () => NOW, generate: generate as never, loadTenant: async () => null, metrics, pack });

/** This brand's week under raise_write: made against the stamp, why none, and made by type. */
function counted() {
  const week = sumWeek(db, ACME.tenantId, loopWeekOf(NOW)) as { c?: Record<string, unknown>; u?: Record<string, unknown>; t?: Record<string, unknown> };
  return { stamped: week.c?.raise_write, unstamped: week.u?.raise_write, type: week.t?.raise_doc };
}

/** A saved deck whose traction slide shows 4,310 sign-ups, frozen. */
async function deck(): Promise<RaiseDoc> {
  const slides = preSeedSlides();
  slides[3] = { ...slides[3]!, layout: "chart", headline: "{{mb_aaaaaaaa}} sign-ups", blocks: [block()] };
  const r = await createRaiseDoc(ACME, { audience: "investor", stage: "pre_seed", title: "Acme pre-seed", slides, sources: [], outline: "investor_pre_seed", by: "vizzy", note: "First draft by Vizzy." }, { db, now: () => NOW });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

beforeEach(() => {
  db = new FakeFirestore();
  generate = vi.fn(async () => JSON.stringify(answer()));
});
afterEach(() => vi.unstubAllEnvs());

describe("decks with the learning loops on", () => {
  beforeEach(() => vi.stubEnv("LOOPS_ENABLED", "true"));

  it("counts a deck the chat asked for made once under raise_write, by Vizzy, and keeps no stamp on it", async () => {
    const r = await draftDeck(ACME, { audience: "investor", stage: "pre_seed", by: "vizzy" }, deps());
    if (!r.ok) throw new Error(r.error);
    expect(counted()).toEqual({ stamped: { raise_write: { v0: { none: { made: 1 } } } }, unstamped: undefined, type: { made: 1 } });
    // The deck's own made names the prompt, as before: no loop stamp joins it.
    expect(r.value.doc.made).toEqual({ promptId: "raise.deck_draft", version: 2, model: expect.any(String) });
  });

  it("counts a deck a person drafted on the page made once too, and an outline saved without the model's words none", async () => {
    const mine = await draftDeck(ACME, { audience: "investor", stage: "pre_seed", by: "usr_admin" }, deps());
    expect(mine.ok).toBe(true);
    expect(counted().stamped).toEqual({ raise_write: { v0: { none: { made: 1 } } } });
    generate.mockResolvedValue(null);
    const outline = await draftDeck(ACME, { audience: "lender", by: "usr_admin" }, deps());
    if (!outline.ok) throw new Error(outline.error);
    expect(outline.value.drafted).toBe(false);
    expect(counted().stamped).toEqual({ raise_write: { v0: { none: { made: 1 } } } });
  });

  it("counts a revise made once for a version with the model's words, and nothing for a change in code or nothing saved", async () => {
    const doc = await deck();
    const moved = await reviseDeck(ACME, doc, { ops: [{ change: "move", slide: 5, to: 2 }], baseVersion: 1 }, deps());
    if (!moved.ok) throw new Error(moved.error);
    expect(counted().stamped).toBeUndefined();
    generate.mockResolvedValue(JSON.stringify({ slides: [{ task: "T1", headline: "{{mb_aaaaaaaa}} shops joined, and more each week", notes: "Shops keep joining." }] }));
    const rewritten = await reviseDeck(ACME, moved.value.doc, { ops: [{ change: "rewrite", slide: 2, ask: "Lead with the growth" }], baseVersion: 2 }, deps());
    if (!rewritten.ok) throw new Error(rewritten.error);
    expect(rewritten.value.saved).toBe(true);
    expect(counted()).toEqual({ stamped: { raise_write: { v0: { none: { made: 1 } } } }, unstamped: undefined, type: { made: 1 } });
    // The model answered for no task: the version holds none of the model's words, so nothing more is made.
    generate.mockResolvedValue(JSON.stringify({ slides: [] }));
    const empty = await reviseDeck(ACME, rewritten.value.doc, { ops: [{ change: "notes", slide: 2, ask: "Shorter" }], baseVersion: 3 }, deps());
    if (!empty.ok) throw new Error(empty.error);
    expect(empty.value.saved).toBe(false);
    expect(counted().stamped).toEqual({ raise_write: { v0: { none: { made: 1 } } } });
  });
});

describe("decks with the learning loops off (decision 22)", () => {
  it("count nothing, drafted or revised", async () => {
    const r = await draftDeck(ACME, { audience: "investor", stage: "pre_seed", by: "vizzy" }, deps());
    if (!r.ok) throw new Error(r.error);
    generate.mockResolvedValue(JSON.stringify({ slides: [{ task: "T1", headline: "Acme saves shops a Sunday every week", notes: "Shops keep joining." }] }));
    const revised = await reviseDeck(ACME, r.value.doc, { ops: [{ change: "rewrite", slide: 2, ask: "Shorter" }], baseVersion: 1 }, deps());
    expect(revised.ok).toBe(true);
    expect(db.dump("loop_days")).toEqual([]);
  });
});
