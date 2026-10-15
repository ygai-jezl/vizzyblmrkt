import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { BrandMapChangeSchema, brandMapDocId, type BrandMapChange } from "@/lib/types/brandMap";
import { changeKey } from "./changes";
import {
  decidedBrandMap,
  dismissBrandMapSuggestions,
  fileBrandMapSuggestions,
  mergeSuggestions,
  readBrandMap,
  saveBrandMap,
} from "./store";

const ctx: TenantContext = { tenantId: "ten_acme", region: "us", userId: "u1", email: "owner@acme.example", role: "admin", source: "idtoken" };
const change = (c: unknown): BrandMapChange => BrandMapChangeSchema.parse(c);
const T0 = Date.parse("2026-10-14T09:00:00.000Z");

beforeEach(() => vi.stubEnv("BRAND_MAP_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

const DECIDED = {
  identity: {
    name: "Acme",
    category: "AI visibility tracking",
    site: "https://acme.example",
    profiles: [{ url: "https://www.linkedin.com/company/acme-example", source: "site", confirmedAt: "2001-01-01" }],
  },
  subjects: [{ id: "sub_aaaaaaaa", name: "Share of voice", questions: [{ id: "q_aaaaaaaa", text: "What is share of voice?" }] }],
  names: [{ id: "n_aaaaaaaa", name: "Rivalco", kind: "alternative" }],
};

describe("the brand map store", () => {
  it("saves a first map at revision 1, stamping when each link was confirmed", async () => {
    const db = new FakeFirestore();
    expect((await readBrandMap(ctx, db)).state).toBe("none");
    const saved = await saveBrandMap(ctx, { baseRev: 0, decided: DECIDED, ownSites: ["acme.example"] }, { db, nowMs: T0 });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.rev).toBe(1);
    expect(saved.value.decidedBy).toBe("owner@acme.example");
    // The date the browser sent is ignored: the server says when it was confirmed.
    expect(saved.value.identity.profiles[0]!.confirmedAt).toBe("2026-10-14T09:00:00.000Z");
    expect((await decidedBrandMap(ctx, db))?.identity.name).toBe("Acme");
  });

  it("refuses a save over someone else's, with the map as it is now", async () => {
    const db = new FakeFirestore();
    await saveBrandMap(ctx, { baseRev: 0, decided: DECIDED }, { db, nowMs: T0 });
    await saveBrandMap(ctx, { baseRev: 1, decided: { ...DECIDED, identity: { ...DECIDED.identity, category: "AI search visibility" } } }, { db, nowMs: T0 + 1 });
    const stale = await saveBrandMap(ctx, { baseRev: 1, decided: DECIDED }, { db, nowMs: T0 + 2 });
    expect(stale).toMatchObject({ ok: false, status: 409, error: "map_changed" });
    expect(!stale.ok && stale.current?.identity.category).toBe("AI search visibility");
  });

  it("keeps the revision when nothing decided changed, and keeps a link's first confirmation", async () => {
    const db = new FakeFirestore();
    await saveBrandMap(ctx, { baseRev: 0, decided: DECIDED }, { db, nowMs: T0 });
    const again = await saveBrandMap(ctx, { baseRev: 1, decided: DECIDED }, { db, nowMs: T0 + 60_000 });
    expect(again.ok && again.value.rev).toBe(1);
    expect(again.ok && again.value.identity.profiles[0]!.confirmedAt).toBe("2026-10-14T09:00:00.000Z");
  });

  it("refuses a map that fails its checks, saying where", async () => {
    const db = new FakeFirestore();
    const bad = await saveBrandMap(
      ctx,
      { baseRev: 0, decided: { names: [{ id: "n_aaaaaaaa", name: "Acme Pulse", kind: "product", home: "https://elsewhere.example/p" }] }, ownSites: ["acme.example"] },
      { db, nowMs: T0 },
    );
    expect(bad).toMatchObject({ ok: false, status: 400, error: "invalid_map", issues: [{ path: "names.0.home" }] });
  });

  it("files suggestions without touching what is decided, and never moves the revision", async () => {
    const db = new FakeFirestore();
    await saveBrandMap(ctx, { baseRev: 0, decided: DECIDED }, { db, nowMs: T0 });
    const filed = await fileBrandMapSuggestions(
      ctx,
      {
        from: "article",
        items: [
          { change: change({ type: "add_name", name: "Peec", kind: "alternative" }), reason: "Named in an article" },
          { change: change({ type: "add_name", name: "rivalco", kind: "alternative" }) }, // already a name
        ],
      },
      { db, nowMs: T0 + 1 },
    );
    expect(filed.ok && filed.value.filed.map((s) => s.key)).toEqual(["name:peec"]);
    expect(filed.ok && filed.value.skipped).toEqual({ inMap: 1, waiting: 0, dismissed: 0 });
    const read = await readBrandMap(ctx, db);
    expect(read.state === "ok" && read.map.rev).toBe(1);
    expect(read.state === "ok" && read.map.names.map((n) => n.name)).toEqual(["Rivalco"]);
    // A person's save still goes through after the suggestion arrived.
    expect((await saveBrandMap(ctx, { baseRev: 1, decided: DECIDED }, { db, nowMs: T0 + 2 })).ok).toBe(true);
  });

  it("drops a suggestion once accepted, dismissed or made true by a save, and never files a dismissed one again", async () => {
    const db = new FakeFirestore();
    await fileBrandMapSuggestions(
      ctx,
      {
        from: "research",
        items: [
          { change: change({ type: "add_name", name: "Peec", kind: "alternative" }) },
          { change: change({ type: "add_is_not", text: "A general SEO suite" }), inferred: true },
          { change: change({ type: "add_subject", name: "Citation gaps" }) },
        ],
      },
      { db, nowMs: T0 },
    );
    const saved = await saveBrandMap(
      ctx,
      {
        baseRev: 0,
        decided: { ...DECIDED, names: [...DECIDED.names, { id: "n_bbbbbbbb", name: "Peec", kind: "alternative" }] },
        accepted: ["name:peec"],
        dismissed: ["isnot:a general seo suite"],
      },
      { db, nowMs: T0 + 1 },
    );
    expect(saved.ok && saved.value.suggestions.map((s) => s.key)).toEqual(["subject:citation gaps"]);
    const again = await fileBrandMapSuggestions(
      ctx,
      { from: "research", replaceOwn: true, items: [{ change: change({ type: "add_is_not", text: "a general SEO suite" }) }] },
      { db, nowMs: T0 + 2 },
    );
    expect(again.ok && again.value.skipped.dismissed).toBe(1);
    // Asked for outright, it is filed after all.
    const asked = await fileBrandMapSuggestions(
      ctx,
      { from: "vizzy", allowDismissed: true, items: [{ change: change({ type: "add_is_not", text: "A general SEO suite" }) }] },
      { db, nowMs: T0 + 3 },
    );
    expect(asked.ok && asked.value.filed).toHaveLength(1);
  });

  it("lets research replace its own rows only, and caps each source", () => {
    const base = { ...DECIDED, identity: { ...DECIDED.identity, isNot: [], avoid: [], categorySameAs: [], statement: "" } } as never;
    const vizzy = mergeSuggestions(
      { ...(base as object), suggestions: [], dismissed: [] } as never,
      { from: "vizzy", items: [{ change: change({ type: "add_subject", name: "Audits" }) }] },
      "t1",
    );
    const research = mergeSuggestions(
      { ...(base as object), suggestions: vizzy.suggestions, dismissed: [] } as never,
      {
        from: "research",
        replaceOwn: true,
        items: Array.from({ length: 105 }, (_, i) => ({ change: change({ type: "add_name", name: `Tool ${i}`, kind: "alternative" }) })),
      },
      "t2",
    );
    expect(research.suggestions.filter((s) => s.from === "research")).toHaveLength(100);
    expect(research.suggestions.filter((s) => s.from === "vizzy")).toHaveLength(1);
    // The oldest of research's own go first.
    expect(research.suggestions.some((s) => s.key === changeKey(change({ type: "add_name", name: "Tool 0", kind: "alternative" })))).toBe(false);
  });

  it("dismisses at once, without a save", async () => {
    const db = new FakeFirestore();
    await fileBrandMapSuggestions(ctx, { from: "vizzy", items: [{ change: change({ type: "add_subject", name: "Audits" }) }] }, { db, nowMs: T0 });
    const done = await dismissBrandMapSuggestions(ctx, ["subject:audits"], { db, nowMs: T0 + 1 });
    expect(done.ok && done.value.suggestions).toEqual([]);
    expect(done.ok && done.value.dismissed).toEqual(["subject:audits"]);
    expect(done.ok && done.value.rev).toBe(0);
  });

  it("treats a map that no longer reads as unreadable, never as absent, and writes nothing over it", async () => {
    const db = new FakeFirestore();
    await saveBrandMap(ctx, { baseRev: 0, decided: DECIDED }, { db, nowMs: T0 });
    await forTenant(ctx, db).brandMaps.update(brandMapDocId(ctx.tenantId), { subjects: [{ id: "not an id", name: "" }] });
    expect((await readBrandMap(ctx, db)).state).toBe("unreadable");
    expect(await decidedBrandMap(ctx, db)).toBeNull();
    expect(await saveBrandMap(ctx, { baseRev: 1, decided: DECIDED }, { db })).toMatchObject({ ok: false, error: "map_unreadable" });
    expect(
      await fileBrandMapSuggestions(ctx, { from: "article", items: [{ change: change({ type: "add_subject", name: "X" }) }] }, { db }),
    ).toMatchObject({ ok: false, error: "map_unreadable" });
  });

  it("reads past one suggestion that no longer parses", async () => {
    const db = new FakeFirestore();
    await fileBrandMapSuggestions(ctx, { from: "vizzy", items: [{ change: change({ type: "add_subject", name: "Audits" }) }] }, { db, nowMs: T0 });
    const read = await readBrandMap(ctx, db);
    const rows = read.state === "ok" ? read.map.suggestions : [];
    await forTenant(ctx, db).brandMaps.update(brandMapDocId(ctx.tenantId), { suggestions: [...rows, { id: "sg_x", change: { type: "from_a_newer_build" } }] });
    const again = await readBrandMap(ctx, db);
    expect(again.state === "ok" && again.map.suggestions).toHaveLength(1);
  });

  it("is not read for articles with the flag off, or before a person has saved it", async () => {
    const db = new FakeFirestore();
    await fileBrandMapSuggestions(ctx, { from: "research", items: [{ change: change({ type: "add_subject", name: "Audits" }) }] }, { db, nowMs: T0 });
    expect(await decidedBrandMap(ctx, db)).toBeNull(); // rev 0: only suggestions so far
    await saveBrandMap(ctx, { baseRev: 0, decided: DECIDED }, { db, nowMs: T0 + 1 });
    vi.stubEnv("BRAND_MAP_ENABLED", "false");
    expect(await decidedBrandMap(ctx, db)).toBeNull();
  });

  it("takes a full list of names in a three-byte script well under the size limit", async () => {
    const db = new FakeFirestore();
    const huge = {
      names: Array.from({ length: 80 }, (_, i) => ({
        id: `n_big${String(i).padStart(6, "0")}`,
        name: `名前${i}${"字".repeat(60)}`,
        kind: "alternative",
        aliases: Array.from({ length: 6 }, (_, j) => `${"别".repeat(55)}${i}-${j}`),
      })),
    };
    // CJK is three bytes a character; the caps still keep this far below the 700 KB guard.
    expect((await saveBrandMap(ctx, { baseRev: 0, decided: huge }, { db, nowMs: T0 })).ok).toBe(true);
  });
});
