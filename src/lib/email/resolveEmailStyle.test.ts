import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantSchema, type StoredEmailStyle, type Tenant } from "@/lib/types/tenant";
import { resolveEmailStyle } from "./resolveEmailStyle";

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
