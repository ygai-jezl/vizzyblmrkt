import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { readBrandMap, saveBrandMap } from "@/lib/brandMap/store";
import { COMPETITOR_LIMITS } from "@/lib/types/competitor";
import {
  addChange,
  addToBrandMap,
  checkNow,
  listChanges,
  markSeen,
  monitorCompetitor,
  onBrandMap,
  pageOnSite,
  removeCompetitor,
  retryCompetitor,
  unseenChanges,
  updateCompetitor,
  websiteOf,
  writeChunks,
} from "./store";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system", email: "admin@example.com" };
const other: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
let db: FakeFirestore;

beforeEach(() => {
  db = new FakeFirestore();
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

const monitor = (website: string, name = "Acme Dental", context = ctx) => monitorCompetitor(context, { website, name }, { db });
const saveMap = (decided: Record<string, unknown>) => saveBrandMap(ctx, { baseRev: 0, decided }, { db });

describe("a website as typed", () => {
  it("becomes an https origin and its registrable domain", () => {
    expect(websiteOf("acme-dental.example/about")).toEqual({ ok: true, origin: "https://acme-dental.example", site: "acme-dental.example" });
    expect(websiteOf("http://www.acme-dental.example")).toEqual({ ok: true, origin: "https://www.acme-dental.example", site: "acme-dental.example" });
  });

  it("is refused when it isn't a public site", () => {
    expect(websiteOf("")).toEqual({ ok: false, error: "website_required" });
    expect(websiteOf("localhost")).toEqual({ ok: false, error: "website_invalid" });
    expect(websiteOf("https://10.0.0.1")).toEqual({ ok: false, error: "website_invalid" });
    expect(websiteOf("ftp://acme.example")).toEqual({ ok: false, error: "website_not_https" });
  });

  it("a page a person types must be on the competitor's site", () => {
    expect(pageOnSite("acme-dental.example/news", "acme-dental.example")).toBe("https://acme-dental.example/news");
    expect(pageOnSite("https://elsewhere.example/news", "acme-dental.example")).toBeNull();
  });
});

describe("Monitor", () => {
  it("watches a site once per brand, and at most ten", async () => {
    const first = await monitor("acme-dental.example");
    expect(first.ok && first.value.competitor.status).toBe("finding");
    expect(await monitor("https://www.acme-dental.example")).toMatchObject({ ok: false, status: 409, error: "already_watching" });
    // Another brand may watch the same site.
    expect((await monitor("acme-dental.example", "Acme Dental", other)).ok).toBe(true);
    for (let i = 1; i < COMPETITOR_LIMITS.MAX_PER_BRAND; i += 1) expect((await monitor(`rival-${i}.example`, `Rival ${i}`)).ok).toBe(true);
    expect(await monitor("one-too-many.example")).toMatchObject({ ok: false, status: 409, error: "too_many" });
  });

  it("adds the name to a saved brand map's alternatives, and moves its revision", async () => {
    await saveMap({ identity: { name: "Brightsmile" } });
    const r = await monitor("acme-dental.example");
    expect(r.ok && r.value.brandMap).toBe("added");
    const read = await readBrandMap(ctx, db);
    expect(read.state === "ok" && read.map.rev).toBe(2);
    expect(read.state === "ok" && read.map.names.map((n) => [n.name, n.kind])).toEqual([["Acme Dental", "alternative"]]);
    expect(r.ok && r.value.competitor.nameId).toBe(read.state === "ok" ? read.map.names[0]!.id : "");
    // A person who opened the map before gets the usual 409, not a lost name.
    const stale = await saveBrandMap(ctx, { baseRev: 1, decided: { identity: { name: "Brightsmile" } } }, { db });
    expect(stale).toMatchObject({ ok: false, status: 409, error: "map_changed" });
  });

  it("links a name already on the map, by any spelling, and never changes it", async () => {
    await saveMap({ identity: { name: "Brightsmile" }, names: [{ id: "n_acme01", name: "Acme Dental Group", kind: "alternative", aliases: ["Acme Dental"], sameAs: [] }] });
    const r = await monitor("acme-dental.example");
    expect(r.ok && r.value.brandMap).toBe("already");
    expect(r.ok && r.value.competitor.nameId).toBe("n_acme01");
    const read = await readBrandMap(ctx, db);
    expect(read.state === "ok" && read.map.rev).toBe(1);
  });

  it("files a suggestion on a map nobody has saved, so the map stays unsaved", async () => {
    const r = await monitor("acme-dental.example");
    expect(r.ok && r.value.brandMap).toBe("suggested");
    const read = await readBrandMap(ctx, db);
    expect(read.state === "ok" && read.map.rev).toBe(0);
    expect(read.state === "ok" && read.map.suggestions.map((s) => [s.from, s.change.type])).toEqual([["competitors", "add_name"]]);
  });

  it("is never stopped by the brand map: off, or a name it can't take", async () => {
    vi.stubEnv("BRAND_MAP_ENABLED", "");
    const off = await monitor("acme-dental.example");
    expect(off.ok && off.value.brandMap).toBeNull();
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    await saveMap({ identity: { name: "Brightsmile", avoid: [{ term: "Smilecorp", useInstead: "" }] } });
    const clash = await monitor("smilecorp.example", "Smilecorp");
    expect(clash.ok && clash.value.brandMap).toBe("not_added");
    expect(clash.ok && clash.value.competitor.nameId).toBeNull();
    const own = await addToBrandMap(ctx, clash.ok ? clash.value.competitor.id : "", { db });
    expect(own).toMatchObject({ ok: false, status: 400, error: "invalid_map" });
  });

  it("says Monitoring by name, even after a stale save dropped the name", async () => {
    await saveMap({ identity: { name: "Brightsmile" } });
    const r = await monitor("acme-dental.example");
    if (!r.ok) throw new Error(r.error);
    expect([...(await onBrandMap(ctx, [r.value.competitor], { db }))]).toEqual([r.value.competitor.id]);
    // "Save mine anyway": the person's older copy, without the name, at the current revision.
    await saveBrandMap(ctx, { baseRev: 2, decided: { identity: { name: "Brightsmile" }, names: [] } }, { db });
    expect([...(await onBrandMap(ctx, [r.value.competitor], { db }))]).toEqual([]);
    expect((await addToBrandMap(ctx, r.value.competitor.id, { db })).ok).toBe(true);
    expect([...(await onBrandMap(ctx, [r.value.competitor], { db }))]).toEqual([r.value.competitor.id]);
  });
});

describe("a person's changes", () => {
  it("choose a news page or sitemap on their site, pause and resume, try again, check now", async () => {
    const r = await monitor("acme-dental.example");
    if (!r.ok) throw new Error(r.error);
    const id = r.value.competitor.id;
    expect(await updateCompetitor(ctx, id, { newsUrl: "https://elsewhere.example/news" }, { db })).toMatchObject({ ok: false, error: "not_on_their_site" });
    const news = await updateCompetitor(ctx, id, { newsUrl: "acme-dental.example/news" }, { db });
    expect(news.ok && news.value.news).toMatchObject({ url: "https://acme-dental.example/news", chosenBy: "manual" });
    const sitemap = await updateCompetitor(ctx, id, { sitemapUrl: "https://acme-dental.example/map.xml" }, { db });
    expect(sitemap.ok && sitemap.value.status).toBe("reading");
    expect(sitemap.ok && sitemap.value.read?.foundBy).toBe("manual");
    const paused = await updateCompetitor(ctx, id, { paused: true }, { db });
    expect(paused.ok && paused.value.status).toBe("paused");
    expect(await checkNow(ctx, id, { db })).toMatchObject({ ok: false, error: "not_watching" });
    const resumed = await updateCompetitor(ctx, id, { paused: false }, { db });
    expect(resumed.ok && resumed.value.status).toBe("watching");
    expect((await checkNow(ctx, id, { db })).ok).toBe(true);
    await forTenant(ctx, db).competitors.update(id, { status: "needs_you", problem: "no_sitemap", news: null, failures: 3 });
    const retried = await retryCompetitor(ctx, id, { db });
    expect(retried.ok && retried.value).toMatchObject({ status: "finding", stage: "plain", failures: 0, problem: null });
  });

  it("are refused for another brand's competitor", async () => {
    const r = await monitor("acme-dental.example");
    if (!r.ok) throw new Error(r.error);
    const id = r.value.competitor.id;
    expect(await updateCompetitor(other, id, { paused: true }, { db })).toMatchObject({ ok: false, status: 404 });
    expect(await removeCompetitor(other, id, { db })).toMatchObject({ ok: false, status: 404 });
    expect(await markSeen(other, id, { db })).toBe(0);
  });
});

describe("what changed", () => {
  const change = (competitorId: string, at: string) => ({
    competitorId,
    kind: "posts" as const,
    at,
    headline: `Posts at ${at}`,
    summary: "",
    topics: [],
    posts: [],
    added: { count: 1, sections: [] },
    removed: { count: 0, sections: [] },
    seenAt: null,
  });

  it("keeps the newest 60, lists unseen ones, and marks one competitor's seen", async () => {
    const a = await monitor("acme-dental.example");
    const b = await monitor("brightsmile.example", "Brightsmile");
    if (!a.ok || !b.ok) throw new Error("monitor");
    for (let i = 0; i < COMPETITOR_LIMITS.MAX_CHANGES + 3; i += 1) await addChange(ctx, change(a.value.competitor.id, `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`), { db });
    await addChange(ctx, change(b.value.competitor.id, "2026-11-01T00:00:00Z"), { db });
    const kept = await listChanges(ctx, a.value.competitor.id, { db });
    expect(kept).toHaveLength(COMPETITOR_LIMITS.MAX_CHANGES);
    expect(kept[0]!.at).toBe("2026-01-01T00:00:62Z");
    expect((await unseenChanges(ctx, { db }))[0]!.competitorId).toBe(b.value.competitor.id);
    expect(await unseenChanges(other, { db })).toEqual([]);
    expect(await markSeen(ctx, a.value.competitor.id, { db })).toBe(COMPETITOR_LIMITS.MAX_CHANGES);
    expect((await unseenChanges(ctx, { db })).map((c) => c.competitorId)).toEqual([b.value.competitor.id]);
  });

  it("stopping watching removes its pages, posts and changes, and leaves the brand map name", async () => {
    await saveMap({ identity: { name: "Brightsmile" } });
    const a = await monitor("acme-dental.example");
    if (!a.ok) throw new Error(a.error);
    const id = a.value.competitor.id;
    await writeChunks(ctx, id, 1, 0, [{ key: "/a", lastmod: null }], { db });
    await addChange(ctx, change(id, "2026-11-01T00:00:00Z"), { db });
    expect((await removeCompetitor(ctx, id, { db })).ok).toBe(true);
    expect(await forTenant(ctx, db).competitorPages.find({ where: [["competitorId", "==", id]] })).toEqual([]);
    expect(await listChanges(ctx, id, { db })).toEqual([]);
    const read = await readBrandMap(ctx, db);
    expect(read.state === "ok" && read.map.names.map((n) => n.name)).toEqual(["Acme Dental"]);
  });
});
