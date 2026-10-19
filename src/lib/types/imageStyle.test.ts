import { describe, expect, it } from "vitest";
import { ImageStyleInputSchema, StoredImageStyleSchema, ImageStyleSuggestionSchema } from "./imageStyle";
import { TenantSchema } from "./tenant";
import { BlogArticleMetaSchema, BlogHeroSchema, ContentNodeSchema, EbookImageSlotSchema } from "./contentPlan";
import { ChartSchema, FormatInputsSchema } from "./imageStyle";

const tenantBase = {
  id: "ten_A",
  tenantName: "Example Co",
  rootDomain: "example.com",
  status: "active",
  region: "us",
  allowedOrigins: ["https://example.com"],
  billingTier: "mvp_free",
  ownerId: "usr_owner",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("image style schemas", () => {
  it("a tenant without an image style parses as before, and a damaged one reads as none", () => {
    expect(TenantSchema.parse(tenantBase).imageStyle).toBeUndefined();
    const damaged = TenantSchema.parse({ ...tenantBase, imageStyle: "oops", imageStyleSuggestion: { defaultStyleId: "nope" } });
    expect(damaged.imageStyle).toBeUndefined();
    expect(damaged.imageStyleSuggestion).toBeUndefined();
  });

  it("reads a stored style leniently, field by field", () => {
    const s = StoredImageStyleSchema.parse({
      defaultStyleId: "not_a_style",
      channels: { linkedin: "natural_photo", x: "bogus" },
      accentHex: "red",
      learned: { soft_3d: { directive: "Pastel ground.", sampleCount: 3, updatedAt: "2026-10-19" } },
    });
    expect(s.defaultStyleId).toBeNull();
    expect(s.channels).toEqual({ linkedin: "natural_photo", x: undefined, blogHero: undefined, instagram: undefined, newsletter: undefined, ebook: undefined, launchEmail: undefined });
    expect(s.accentHex).toBeUndefined();
    expect(s.learned?.soft_3d?.sampleCount).toBe(3);
  });

  it("saves strictly", () => {
    expect(ImageStyleInputSchema.parse({ defaultStyleId: "headline_card" })).toEqual({
      defaultStyleId: "headline_card",
      channels: {},
      accentHex: null,
      logoOnSocial: true,
      headlineOnSocial: true,
    });
    expect(ImageStyleInputSchema.safeParse({ defaultStyleId: "headline_card", extra: 1 }).success).toBe(false);
    expect(ImageStyleInputSchema.safeParse({ defaultStyleId: "headline_card", channels: { tiktok: "soft_3d" } }).success).toBe(false);
    expect(ImageStyleInputSchema.safeParse({ defaultStyleId: "headline_card", accentHex: "#12345" }).success).toBe(false);
  });

  it("a suggestion needs a real style and a reason", () => {
    const ok = ImageStyleSuggestionSchema.safeParse({
      defaultStyleId: "product_noir",
      reason: "Your site shows dark product screens.",
      suggestedBy: "agent",
      suggestedAt: "2026-10-19T10:00:00Z",
    });
    expect(ok.success).toBe(true);
  });

  it("an article meta saved before heroes parses exactly as it did", () => {
    const old = BlogArticleMetaSchema.parse({ metaTitle: "T" });
    expect("hero" in old).toBe(false);
    expect("imageUrl" in old).toBe(false);
    const hero = BlogHeroSchema.parse({ status: "pending" });
    expect(hero).toMatchObject({ styleId: null, heroRef: null, shareRef: null, alt: "", attempts: 0, forTitle: "" });
  });

  it("v2 fields: old documents parse exactly as before, damaged ones read as none", () => {
    const node = {
      id: "n1", type: "spoke", channel: "linkedin", role: "Post", position: { x: 0, y: 0 },
    };
    const old = ContentNodeSchema.parse(node);
    for (const k of ["imageFormat", "imageFormatInputs", "imageChart"]) expect(k in old, k).toBe(false);
    const damaged = ContentNodeSchema.parse({ ...node, imageFormat: "poster", imageChart: { kind: "pie", points: [] }, imageFormatInputs: "x" });
    expect([damaged.imageFormat, damaged.imageChart, damaged.imageFormatInputs]).toEqual([undefined, undefined, undefined]);
    const hero = BlogHeroSchema.parse({ status: "ready", format: "report_cover", formatInputs: { title: "T", figure: { value: "120", unit: "teams" } }, note: "no_numbers" });
    expect(hero).toMatchObject({ format: "report_cover", formatInputs: { figure: { value: "120", unit: "teams" } }, note: "no_numbers" });
    expect(EbookImageSlotSchema.parse({ id: "cover", aspect: "4:5", format: "report_cover" })).toMatchObject({ aspect: "4:5", format: "report_cover" });
    expect("format" in EbookImageSlotSchema.parse({ id: "c" })).toBe(false);
  });

  it("a chart needs two to twelve points, each with a label and a number", () => {
    const ok = ChartSchema.parse({ kind: "line", points: [{ label: "10 Sep", value: 0 }, { label: "28 Sep", value: 100, display: "100%" }] });
    expect(ok).toMatchObject({ unit: "", points: [{ label: "10 Sep" }, { display: "100%" }] });
    expect(ChartSchema.safeParse({ kind: "line", points: [{ label: "a", value: 1 }] }).success).toBe(false);
    expect(ChartSchema.safeParse({ kind: "bar", points: [{ label: "", value: 1 }, { label: "b", value: 2 }] }).success).toBe(false);
    expect(ChartSchema.safeParse({ kind: "bar", points: [{ label: "a", value: Number.NaN }, { label: "b", value: 2 }] }).success).toBe(false);
    expect(FormatInputsSchema.safeParse({ quote: "q".repeat(241) }).success).toBe(false);
  });
});
