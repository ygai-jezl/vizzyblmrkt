import { afterEach, describe, expect, it, vi } from "vitest";
import { BlogArticleMetaSchema } from "@/lib/types/contentPlan";
import { buildPlanPage, buildSitePage, pageFingerprint } from "./pageRow";
import { samplePlan, sampleHub } from "./testing/samplePlan";

describe("an article's row on the brand map", () => {
  it("holds the facts of its page", () => {
    expect(buildPlanPage(samplePlan())).toMatchObject({
      kind: "article",
      workspaceId: "ws1",
      planId: "plan_1",
      url: "https://acme.example/blog/visibility",
      title: "What is AI search visibility monitoring?",
      primaryQuestion: "What is AI search visibility monitoring?",
      primaryRef: "q_aaaaaaaa",
      questions: [
        { text: "How does it differ from SEO rank tracking?", ref: "q_bbbbbbbb" },
        { text: "What does it cost?", ref: null },
      ],
      subjectId: "sub_aaaaaaaa",
      state: "draft",
      liveAt: null,
    });
  });

  it("keeps the names it says and its links to the brand's own pages, once each", () => {
    const row = buildPlanPage(samplePlan())!;
    expect(row.names).toEqual(["Acme Visibility", "AI search visibility monitoring", "Rivalco"]);
    expect(row.links).toEqual(["https://acme.example/customers/harbor", "https://acme.example/product", "https://acme.example/pricing"]);
  });

  it("is planned before it is written, then a draft, then approved", () => {
    const planned = buildPlanPage(samplePlan({}, sampleHub({ body: "", status: "empty" })))!;
    expect(planned).toMatchObject({ state: "planned", links: [], title: "What is AI search visibility monitoring?" });
    // Not written yet: the names it is to say.
    expect(planned.names).toEqual(["Acme Visibility", "AI search visibility monitoring", "Rivalco", "ExampleChat"]);
    expect(buildPlanPage(samplePlan({}, sampleHub({ status: "approved" })))!.state).toBe("approved");
    expect(buildPlanPage(samplePlan({}, null))!.state).toBe("planned");
  });

  it("is live once seen at its address, and only at that address", () => {
    const live = { url: "https://acme.example/blog/visibility", at: "2026-10-15T10:00:00.000Z", by: "check" as const, titleMatched: true };
    const hub = sampleHub({ status: "approved", blog: { ...BlogArticleMetaSchema.parse({}), live } });
    expect(buildPlanPage(samplePlan({}, hub))).toMatchObject({ state: "live", liveAt: "2026-10-15T10:00:00.000Z" });
    const moved = samplePlan({ strategy: { objective: "brand_visibility", hubUrl: "https://acme.example/blog/moved", subscriberCount: null, sequenceType: null } }, hub);
    expect(buildPlanPage(moved)).toMatchObject({ state: "approved", liveAt: null });
  });

  it("has no address until an https one is set, and no row unless it is a blog article", () => {
    expect(buildPlanPage(samplePlan({ strategy: { objective: "brand_visibility", hubUrl: null, subscriberCount: null, sequenceType: null } }))!.url).toBeNull();
    expect(buildPlanPage(samplePlan({ strategy: { objective: "brand_visibility", hubUrl: "http://acme.example/x", subscriberCount: null, sequenceType: null } }))!.url).toBeNull();
    // A home page typed in the wizard is not the article's address.
    expect(buildPlanPage(samplePlan({ strategy: { objective: "brand_visibility", hubUrl: "https://acme.example/", subscriberCount: null, sequenceType: null } }))!.url).toBeNull();
    expect(buildPlanPage(samplePlan({ topology: { hubChannel: "newsletter", spokeChannels: [] } }))).toBeNull();
    expect(buildPlanPage(samplePlan({ strategy: { objective: "email_sequence", hubUrl: null, subscriberCount: null, sequenceType: "welcome" } }))).toBeNull();
  });

  it("leaves out a link too long to keep, rather than failing", () => {
    const long = `https://acme.example/${"x".repeat(2100)}`;
    const hub = sampleHub({ body: `# What is AI search visibility monitoring?\n\nSee [this](${long}) and [pricing](https://acme.example/pricing).` });
    expect(buildPlanPage(samplePlan({}, hub))!.links).toEqual(["https://acme.example/pricing"]);
  });

  it("fingerprints the facts, so an unchanged page is never rewritten", () => {
    const row = buildPlanPage(samplePlan())!;
    expect(pageFingerprint(row)).toBe(pageFingerprint(buildPlanPage(samplePlan())!));
    expect(pageFingerprint(row)).not.toBe(pageFingerprint({ ...row, state: "approved" }));
    expect(pageFingerprint(row)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("a row's worked-out facts, for the map at any size", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("are left off with the switch off, so a row (and its fingerprint) is exactly as before", () => {
    const row = buildPlanPage(samplePlan())!;
    expect(row).not.toHaveProperty("refs");
    expect(row).not.toHaveProperty("words");
    expect(buildSitePage({ url: "https://acme.example/pricing", title: "Pricing" }, new Set(["acme.example"]))).not.toHaveProperty("textKeys");
  });

  it("carry its question ids, the word keys of what it says, its address and its meaningful words", () => {
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
    const row = buildPlanPage(samplePlan())!;
    expect(row.refs).toEqual(["q_aaaaaaaa", "q_bbbbbbbb"]);
    expect(row.textKeys).toEqual([
      "what is ai search visibility monitoring",
      "how does it differ from seo rank tracking",
      "what does it cost",
    ]);
    expect(row.urlKey).toBe("https://acme.example/blog/visibility");
    expect(row.words).toContain("visibility");
    expect(row.words).not.toContain("what");
    // Turning the switch on rewrites each row once (its fingerprint changes), and never again.
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "false");
    const before = buildPlanPage(samplePlan())!;
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
    expect(pageFingerprint(row)).not.toBe(pageFingerprint(before));
    expect(pageFingerprint(buildPlanPage(samplePlan())!)).toBe(pageFingerprint(row));

    const site = buildSitePage({ url: "https://acme.example/share-of-voice/", title: "Share of voice, explained" }, new Set(["acme.example"]))!;
    expect(site).toMatchObject({ refs: [], textKeys: ["share of voice explained"], urlKey: "https://acme.example/share-of-voice", words: ["explained", "share", "voice"] });
  });
});

describe("an article's buying situation on its row", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is kept with the map at any size, and the row is as before without it", () => {
    const plan = samplePlan();
    const situated = { ...plan, blog: { ...plan.blog!, situationId: "sit_aaaaaaaa" } };
    expect(buildPlanPage(situated)).not.toHaveProperty("situationId");
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
    expect(buildPlanPage(situated)).toMatchObject({ situationId: "sit_aaaaaaaa" });
  });
});
