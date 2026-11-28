import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()), getDb: () => store.db }));

const { readBrandStubs } = await import("@/lib/search/feeders");
const { raiseDocSource, raiseDocStub } = await import("./search");
const { createRaiseDoc, listDecksForSearch } = await import("./store");
const { ACME, NOW, block, preSeedSlides } = await import("./testing/fixtures");

let db: FakeFirestore;
beforeEach(() => {
  db = new FakeFirestore();
  store.db = db;
});
afterEach(() => vi.unstubAllEnvs());

function deck() {
  const slides = preSeedSlides();
  slides[3] = { ...slides[3]!, section: "traction", headline: "{{mb_aaaaaaaa}} joined the waitlist in {{mb_aaaaaaaa:period}}", blocks: [block()], notes: "Every one of them came from shops." };
  return { id: "rd_aaaaaaaaaaaa", version: 3, current: { title: "Acme pre-seed", slides } };
}

describe("decks in brand search", () => {
  it("index one part per slide, titled by its place, with the frozen numbers rendered", () => {
    const src = raiseDocSource(deck(), NOW);
    expect(src).toMatchObject({ kind: "raise_doc", ref: "rd_aaaaaaaaaaaa", title: "Acme pre-seed", body: "", url: "/admin/raise/rd_aaaaaaaaaaaa" });
    expect(src.parts).toHaveLength(10);
    expect(src.parts![3]!.title).toBe("Slide 4: 4,310 joined the waitlist in 12 weeks to 26 Nov");
    expect(src.parts![3]!.text).toContain("Sign-ups to your launches: 4,310, 12 weeks to 26 Nov (Seen by YouGrow, 26 Nov)");
    expect(src.parts![3]!.text).toContain("Every one of them came from shops.");
    expect(src.parts![3]!.url).toBe("/admin/raise/rd_aaaaaaaaaaaa?slide=4");
  });

  it("give the sweep a version that moves with every save", () => {
    const d = deck();
    expect(raiseDocStub(d).version).not.toBe(raiseDocStub({ ...d, version: 4 }).version);
    expect(raiseDocStub(d).version).toBe(raiseDocStub(deck()).version);
  });

  it("are fed through the projection while the kit is on, and none while it is off", async () => {
    const made = await createRaiseDoc(ACME, { audience: "investor", stage: "pre_seed", title: "Acme pre-seed", slides: deck().current.slides, sources: [], outline: "investor_pre_seed", by: "vizzy", note: "First draft by Vizzy." }, { db });
    expect(made.ok).toBe(true);
    const rows = await listDecksForSearch(ACME, { db });
    expect(rows.map((r) => Object.keys(r).sort())).toEqual([["current", "id", "version"]]);

    const kinds = new Set(["raise_doc"] as const);
    const off = await readBrandStubs(ACME, { kinds });
    expect(off.stubs).toEqual([]);
    // Read in full with none listed, so the sweep removes any deck indexed before.
    expect(off.complete.has("raise_doc")).toBe(true);

    vi.stubEnv("RAISE_KIT_ENABLED", "true");
    const on = await readBrandStubs(ACME, { kinds });
    expect(on.stubs.map((s) => `${s.kind}:${s.ref}`)).toEqual([`raise_doc:${made.ok ? made.value.id : ""}`]);
    const source = await on.stubs[0]!.load();
    expect(source!.parts![3]!.title).toBe("Slide 4: 4,310 joined the waitlist in 12 weeks to 26 Nov");
  });
});
