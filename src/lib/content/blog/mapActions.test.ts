import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/lib/tenant/types";
import { BrandMapDecidedSchema, type BrandMap } from "@/lib/types/brandMap";
import { BrandMapPageSchema } from "@/lib/types/brandMapPage";
import { articleSuggestions, loadArticleMap, softly } from "./mapActions";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const saved = {
  ...BrandMapDecidedSchema.parse({
    identity: { name: "Acme", site: "https://acme.example" },
    subjects: [{ id: "sub_aaaaaaaa", name: "Share of voice", questions: [{ id: "q_aaaaaaaa", text: "What is share of voice?", intent: "definition" }] }],
  }),
  rev: 2,
} as BrandMap;
const live = BrandMapPageSchema.parse({
  id: "p_a",
  tenantId: "ten_A",
  kind: "article",
  workspaceId: "ws1",
  planId: "a",
  title: "Share of voice, explained",
  url: "https://acme.example/blog/sov",
  primaryRef: "q_aaaaaaaa",
  subjectId: "sub_aaaaaaaa",
  state: "live",
  liveAt: "2026-10-01T00:00:00.000Z",
});
const deps = { loadMap: async () => saved, listPages: async () => [live] };

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("CREATE_BLOG_BRAND_MAP_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("the map an article is written from", () => {
  it("is none with its switch off, none saved, or a map that will not read", async () => {
    expect(await loadArticleMap(ctx, { loadMap: async () => null })).toBeNull();
    expect(await loadArticleMap(ctx, { loadMap: async () => Promise.reject(new Error("unreadable")) })).toBeNull();
    vi.stubEnv("CREATE_BLOG_BRAND_MAP_ENABLED", "false");
    expect(await loadArticleMap(ctx, deps)).toBeNull();
  });

  it("tells research what is answered and the live articles on each subject, with the pages switch on", async () => {
    vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
    const map = await loadArticleMap(ctx, deps, { pages: true });
    expect(map?.answered).toEqual({ q_aaaaaaaa: { title: "Share of voice, explained", url: "https://acme.example/blog/sov", state: "live" } });
    expect(map?.siblings).toEqual([{ subjectId: "sub_aaaaaaaa", title: "Share of voice, explained", url: "https://acme.example/blog/sov" }]);
    // Not asked for (the writer, the fact check): no page read.
    const listPages = vi.fn(async () => [live]);
    expect((await loadArticleMap(ctx, { ...deps, listPages }))?.answered).toEqual({});
    expect(listPages).not.toHaveBeenCalled();
  });

  it("reads no pages while the pages switch is off, and a failed read leaves them out", async () => {
    const listPages = vi.fn(async () => [live]);
    expect((await loadArticleMap(ctx, { ...deps, listPages }, { pages: true }))?.answered).toEqual({});
    expect(listPages).not.toHaveBeenCalled();
    vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
    const failing = { ...deps, listPages: async () => Promise.reject(new Error("down")) };
    expect(await loadArticleMap(ctx, failing, { pages: true })).toMatchObject({ rev: 2, answered: {}, siblings: [] });
  });
});

describe("what an article gives back", () => {
  it("suggests the names it uses that the map does not have, as names the map can take", () => {
    const items = articleSuggestions({ id: "p1", workspaceId: "ws1", name: "Guide" }, [
      { name: "Peec", relation: "alternative", by: "research" },
      { name: "Acme", relation: "brand", by: "research" },
    ]);
    expect(items).toEqual([
      {
        change: { type: "add_name", name: "Peec", kind: "alternative", aliases: [] },
        reason: "Named in an article",
        evidence: "articles",
        ref: { workspaceId: "ws1", planId: "p1", title: "Guide" },
      },
    ]);
  });

  it("never waits long for, or fails on, a side job", async () => {
    vi.useFakeTimers();
    const slow = softly("a slow job", () => new Promise<number>(() => undefined), 50);
    await vi.advanceTimersByTimeAsync(60);
    expect(await slow).toBeNull();
    vi.useRealTimers();
    expect(await softly("a failing job", async () => Promise.reject(new Error("no")))).toBeNull();
    expect(await softly("a quick job", async () => 7)).toBe(7);
  });
});
