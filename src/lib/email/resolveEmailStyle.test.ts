import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantSchema, type StoredEmailStyle, type Tenant } from "@/lib/types/tenant";
import { resolveEmailStyle, resolveJourneyEmailStyle, resolveTransactionalEmailStyle } from "./resolveEmailStyle";
import { themeTokens, tint } from "./emailThemes";

const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e.png";
const STYLE: StoredEmailStyle = {
  logo: { id: "logo_1", filename: FILE, width: 120, height: 40 },
  companyName: null,
  headerColor: "#0b1f3a",
  accentColor: "#ff6b35",
};

function tenant(over: Record<string, unknown> = {}): Tenant {
  return TenantSchema.parse({
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
    emailStyle: STYLE,
    ...over,
  });
}

beforeEach(() => {
  vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
  vi.stubEnv("BRAND_KIT_LOGOS_ENABLED", "true");
  vi.stubEnv("EMAIL_LINK_ORIGIN", "https://app.example.com");
  vi.stubEnv("NEXT_PUBLIC_PLATFORM_ORIGIN", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("resolveEmailStyle", () => {
  it("resolves a saved style with this tenant's absolute logo URL", () => {
    expect(resolveEmailStyle(tenant())).toEqual({
      logo: { url: `https://app.example.com/api/brand-logo/ten_A/${FILE}`, width: 120, height: 40 },
      name: null,
      altName: "Example Co",
      headerColor: "#0b1f3a",
      accentColor: "#ff6b35",
    });
  });

  it("flag off, no style, no tenant or a malformed stored style → null", () => {
    vi.stubEnv("EMAIL_STYLE_ENABLED", "false");
    expect(resolveEmailStyle(tenant())).toBeNull();
    vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
    expect(resolveEmailStyle(tenant({ emailStyle: undefined }))).toBeNull();
    expect(resolveEmailStyle(null)).toBeNull();
    // A tenant built outside the registry still can't smuggle a bad value through.
    const bad = { ...tenant(), emailStyle: { ...STYLE, headerColor: "red" } };
    expect(resolveEmailStyle(bad)).toBeNull();
  });

  it("logos flag off → a name band", () => {
    vi.stubEnv("BRAND_KIT_LOGOS_ENABLED", "false");
    expect(resolveEmailStyle(tenant())).toMatchObject({ logo: null, altName: "Example Co" });
  });

  it("no origin to build the logo URL from → a name band", () => {
    vi.stubEnv("EMAIL_LINK_ORIGIN", "");
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_ORIGIN", "");
    expect(resolveEmailStyle(tenant())).toMatchObject({ logo: null, headerColor: "#0b1f3a" });
  });

  it("an http origin never reaches an inbox as a logo URL", () => {
    vi.stubEnv("EMAIL_LINK_ORIGIN", "http://localhost:3000");
    expect(resolveEmailStyle(tenant())!.logo).toBeNull();
  });

  describe("header options", () => {
    const withOptions = () => tenant({ emailStyle: { ...STYLE, headerGradientColor: "#4f46e5", headerText: "white" } });

    it("flag off: the saved gradient and text colour are ignored — exactly today's style", () => {
      vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "false");
      expect(resolveEmailStyle(withOptions())).toStrictEqual(resolveEmailStyle(tenant()));
      vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "");
      expect(resolveEmailStyle(withOptions())).not.toHaveProperty("headerGradientColor");
    });

    it("flag on: they're drawn; a solid header with Auto text is still exactly today's", () => {
      vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
      expect(resolveEmailStyle(withOptions())).toMatchObject({ headerGradientColor: "#4f46e5", headerText: "white" });
      expect(resolveEmailStyle(tenant())).toStrictEqual({
        logo: { url: `https://app.example.com/api/brand-logo/ten_A/${FILE}`, width: 120, height: 40 },
        name: null,
        altName: "Example Co",
        headerColor: "#0b1f3a",
        accentColor: "#ff6b35",
      });
    });

    // Pinned whole: with the flag on, a stored gradient and text colour resolve to exactly this.
    it("flag on: pins today's style with a gradient and a forced text colour", () => {
      vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
      expect(resolveEmailStyle(withOptions())).toStrictEqual({
        logo: { url: `https://app.example.com/api/brand-logo/ten_A/${FILE}`, width: 120, height: 40 },
        name: null,
        altName: "Example Co",
        headerColor: "#0b1f3a",
        accentColor: "#ff6b35",
        headerGradientColor: "#4f46e5",
        headerText: "white",
      });
    });

    it("flag off: a key the style doesn't know yet (headerImage) changes nothing — exactly today's style", () => {
      vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "false");
      const headerImage = { id: "hdr_1", filename: "7c9e6679-7425-40de-944b-e07fc1f90ae7.png", width: 1200, height: 300 };
      const today = {
        logo: { url: `https://app.example.com/api/brand-logo/ten_A/${FILE}`, width: 120, height: 40 },
        name: null,
        altName: "Example Co",
        headerColor: "#0b1f3a",
        accentColor: "#ff6b35",
      };
      // Built outside the registry, so the raw key reaches the resolver's own read.
      const raw = { ...tenant(), emailStyle: { ...STYLE, headerImage } as unknown as StoredEmailStyle };
      expect(resolveEmailStyle(raw)).toStrictEqual(today);
      expect(resolveEmailStyle(tenant({ emailStyle: { ...STYLE, headerImage } }))).toStrictEqual(today);
    });

    it("a damaged option drops alone and the rest of the style still resolves", () => {
      vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
      // Built outside the registry, so the resolver's own lenient read is what drops them.
      const damaged = { ...STYLE, headerGradientColor: "purple", headerText: "pink" } as unknown as StoredEmailStyle;
      const bad = { ...tenant(), emailStyle: damaged };
      expect(resolveEmailStyle(bad)).toStrictEqual(resolveEmailStyle(tenant()));
    });
  });

  describe("header image", () => {
    const IMAGE = { id: "hdr_1", filename: "3f2504e0-4f89-41d3-9a0c-0305e82c3301.jpg", width: 1200, height: 300 };
    const withImage = () => tenant({ emailStyle: { ...STYLE, headerImage: IMAGE } });
    const BANNER_URL = `https://app.example.com/api/brand-asset/header/ten_A/${IMAGE.filename}`;

    it("flag off: ignored — exactly today's style", () => {
      vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "false");
      expect(resolveEmailStyle(withImage())).toStrictEqual(resolveEmailStyle(tenant()));
    });

    it("flag on: this tenant's absolute banner URL on the public brand-asset route, with the stored size", () => {
      vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
      expect(resolveEmailStyle(withImage())).toStrictEqual({
        logo: { url: `https://app.example.com/api/brand-logo/ten_A/${FILE}`, width: 120, height: 40 },
        name: null,
        altName: "Example Co",
        headerColor: "#0b1f3a",
        accentColor: "#ff6b35",
        headerImage: { url: BANNER_URL, width: 1200, height: 300 },
      });
    });

    it("flag on: kept with the Logos flag off (the brand-asset route isn't gated on it)", () => {
      vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
      vi.stubEnv("BRAND_KIT_LOGOS_ENABLED", "false");
      expect(resolveEmailStyle(withImage())).toMatchObject({ logo: null, headerImage: { url: BANNER_URL } });
    });

    it("no https origin → no banner, so the email shows the colour band", () => {
      vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
      vi.stubEnv("EMAIL_LINK_ORIGIN", "");
      vi.stubEnv("NEXT_PUBLIC_PLATFORM_ORIGIN", "");
      expect(resolveEmailStyle(withImage())).not.toHaveProperty("headerImage");
      vi.stubEnv("EMAIL_LINK_ORIGIN", "http://localhost:3000");
      expect(resolveEmailStyle(withImage())).not.toHaveProperty("headerImage");
    });

    it("a damaged stored image reads as the colour header, and the rest still resolves", () => {
      vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
      const damaged = { ...STYLE, headerImage: { ...IMAGE, filename: "x.webp" } } as unknown as StoredEmailStyle;
      expect(resolveEmailStyle({ ...tenant(), emailStyle: damaged })).toStrictEqual(resolveEmailStyle(tenant()));
      expect(resolveEmailStyle(tenant({ emailStyle: damaged }))).toStrictEqual(resolveEmailStyle(tenant()));
    });
  });

  describe("theme", () => {
    const today = {
      logo: { url: `https://app.example.com/api/brand-logo/ten_A/${FILE}`, width: 120, height: 40 },
      name: null,
      altName: "Example Co",
      headerColor: "#0b1f3a",
      accentColor: "#ff6b35",
    };
    const withTheme = (theme: unknown) => tenant({ emailStyle: { ...STYLE, theme } });

    it("flag off: a saved theme is ignored — exactly today's style, with web fonts on or off", () => {
      for (const flag of ["false", ""]) {
        vi.stubEnv("EMAIL_THEMES_ENABLED", flag);
        expect(resolveEmailStyle(withTheme({ preset: "modern", bodyFont: "lora" }))).toStrictEqual(today);
        vi.stubEnv("EMAIL_WEB_FONTS_ENABLED", "true");
        expect(resolveEmailStyle(withTheme({ preset: "modern", bodyFont: "lora" }))).toStrictEqual(today);
        vi.stubEnv("EMAIL_WEB_FONTS_ENABLED", "");
      }
    });

    it("flag on: drawn with its safe fonts only while web fonts are off", () => {
      vi.stubEnv("EMAIL_THEMES_ENABLED", "true");
      expect(resolveEmailStyle(withTheme({ preset: "modern", bodyFont: "lora" }))).toStrictEqual({
        ...today,
        theme: { preset: "modern", headingFont: "inter", bodyFont: "lora" },
      });
    });

    it("flag on with web fonts: the font files come from the email link origin, https only", () => {
      vi.stubEnv("EMAIL_THEMES_ENABLED", "true");
      vi.stubEnv("EMAIL_WEB_FONTS_ENABLED", "true");
      expect(resolveEmailStyle(withTheme({ preset: "modern" }))!.theme).toStrictEqual({
        preset: "modern",
        headingFont: "inter",
        bodyFont: "inter",
        webFontOrigin: "https://app.example.com",
      });
      // A safe-only theme needs no files.
      expect(resolveEmailStyle(withTheme({ preset: "classic", bodyFont: "georgia" }))!.theme).not.toHaveProperty(
        "webFontOrigin",
      );
      vi.stubEnv("EMAIL_LINK_ORIGIN", "http://localhost:3000");
      expect(resolveEmailStyle(withTheme({ preset: "modern" }))!.theme).not.toHaveProperty("webFontOrigin");
      vi.stubEnv("EMAIL_LINK_ORIGIN", "");
      expect(resolveEmailStyle(withTheme({ preset: "modern" }))!.theme).not.toHaveProperty("webFontOrigin");
    });

    it("flag on: Classic with the system font, or a damaged theme, is exactly today's style", () => {
      vi.stubEnv("EMAIL_THEMES_ENABLED", "true");
      vi.stubEnv("EMAIL_WEB_FONTS_ENABLED", "true");
      expect(resolveEmailStyle(withTheme({ preset: "classic" }))).toStrictEqual(today);
      expect(resolveEmailStyle(tenant())).toStrictEqual(today);
      for (const damaged of [{ preset: "brutalist" }, "modern", null, { preset: "classic", headingFont: "comic-sans" }]) {
        const style = { ...STYLE, theme: damaged } as unknown as StoredEmailStyle;
        // Built outside the registry, so the resolver's own lenient read is what drops it.
        expect(resolveEmailStyle({ ...tenant(), emailStyle: style })).toStrictEqual(today);
        expect(resolveEmailStyle(tenant({ emailStyle: style }))).toStrictEqual(today);
      }
    });

    it("flag on: an unknown font reads as the preset's", () => {
      vi.stubEnv("EMAIL_THEMES_ENABLED", "true");
      const style = { ...STYLE, theme: { preset: "editorial", headingFont: "comic-sans" } } as unknown as StoredEmailStyle;
      expect(resolveEmailStyle({ ...tenant(), emailStyle: style })!.theme).toStrictEqual({
        preset: "editorial",
        headingFont: "lora",
        bodyFont: "georgia",
      });
    });
  });

  describe("layout buttons", () => {
    const today = {
      logo: { url: `https://app.example.com/api/brand-logo/ten_A/${FILE}`, width: 120, height: 40 },
      name: null,
      altName: "Example Co",
      headerColor: "#0b1f3a",
      accentColor: "#ff6b35",
    };

    it("flag off: no bit — exactly today's style", () => {
      for (const flag of ["false", ""]) {
        vi.stubEnv("EMAIL_LAYOUT_STYLE_ENABLED", flag);
        expect(resolveEmailStyle(tenant())).toStrictEqual(today);
      }
    });

    it("flag on: the bit is set, and nothing else changes", () => {
      vi.stubEnv("EMAIL_LAYOUT_STYLE_ENABLED", "true");
      expect(resolveEmailStyle(tenant())).toStrictEqual({ ...today, layouts: true });
    });

    it("flag on: still null with the Email style off or nothing saved", () => {
      vi.stubEnv("EMAIL_LAYOUT_STYLE_ENABLED", "true");
      expect(resolveEmailStyle(tenant({ emailStyle: undefined }))).toBeNull();
      vi.stubEnv("EMAIL_STYLE_ENABLED", "false");
      expect(resolveEmailStyle(tenant())).toBeNull();
    });
  });

  it("altName is the company name when set, else the sender name, else the tenant name", () => {
    expect(resolveEmailStyle(tenant({ emailStyle: { ...STYLE, companyName: "Acme" } }))).toMatchObject({
      name: "Acme",
      altName: "Acme",
    });
    expect(resolveEmailStyle(tenant({ emailSenderConfig: { senderName: "Example Team" } }))!.altName).toBe(
      "Example Team",
    );
    expect(resolveEmailStyle(tenant())!.altName).toBe("Example Co");
  });
});

