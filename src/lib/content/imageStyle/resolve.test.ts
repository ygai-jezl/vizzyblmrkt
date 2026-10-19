import { describe, expect, it } from "vitest";
import { resolveImageStyle, usableStyle, channelKeyFor } from "./resolve";
import { IMAGE_STYLES, LEGACY_TO_STYLE, canonicalStyleId, availableImageStyles, imageStyleById, isStyleAvailable } from "./catalogue";
import { IMAGE_STYLE_IDS, type StoredImageStyle } from "@/lib/types/imageStyle";
import { SOCIAL_IMAGE_STYLE_IDS } from "@/lib/content/create/socialImage";
import { EBOOK_IMAGE_STYLE_IDS } from "@/lib/content/create/ebook";

const brand = (s: Partial<StoredImageStyle>): StoredImageStyle => ({ defaultStyleId: null, ...s });

describe("resolveImageStyle", () => {
  it("switch off: every surface keeps today's behaviour, whatever the brand saved", () => {
    const b = brand({ defaultStyleId: "headline_card", channels: { linkedin: "natural_photo" } });
    expect(resolveImageStyle({ enabled: false, surface: "social", channel: "linkedin", brand: b })).toEqual({
      engine: "legacy",
      presetId: "cinematic",
      source: "legacy",
    });
    expect(resolveImageStyle({ enabled: false, surface: "ebook", brand: b })).toMatchObject({ presetId: "editorial" });
    expect(resolveImageStyle({ enabled: false, surface: "email", brand: b })).toMatchObject({ presetId: null });
    // An explicit old pick is still that old pick.
    expect(resolveImageStyle({ enabled: false, surface: "social", override: "retro" })).toEqual({
      engine: "legacy",
      presetId: "retro",
      source: "override",
    });
    // A new id with the switch off falls back to the old default.
    expect(resolveImageStyle({ enabled: false, surface: "social", override: "soft_3d" })).toMatchObject({
      engine: "legacy",
      presetId: "cinematic",
    });
  });

  it("before the brand picks, nothing changes (and a blog hero gets the Headline card)", () => {
    expect(resolveImageStyle({ enabled: true, surface: "social", channel: "x" })).toEqual({
      engine: "legacy",
      presetId: "cinematic",
      source: "legacy",
    });
    expect(resolveImageStyle({ enabled: true, surface: "ebook" })).toMatchObject({ presetId: "editorial" });
    expect(resolveImageStyle({ enabled: true, surface: "launchEmail" })).toMatchObject({ engine: "legacy", presetId: null });
    expect(resolveImageStyle({ enabled: true, surface: "blogHero" })).toMatchObject({
      engine: "template",
      id: "headline_card",
      source: "fallback",
    });
  });

  it("override wins, then the channel, then the default", () => {
    const b = brand({ defaultStyleId: "illustration", channels: { linkedin: "natural_photo" } });
    expect(resolveImageStyle({ enabled: true, surface: "social", channel: "linkedin", brand: b, override: "soft_3d" })).toMatchObject({
      engine: "model",
      id: "soft_3d",
      source: "override",
    });
    expect(resolveImageStyle({ enabled: true, surface: "social", channel: "linkedin", brand: b })).toMatchObject({
      id: "natural_photo",
      source: "channel",
    });
    expect(resolveImageStyle({ enabled: true, surface: "social", channel: "x", brand: b })).toMatchObject({
      id: "illustration",
      source: "default",
    });
    // "brand" and null both mean the brand's.
    expect(resolveImageStyle({ enabled: true, surface: "social", channel: "x", brand: b, override: "brand" })).toMatchObject({
      id: "illustration",
    });
  });

  it("an old preset picked for one image is honoured as that old look", () => {
    const b = brand({ defaultStyleId: "headline_card" });
    expect(resolveImageStyle({ enabled: true, surface: "social", brand: b, override: "popart" })).toEqual({
      engine: "legacy",
      presetId: "popart",
      source: "override",
    });
    expect(resolveImageStyle({ enabled: true, surface: "ebook", brand: b, override: "watercolor" })).toMatchObject({
      engine: "legacy",
      presetId: "watercolor",
    });
    // A social preset means nothing on an eBook: the brand's style is used.
    expect(resolveImageStyle({ enabled: true, surface: "ebook", brand: b, override: "popart" })).toMatchObject({
      engine: "model",
      id: "illustration",
    });
  });

  it("templates become their model twin where a template can't go", () => {
    const b = brand({ defaultStyleId: "product_noir" });
    expect(resolveImageStyle({ enabled: true, surface: "social", brand: b })).toMatchObject({
      engine: "template",
      id: "product_noir",
      requires: ["screenshots"],
      modelTwin: "product_still_life",
    });
    expect(resolveImageStyle({ enabled: true, surface: "ebook", brand: b })).toMatchObject({ engine: "model", id: "product_still_life" });
    expect(resolveImageStyle({ enabled: true, surface: "email", brand: brand({ defaultStyleId: "headline_card" }) })).toMatchObject({
      engine: "model",
      id: "illustration",
    });
  });

  it("a v2 style, with its switch off, resolves to its nearest v1 one", () => {
    expect(resolveImageStyle({ enabled: true, surface: "social", override: "type_poster" })).toMatchObject({ id: "headline_card" });
    expect(resolveImageStyle({ enabled: true, surface: "social", override: "split_card" })).toMatchObject({ id: "natural_photo" });
    expect(resolveImageStyle({ enabled: true, surface: "ebook", override: "data_story" })).toMatchObject({ id: "illustration" });
    expect(usableStyle("not_a_style", "social")).toBeNull();
  });

  it("with the v2 switch on, the four drawn styles are made as themselves", () => {
    for (const id of ["data_story", "type_poster", "split_card", "line_art"]) {
      expect(resolveImageStyle({ enabled: true, surface: "social", override: id, more: true }), id).toMatchObject({ engine: "template", id });
      expect(resolveImageStyle({ enabled: true, surface: "blogHero", brand: brand({ defaultStyleId: id as never }), more: true }), id).toMatchObject({ id, source: "default" });
    }
    expect(resolveImageStyle({ enabled: true, surface: "social", override: "data_story", more: true })).toMatchObject({ requires: ["numbers"] });
    // Where a drawn style can't go, its painted twin, as before.
    expect(resolveImageStyle({ enabled: true, surface: "ebook", override: "split_card", more: true })).toMatchObject({ id: "natural_photo" });
  });

  it("maps surfaces to the brand's channel keys", () => {
    expect(channelKeyFor("email")).toBe("newsletter");
    expect(channelKeyFor("social", "instagram")).toBe("instagram");
    expect(channelKeyFor("social", "facebook")).toBeNull();
  });
});

