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
