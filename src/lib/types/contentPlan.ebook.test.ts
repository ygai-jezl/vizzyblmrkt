import { describe, it, expect } from "vitest";
import {
  ContentNodeSchema,
  ContentPlanSchema,
  ContentScopeSchema,
  ContentTopologySchema,
  EbookChapterSchema,
  EbookDocSchema,
  EbookImageSlotSchema,
  CONTENT_PLAN_LIMITS,
} from "./contentPlan";

const hubBase = {
  id: "hub",
  type: "hub" as const,
  channel: "ebook",
  role: "eBook",
  position: { x: 0, y: 0 },
};

const chapter = {
  id: "c1",
  title: "The Shift",
  summary: "Why weekly writing compounds trust.",
};

const planBase = {
  id: "p1",
  tenantId: "ten_x",
  workspaceId: "ws_x",
  name: "Founder's Playbook",
  status: "draft" as const,
  strategy: { objective: "brand_visibility" as const },
  scope: { topics: [], spark: "" },
  knowledge: { groundingScope: "global" as const, proofAssets: [] },
  topology: { hubChannel: "ebook" as const, spokeChannels: ["linkedin"] },
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};

describe("Ebook image slot schema", () => {
  it("defaults a bare placeholder slot", () => {
    const s = EbookImageSlotSchema.parse({ id: "s1" });
    expect(s.status).toBe("placeholder");
    expect(s.aspect).toBe("1:1");
    expect(s.width).toBe(100);
    expect(s.contextPrompt).toBe("");
    expect(s.imageAssetRef ?? null).toBeNull();
  });

  it("accepts the extreme 1:4 aspect", () => {
    expect(EbookImageSlotSchema.parse({ id: "s1", aspect: "1:4" }).aspect).toBe("1:4");
  });

  it("rejects an unsupported aspect and out-of-range width", () => {
    expect(() => EbookImageSlotSchema.parse({ id: "s1", aspect: "9:16" })).toThrow();
    expect(() => EbookImageSlotSchema.parse({ id: "s1", width: 5 })).toThrow();
    expect(() => EbookImageSlotSchema.parse({ id: "s1", width: 120 })).toThrow();
  });
});

describe("Ebook chapter schema", () => {
  it("defaults status/body/images", () => {
    const c = EbookChapterSchema.parse(chapter);
    expect(c.status).toBe("planned");
    expect(c.bodyHtml).toBe("");
    expect(c.images).toEqual([]);
  });

  it("caps chapter body length + images per chapter", () => {
    expect(() =>
      EbookChapterSchema.parse({ ...chapter, bodyHtml: "x".repeat(CONTENT_PLAN_LIMITS.MAX_CHAPTER_CHARS + 1) }),
    ).toThrow();
    const tooMany = Array.from({ length: CONTENT_PLAN_LIMITS.MAX_IMAGES_PER_CHAPTER + 1 }, (_, i) => ({ id: `s${i}` }));
    expect(() => EbookChapterSchema.parse({ ...chapter, images: tooMany })).toThrow();
  });
});

describe("Ebook doc schema", () => {
  it("defaults subtitle/industryLens/tocConfirmed/chapters", () => {
    const d = EbookDocSchema.parse({ title: "My Book" });
    expect(d.subtitle).toBe("");
    expect(d.industryLens).toBe("");
    expect(d.tocConfirmed).toBe(false);
    expect(d.chapters).toEqual([]);
  });

  it("caps chapter count", () => {
    const tooMany = Array.from({ length: CONTENT_PLAN_LIMITS.MAX_CHAPTERS + 1 }, (_, i) => ({
      id: `c${i}`,
      title: `Chapter ${i}`,
    }));
    expect(() => EbookDocSchema.parse({ title: "My Book", chapters: tooMany })).toThrow();
  });
});

describe("ContentNode.ebook + ContentPlan.ebookDraft (additive/back-compat)", () => {
  it("parses a hub node WITHOUT an ebook (old plans)", () => {
    const n = ContentNodeSchema.parse(hubBase);
    expect(n.ebook ?? null).toBeNull();
  });

  it("parses a hub node carrying an ebook", () => {
    const n = ContentNodeSchema.parse({
      ...hubBase,
      ebook: { title: "My Book", chapters: [chapter] },
    });
    expect(n.ebook?.title).toBe("My Book");
    expect(n.ebook?.chapters[0]?.title).toBe("The Shift");
  });

  it("parses a legacy plan with no ebookDraft + no scope.industryLens", () => {
    const p = ContentPlanSchema.parse(planBase);
    expect(p.ebookDraft ?? null).toBeNull();
    expect(p.scope.industryLens).toBe("");
  });

  it("parses a plan carrying an ebookDraft", () => {
    const p = ContentPlanSchema.parse({
      ...planBase,
      ebookDraft: { title: "My Book", industryLens: "fintech", chapters: [chapter], tocConfirmed: true },
    });
    expect(p.ebookDraft?.tocConfirmed).toBe(true);
    expect(p.ebookDraft?.industryLens).toBe("fintech");
  });
});

describe("scope.industryLens + topology.hubChannel enum", () => {
  it("accepts industryLens on scope", () => {
    expect(ContentScopeSchema.parse({ industryLens: "SaaS" }).industryLens).toBe("SaaS");
  });

  it("accepts ebook as a hub channel", () => {
    expect(ContentTopologySchema.parse({ hubChannel: "ebook" }).hubChannel).toBe("ebook");
  });

  it("still rejects an unknown hub channel", () => {
    expect(() => ContentTopologySchema.parse({ hubChannel: "podcast" })).toThrow();
  });
});