describe("the catalogue", () => {
  it("lists every style id once, and every fallback and twin is a real, usable style", () => {
    expect(IMAGE_STYLES.map((s) => s.id).sort()).toEqual([...IMAGE_STYLE_IDS].sort());
    for (const s of IMAGE_STYLES) {
      expect(s.built, s.id).toBe(true);
      if (s.since === "v2") expect(isStyleAvailable(imageStyleById(s.builtFallback), false), s.id).toBe(true);
      if (s.engine === "template") expect(imageStyleById(s.modelTwin)?.engine, s.id).toBe("model");
      if (s.engine === "model") expect(s.keywords.length, s.id).toBeGreaterThan(20);
      for (const surface of ["social", "blogHero", "ebook", "email", "launchEmail"] as const) {
        expect(usableStyle(s.id, surface), `${s.id} on ${surface}`).not.toBeNull();
      }
    }
    expect(availableImageStyles(false).map((s) => s.id)).toHaveLength(9);
    expect(availableImageStyles(true).map((s) => s.id)).toHaveLength(13);
  });

  it("maps every old preset (and only those) into a learning bucket", () => {
    expect(Object.keys(LEGACY_TO_STYLE).sort()).toEqual([...SOCIAL_IMAGE_STYLE_IDS, ...EBOOK_IMAGE_STYLE_IDS].sort());
    expect(canonicalStyleId("cinematic")).toBe("editorial_photo");
    expect(canonicalStyleId("photographic")).toBe("natural_photo");
    expect(canonicalStyleId("cyberpunk")).toBeNull();
    expect(canonicalStyleId("soft_3d")).toBe("soft_3d");
    expect(canonicalStyleId(null)).toBeNull();
    expect(canonicalStyleId("nonsense")).toBeNull();
  });
});
