import { describe, expect, it } from "vitest";
import { ImageStyleInputSchema, StoredImageStyleSchema, ImageStyleSuggestionSchema } from "./imageStyle";
import { TenantSchema } from "./tenant";
import { BlogArticleMetaSchema, BlogHeroSchema } from "./contentPlan";

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
});
