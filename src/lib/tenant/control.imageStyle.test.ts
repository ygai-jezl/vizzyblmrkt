import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import {
  clearTenantImageStyle,
  clearTenantImageStyleSuggestion,
  setTenantImageStyle,
  setTenantImageStyleSuggestion,
  setTenantSiteFonts,
  setTenantStyleLearned,
} from "./control";
import { getTenantById } from "./registry";
import type { ImageStyleInput, ImageStyleSuggestion } from "@/lib/types/imageStyle";

const INPUT: ImageStyleInput = {
  defaultStyleId: "headline_card",
  channels: { linkedin: "natural_photo" },
  accentHex: "#5B4FE6",
  logoOnSocial: true,
  headlineOnSocial: false,
};
const SUGGESTION: ImageStyleSuggestion = {
  defaultStyleId: "product_noir",
  reason: "Your site shows dark product screens.",
  suggestedBy: "agent",
  suggestedAt: "2026-10-19T10:00:00.000Z",
};
const FONTS = {
  heading: { family: "Roboto", detected: null, source: "google" as const },
  body: { family: "Roboto", detected: null, source: "google" as const },
  domain: "example.com",
  detectedAt: "2026-10-19T09:00:00.000Z",
  systemOnly: true,
};

function seeded(over: Record<string, unknown> = {}): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("tenants", "ten_A", {
    tenantName: "Example Co",
    rootDomain: "example.com",
    status: "active",
    region: "us",
    allowedOrigins: ["https://example.com"],
    billingTier: "mvp_free",
    ownerId: "usr_owner",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    brandVoice: { summary: "Warm" },
    ...over,
  });
  return db;
}

describe("setTenantImageStyle", () => {
  it("stores the style top-level, lowercased and stamped, and leaves the rest alone", async () => {
    const db = seeded();
    const stored = await setTenantImageStyle("ten_A", INPUT, db, { updatedBy: "usr_admin" });
    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.imageStyle).toEqual({
      defaultStyleId: "headline_card",
      channels: { linkedin: "natural_photo" },
      accentHex: "#5b4fe6",
      logoOnSocial: true,
      headlineOnSocial: false,
      updatedAt: expect.any(String),
      updatedBy: "usr_admin",
    });
    expect(stored).toEqual(raw.imageStyle);
    expect(raw.brandVoice).toEqual({ summary: "Warm" });
    expect((await getTenantById("ten_A", db))?.imageStyle?.defaultStyleId).toBe("headline_card");
  });

  it("keeps what was learned and the site fonts, and a damaged stored value never blocks a Save", async () => {
    const db = seeded();
    await setTenantStyleLearned("ten_A", "soft_3d", { directive: "Pastel ground, one object.", sampleCount: 4 }, db);
    await setTenantSiteFonts("ten_A", FONTS, db);
    await setTenantImageStyle("ten_A", { ...INPUT, accentHex: null }, db);
    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.imageStyle).toMatchObject({
      learned: { soft_3d: { directive: "Pastel ground, one object.", sampleCount: 4 } },
      siteFonts: FONTS,
    });
    expect(raw.imageStyle).not.toHaveProperty("accentHex");

    const damaged = seeded({ imageStyle: "oops" });
    await setTenantImageStyle("ten_A", INPUT, damaged);
    expect(damaged.raw("tenants", "ten_A")!.imageStyle).toMatchObject({ defaultStyleId: "headline_card" });
  });

  it("refuses a style the read would drop", async () => {
    const db = seeded();
    await expect(setTenantImageStyle("ten_A", { ...INPUT, defaultStyleId: "nope" as never }, db)).rejects.toThrow();
    expect(db.raw("tenants", "ten_A")).not.toHaveProperty("imageStyle");
  });

  it("saving a suggestion clears it, but only while it's still the pending one", async () => {
    const db = seeded();
    await setTenantImageStyleSuggestion("ten_A", SUGGESTION, db);
    await setTenantImageStyle("ten_A", INPUT, db, { clearSuggestionAt: "2026-10-19T09:59:00.000Z" });
    expect(db.raw("tenants", "ten_A")).toHaveProperty("imageStyleSuggestion");
    await setTenantImageStyle("ten_A", INPUT, db, { clearSuggestionAt: SUGGESTION.suggestedAt });
    expect(db.raw("tenants", "ten_A")).not.toHaveProperty("imageStyleSuggestion");
  });

  it("Reset removes the style and keeps a pending suggestion", async () => {
    const db = seeded();
    await setTenantImageStyle("ten_A", INPUT, db);
    await setTenantImageStyleSuggestion("ten_A", SUGGESTION, db);
    await clearTenantImageStyle("ten_A", db);
    const raw = db.raw("tenants", "ten_A")!;
    expect(raw).not.toHaveProperty("imageStyle");
    expect(raw).toHaveProperty("imageStyleSuggestion");
  });
});

describe("the suggestion", () => {
  it("is stored without touching the style, and dismissed only while it's the same one", async () => {
    const db = seeded();
    await setTenantImageStyle("ten_A", INPUT, db);
    await setTenantImageStyleSuggestion("ten_A", SUGGESTION, db);
    expect(db.raw("tenants", "ten_A")!.imageStyle).toMatchObject({ defaultStyleId: "headline_card" });
    expect(await clearTenantImageStyleSuggestion("ten_A", "2026-10-19T09:00:00.000Z", db)).toBe(false);
    expect(await clearTenantImageStyleSuggestion("ten_A", SUGGESTION.suggestedAt, db)).toBe(true);
    expect(db.raw("tenants", "ten_A")).not.toHaveProperty("imageStyleSuggestion");
  });
});

describe("learning per style and site fonts", () => {
  it("changes only that style's entry, on a tenant with no style yet", async () => {
    const db = seeded();
    await setTenantStyleLearned("ten_A", "natural_photo", { directive: "Daylight.", sampleCount: 2 }, db);
    await setTenantStyleLearned("ten_A", "soft_3d", { directive: null, sampleCount: 0 }, db);
    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.imageStyle).toMatchObject({
      defaultStyleId: null,
      learned: { natural_photo: { directive: "Daylight.", sampleCount: 2 }, soft_3d: { directive: null, sampleCount: 0 } },
    });
    await expect(setTenantStyleLearned("ten_A", "nope" as never, { directive: "x", sampleCount: 1 }, db)).rejects.toThrow();
  });

  it("site fonts can be set and forgotten", async () => {
    const db = seeded();
    await setTenantImageStyle("ten_A", INPUT, db);
    await setTenantSiteFonts("ten_A", FONTS, db);
    expect(db.raw("tenants", "ten_A")!.imageStyle).toMatchObject({ siteFonts: FONTS, defaultStyleId: "headline_card" });
    await setTenantSiteFonts("ten_A", null, db);
    expect(db.raw("tenants", "ten_A")!.imageStyle).not.toHaveProperty("siteFonts");
  });
});