describe("resolveTransactionalEmailStyle (the confirmation and offboarding emails)", () => {
  const IMAGE = { id: "hdr_1", filename: "3f2504e0-4f89-41d3-9a0c-0305e82c3301.jpg", width: 1200, height: 300 };
  const withImage = () => tenant({ emailStyle: { ...STYLE, headerImage: IMAGE } });
  beforeEach(() => vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true"));

  it("flag off: null, whatever is saved — today's plain emails", () => {
    for (const flag of ["false", ""]) {
      vi.stubEnv("EMAIL_STYLE_TRANSACTIONAL_ENABLED", flag);
      expect(resolveTransactionalEmailStyle(tenant())).toBeNull();
      expect(resolveTransactionalEmailStyle(withImage())).toBeNull();
    }
  });

  it("flag on: the tenant's Email style", () => {
    vi.stubEnv("EMAIL_STYLE_TRANSACTIONAL_ENABLED", "true");
    expect(resolveTransactionalEmailStyle(tenant())).toStrictEqual(resolveEmailStyle(tenant()));
    vi.stubEnv("EMAIL_THEMES_ENABLED", "true");
    vi.stubEnv("EMAIL_LAYOUT_STYLE_ENABLED", "true");
    const themed = tenant({ emailStyle: { ...STYLE, headerGradientColor: "#4f46e5", theme: { preset: "editorial" } } });
    expect(resolveTransactionalEmailStyle(themed)).toStrictEqual(resolveEmailStyle(themed));
    expect(resolveTransactionalEmailStyle(themed)).toMatchObject({ headerGradientColor: "#4f46e5", theme: { preset: "editorial" } });
  });

  it("flag on: never the banner — the colour header, with the logo and everything else as saved", () => {
    vi.stubEnv("EMAIL_STYLE_TRANSACTIONAL_ENABLED", "true");
    expect(resolveEmailStyle(withImage())).toHaveProperty("headerImage");
    expect(resolveTransactionalEmailStyle(withImage())).toStrictEqual({
      logo: { url: `https://app.example.com/api/brand-logo/ten_A/${FILE}`, width: 120, height: 40 },
      name: null,
      altName: "Example Co",
      headerColor: "#0b1f3a",
      accentColor: "#ff6b35",
    });
  });

  it("flag on: still null with the Email style off, nothing saved, a damaged style or no tenant", () => {
    vi.stubEnv("EMAIL_STYLE_TRANSACTIONAL_ENABLED", "true");
    expect(resolveTransactionalEmailStyle(tenant({ emailStyle: undefined }))).toBeNull();
    expect(resolveTransactionalEmailStyle({ ...tenant(), emailStyle: { ...STYLE, headerColor: "red" } })).toBeNull();
    expect(resolveTransactionalEmailStyle(null)).toBeNull();
    vi.stubEnv("EMAIL_STYLE_ENABLED", "false");
    expect(resolveTransactionalEmailStyle(tenant())).toBeNull();
  });
});

describe("resolveJourneyEmailStyle (a lifecycle journey's sends and previews)", () => {
  const LOGO = { url: `https://app.example.com/api/brand-logo/ten_A/${FILE}`, width: 120, height: 40 };
  const IMAGE = { id: "hdr_1", filename: "3f2504e0-4f89-41d3-9a0c-0305e82c3301.jpg", width: 1200, height: 300 };
  const CUSTOM = { headerColor: "#1e3a8a", accentColor: "#f97316" };
  const damaged: unknown[] = [
    null,
    "navy",
    42,
    { headerColor: "#1e3a8a" },
    { headerColor: "navy", accentColor: "#f97316" },
    { ...CUSTOM, headerColor: undefined },
  ];

  it("flag off: exactly the brand's style, whatever the journey stores", () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    vi.stubEnv("EMAIL_LAYOUT_STYLE_ENABLED", "true");
    for (const flag of ["false", ""]) {
      vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", flag);
      for (const override of [undefined, CUSTOM, { ...CUSTOM, headerGradientColor: "#4f46e5" }, ...damaged]) {
        expect(resolveJourneyEmailStyle(tenant(), override)).toStrictEqual(resolveEmailStyle(tenant()));
      }
      expect(resolveJourneyEmailStyle(tenant({ emailStyle: undefined }), CUSTOM)).toBeNull();
    }
  });

  it("null with the Email style off, even for a journey with its own style", () => {
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
    vi.stubEnv("EMAIL_STYLE_ENABLED", "false");
    expect(resolveJourneyEmailStyle(tenant(), CUSTOM)).toBeNull();
    expect(resolveJourneyEmailStyle(tenant({ emailStyle: undefined }), CUSTOM)).toBeNull();
  });

  it("flag on: no style, or an unreadable one, is the brand's", () => {
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
    for (const override of [undefined, ...damaged]) {
      expect(resolveJourneyEmailStyle(tenant(), override)).toStrictEqual(resolveEmailStyle(tenant()));
    }
    expect(resolveJourneyEmailStyle(null, CUSTOM)).toBeNull();
  });

  it("flag on: the journey's colours on the colour header, with the brand's logo and never its banner", () => {
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    const brand = tenant({ emailStyle: { ...STYLE, companyName: "Acme", headerGradientColor: "#4f46e5", headerImage: IMAGE } });
    expect(resolveEmailStyle(brand)).toHaveProperty("headerImage");
    expect(resolveJourneyEmailStyle(brand, CUSTOM)).toStrictEqual({ logo: LOGO, name: "Acme", altName: "Acme", ...CUSTOM });
  });

  it("flag on: the journey's gradient and header text need the header options flag too", () => {
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
    const options = { ...CUSTOM, headerGradientColor: "#4F46E5", headerText: "white" };
    expect(resolveJourneyEmailStyle(tenant(), options)).toStrictEqual({
      logo: LOGO,
      name: null,
      altName: "Example Co",
      ...CUSTOM,
    });
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
    expect(resolveJourneyEmailStyle(tenant(), options)).toStrictEqual({
      logo: LOGO,
      name: null,
      altName: "Example Co",
      ...CUSTOM,
      headerGradientColor: "#4f46e5",
      headerText: "white",
    });
    // A damaged gradient drops alone.
    expect(resolveJourneyEmailStyle(tenant(), { ...CUSTOM, headerGradientColor: "purple" })).toMatchObject(CUSTOM);
    expect(resolveJourneyEmailStyle(tenant(), { ...CUSTOM, headerGradientColor: "purple" })).not.toHaveProperty(
      "headerGradientColor",
    );
  });

  it("flag on: the brand's theme and layout bit carry over, and Friendly tints from the journey's button colour", () => {
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
    vi.stubEnv("EMAIL_THEMES_ENABLED", "true");
    vi.stubEnv("EMAIL_WEB_FONTS_ENABLED", "true");
    vi.stubEnv("EMAIL_LAYOUT_STYLE_ENABLED", "true");
    const friendly = tenant({ emailStyle: { ...STYLE, theme: { preset: "friendly" } } });
    const journey = resolveJourneyEmailStyle(friendly, CUSTOM)!;
    expect(journey).toStrictEqual({
      logo: LOGO,
      name: null,
      altName: "Example Co",
      ...CUSTOM,
      theme: { preset: "friendly", headingFont: "poppins", bodyFont: "nunito", webFontOrigin: "https://app.example.com" },
      layouts: true,
    });
    expect(themeTokens(journey)!.pageColor).toBe(tint(CUSTOM.accentColor, 0.94));
    expect(themeTokens(resolveEmailStyle(friendly))!.pageColor).toBe(tint(STYLE.accentColor, 0.94));
  });

  it("flag on: with no brand style saved, the journey's colours on a name band", () => {
    vi.stubEnv("EMAIL_JOURNEY_STYLE_ENABLED", "true");
    const bare = tenant({ emailStyle: undefined, emailSenderConfig: { senderName: "Example Team" } });
    expect(resolveJourneyEmailStyle(bare, CUSTOM)).toStrictEqual({
      logo: null,
      name: null,
      altName: "Example Team",
      ...CUSTOM,
    });
    expect(resolveJourneyEmailStyle(bare, undefined)).toBeNull();
  });
});
