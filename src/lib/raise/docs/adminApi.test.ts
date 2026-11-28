import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);

const { byLabel, deckView, raiseAdmin, raiseReader, slidesFromInput } = await import("./adminApi");
const { metricReader } = await import("./metrics");
const { createRaiseDoc, saveRaiseVersion } = await import("./store");
const { ACME, ACME_MEMBER, NOW, block, preSeedSlides, weeksOf } = await import("./testing/fixtures");
type RaiseDoc = import("./types").RaiseDoc;

const req = (headers: Record<string, string> = {}) => new Request("http://localhost/api/admin/raise/docs", { headers });
const theme = { loadTenant: async () => null, logos: async () => [], fonts: async () => [] };
const metrics = { now: () => NOW, weekly: async () => weeksOf(Array(12).fill(2)), launches: async () => null };

let db: FakeFirestore;
beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  vi.stubEnv("RAISE_KIT_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(ACME);
});
afterEach(() => vi.unstubAllEnvs());

async function deck(): Promise<RaiseDoc> {
  const slides = preSeedSlides();
  slides[3] = { ...slides[3]!, section: "traction", headline: "{{mb_aaaaaaaa}} joined in twelve weeks", blocks: [block({ value: 8, display: "8" })], needs: [{ id: "nd_aaaaaaaa", text: "a number that shows demand" }] };
  slides[3]!.ai = { headline: slides[3]!.headline, points: [], notes: "", at: NOW.toISOString(), prompt: "raise.deck_draft@1" };
  const r = await createRaiseDoc(ACME, { audience: "investor", stage: "pre_seed", title: "Acme pre-seed", slides, sources: [{ id: "P1", text: "Acme counts stock.", label: "brand_map" }], outline: "investor_pre_seed", by: "vizzy", note: "First draft by Vizzy." }, { db, now: () => NOW });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe("the Raise kit's gates", () => {
  it("check the origin, then the switch, then sign-in, then the role", async () => {
    expect((await raiseReader(req({ "sec-fetch-site": "cross-site" }))).ok).toBe(false);
    expect(session.getAdminContext).not.toHaveBeenCalled();
    vi.stubEnv("RAISE_KIT_ENABLED", "false");
    const off = await raiseAdmin(req());
    expect(off.ok ? 0 : off.response.status).toBe(503);
    expect(off.ok ? null : await off.response.json()).toEqual({ error: "raise_kit_disabled" });
    expect(session.getAdminContext).not.toHaveBeenCalled();
    vi.stubEnv("RAISE_KIT_ENABLED", "true");
    session.getAdminContext.mockResolvedValue(null);
    const out = await raiseReader(req());
    expect(out.ok ? 0 : out.response.status).toBe(401);
    session.getAdminContext.mockResolvedValue(ACME_MEMBER);
    expect((await raiseReader(req())).ok).toBe(true);
    const member = await raiseAdmin(req());
    expect(member.ok ? 0 : member.response.status).toBe(403);
    expect(member.ok ? "" : member.response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the deck view", () => {
  it("carries checks, talk time, Needs, every version with who made it, and the meanings of its numbers", async () => {
    const doc = await deck();
    const edited = doc.current.slides.map((s, i) => (i === 1 ? { ...s, notes: "Stock day takes a whole Sunday for most shop owners we met." } : s));
    const saved = await saveRaiseVersion(ACME, doc.id, { baseVersion: 1, slides: edited, by: "usr_admin" }, { db });
    if (!saved.ok) throw new Error(saved.error);
    const view = await deckView(ACME, saved.value.doc, { db, theme, metrics, granted: async () => true });
    expect(view).toMatchObject({ id: doc.id, kindLabel: "Investor deck, pre-seed", version: 2, needs: 1, canEdit: true, canDraft: false });
    expect(view.versions).toEqual([
      { n: 2, note: "Changed slide 2 notes.", by: "You", at: expect.any(String), kept: true },
      { n: 1, note: "First draft by Vizzy.", by: "Vizzy", at: NOW.toISOString(), kept: true },
    ]);
    expect(view.talk.perSlide[1]).toEqual({ slideId: edited[1]!.id, words: 12, talkSeconds: 5 });
    expect(Object.keys(view.meanings).sort()).toEqual(["talkSeconds", "waitlistSignups"]);
    expect(view.numberOptions.waitlist.hasData).toBe(true);
    expect(view.theme.accent).toBe("#2F5BEA");
    vi.stubEnv("VIZZY_RAISE_ENABLED", "true");
    expect((await deckView(ACME, saved.value.doc, { db, theme, metrics, granted: async () => true })).canDraft).toBe(true);
    expect((await deckView(ACME, saved.value.doc, { db, theme, metrics, granted: async () => false })).canDraft).toBe(false);
    expect((await deckView(ACME_MEMBER, saved.value.doc, { db, theme, metrics, granted: async () => true })).canDraft).toBe(false);
    expect(byLabel("usr_admin", ACME_MEMBER)).toBe("A teammate");
  });
});

describe("a person's slides", () => {
  it("keep a stored server number frozen, fill a new one, and restamp a typed one only when it changed", async () => {
    const doc = await deck();
    const reader = metricReader(ACME, { ...metrics, weekly: async () => weeksOf(Array(12).fill(5)) });
    const input = doc.current.slides.map((s) => ({ ...s, blocks: s.blocks.map((b) => ({ id: b.id, meaning: b.meaning as "waitlistSignups", grain: "total" as const, weeks: 12 as const })) }));
    input[5] = {
      ...input[5]!,
      headline: "{{mb_newnew01}} and {{mb_gonegone}} in the market",
      blocks: [
        { meaning: "signupGrowth", grain: "total" } as never,
        { id: "mb_newnew01", meaning: "typed", name: "Shops in the UK", value: 200000, unit: "count", from: "a trade body" } as never,
      ],
      sources: ["P1", "P7"],
    };
    const slides = await slidesFromInput({ ...ACME, userId: "usr_admin" }, doc, input as never, reader);
    expect(slides[3]!.blocks[0]).toEqual(doc.current.slides[3]!.blocks[0]);
    expect(slides[3]!.ai).toBeUndefined();
    const [growth, typed] = slides[5]!.blocks;
    expect(growth).toMatchObject({ meaning: "signupGrowth", value: 0, asOf: NOW.toISOString() });
    expect(typed).toMatchObject({ id: "mb_newnew01", display: "200,000", source: { kind: "typed", from: "a trade body", typedBy: "usr_admin" } });
    // A token for a block the slide no longer has goes.
    expect(slides[5]!.headline).toBe("{{mb_newnew01}} and in the market");
    expect(slides[5]!.sources).toEqual(["P1"]);

    const stored = { ...doc, current: { ...doc.current, slides } };
    const again = await slidesFromInput({ ...ACME_MEMBER, userId: "usr_other" }, stored, input as never, metricReader(ACME, { ...metrics, now: () => new Date("2026-12-01T00:00:00Z") }));
    expect(again[5]!.blocks[1]).toEqual(typed);
    const changed = structuredClone(input) as typeof input;
    (changed[5]!.blocks[1] as unknown as { value: number }).value = 210000;
    const restamped = await slidesFromInput({ ...ACME, userId: "usr_other" }, stored, changed as never, reader);
    expect(restamped[5]!.blocks[1]).toMatchObject({ value: 210000, source: { typedBy: "usr_other" } });
  });
});
