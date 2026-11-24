import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { BlogArticleMetaSchema } from "@/lib/types/contentPlan";
import { backfillBlogDates } from "./backfillDates";
import { sampleHub, samplePlan } from "./testing/samplePlan";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
const PLANS = "workspaces/ws1/content_plans";
const NOW = () => new Date("2026-11-24T12:00:00.000Z");
const live = (url: string) => ({ url, at: "2026-10-02T08:00:00.000Z", by: "check" as const, titleMatched: true });
const meta = (over: Record<string, unknown> = {}) => ({ ...BlogArticleMetaSchema.parse({}), ...over });

function world() {
  const db = new FakeFirestore();
  db.seed("workspaces", "ws1", { tenantId: "ten_A", name: "Blog", createdAt: "2026-01-01T00:00:00.000Z" });
  const plan = (id: string, hubMeta: Record<string, unknown>) =>
    db.seed(PLANS, id, { ...samplePlan({ id, createdAt: `2026-10-0${id.length}T00:00:00.000Z` }, sampleHub({ blog: meta(hubMeta) })) });
  plan("p_live", { live: live("https://acme.example/blog/a") });
  plan("p_dated", { live: live("https://acme.example/blog/b"), dates: { published: { at: "2026-09-01", source: "person" } } });
  plan("p_draft", {});
  return db;
}
const hubOf = async (db: FakeFirestore, id: string) => (await getContentPlan(A, "ws1", id, db))!.graph.nodes[0]!.blog;

describe("filling in dates for articles already live", () => {
  it("says what it would do on a dry run, and writes nothing", async () => {
    const db = world();
    expect(await backfillBlogDates(A, { apply: false, readPages: false }, { db, now: NOW })).toEqual({ live: 2, dated: 1, fromPage: 0, had: 1 });
    expect((await hubOf(db, "p_live"))?.dates).toBeUndefined();
  });

  it("dates each from its page when asked, else when first seen live, and never changes one already dated", async () => {
    const db = world();
    const readPage = async (url: string) => (url.endsWith("/a") ? { dates: { published: "2026-09-30", modified: "2026-10-20" } } : null);
    expect(await backfillBlogDates(A, { apply: true, readPages: true }, { db, now: NOW, readPage })).toEqual({ live: 2, dated: 1, fromPage: 1, had: 1 });
    expect((await hubOf(db, "p_live"))?.dates).toMatchObject({ published: { at: "2026-09-30", source: "page" }, updated: { at: "2026-10-20", source: "page" } });
    expect((await hubOf(db, "p_dated"))?.dates).toEqual({ published: { at: "2026-09-01", source: "person" } });
    // The live mark and copy are as they were; a second run has nothing to do.
    expect((await hubOf(db, "p_live"))?.live).toMatchObject({ url: "https://acme.example/blog/a" });
    expect(await backfillBlogDates(A, { apply: true, readPages: true }, { db, now: NOW, readPage })).toEqual({ live: 2, dated: 0, fromPage: 0, had: 2 });

    const plain = world();
    await backfillBlogDates(A, { apply: true, readPages: false }, { db: plain, now: NOW });
    expect((await hubOf(plain, "p_live"))?.dates).toEqual({ published: { at: "2026-10-02T08:00:00.000Z", source: "found" } });
  });

  it("only ever reads and writes its own brand", async () => {
    const db = world();
    expect(await backfillBlogDates(B, { apply: true, readPages: false }, { db, now: NOW })).toEqual({ live: 0, dated: 0, fromPage: 0, had: 0 });
    expect((await hubOf(db, "p_live"))?.dates).toBeUndefined();
  });
});
