import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireAdminContext, getTenantById } = vi.hoisted(() => ({
  requireAdminContext: vi.fn(),
  getTenantById: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ requireAdminContext }));
vi.mock("@/lib/tenant", () => ({ getTenantById }));

const { default: AccountSettingsPage } = await import("./page");
const { SIGN_IN_SECURITY_COPY } = await import("@/components/admin/SignInSecurityCard");

const CTX = { tenantId: "ten_demo", region: "us" as const, userId: "uid_owner", role: "admin" as const, source: "idtoken" as const };

const SWITCHES = [
  "PASSWORD_SIGNIN_ENABLED",
  "NEXT_PUBLIC_NAV_V2_ENABLED",
  "NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED",
  "NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED",
  "NEXT_PUBLIC_SEARCH_ENABLED",
  "BRAND_SIGNALS_ENABLED",
];

function phase3On() {
  process.env.NEXT_PUBLIC_NAV_V2_ENABLED = "true";
  process.env.NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED = "true";
  process.env.NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED = "true";
}

async function renderPage(): Promise<string> {
  return renderToStaticMarkup((await AccountSettingsPage()) as ReactElement).replace(/&#x27;/g, "'");
}

describe("Settings › General, Sign-in and security", () => {
  beforeEach(() => {
    for (const name of SWITCHES) delete process.env[name];
    requireAdminContext.mockResolvedValue(CTX);
    getTenantById.mockResolvedValue({ tenantName: "Acme", rootDomain: "acme.example.com" });
  });
  afterEach(() => {
    for (const name of SWITCHES) delete process.env[name];
    vi.clearAllMocks();
  });

  it("has no card with the switch off, on either navigation", async () => {
    const legacy = await renderPage();
    expect(legacy).not.toContain(SIGN_IN_SECURITY_COPY.title);
    expect(legacy).not.toContain(SIGN_IN_SECURITY_COPY.signOutEverywhere);
    // Today's page: the languages card alone, with no wrapper.
    expect(legacy).not.toContain('class="space-y-6"');

    phase3On();
    const general = await renderPage();
    expect(general).toContain("Brand details");
    expect(general).not.toContain(SIGN_IN_SECURITY_COPY.title);
  });

  it("reads the switch as exactly \"true\"", async () => {
    for (const value of ["1", "TRUE", "yes", ""]) {
      process.env.PASSWORD_SIGNIN_ENABLED = value;
      expect(await renderPage(), value).not.toContain(SIGN_IN_SECURITY_COPY.title);
    }
  });

  it("shows the card under the languages with the switch on and the old navigation", async () => {
    process.env.PASSWORD_SIGNIN_ENABLED = "true";
    const html = await renderPage();
    expect(html).toContain(SIGN_IN_SECURITY_COPY.title);
    expect(html).toContain(SIGN_IN_SECURITY_COPY.signOutEverywhere);
    expect(html).toContain(SIGN_IN_SECURITY_COPY.devicesNote);
    // The languages card still renders first (its own loading line), then the new card.
    expect(html.indexOf("Loading…")).toBeLessThan(html.indexOf(SIGN_IN_SECURITY_COPY.title));
    expect(html).not.toContain("Brand details");
  });

  it("puts the card under Brand details in Settings › General, and leaves the rest as it was", async () => {
    process.env.PASSWORD_SIGNIN_ENABLED = "true";
    phase3On();
    const html = await renderPage();
    const details = html.indexOf("Brand details");
    const security = html.indexOf(SIGN_IN_SECURITY_COPY.title);
    expect(details).toBeGreaterThan(-1);
    expect(security).toBeGreaterThan(details);
    for (const text of ["Acme", "acme.example.com", "United States (can't be changed)", "ten_demo"]) {
      expect(html).toContain(text);
    }
    expect(getTenantById).toHaveBeenCalledWith("ten_demo");
  });
});
