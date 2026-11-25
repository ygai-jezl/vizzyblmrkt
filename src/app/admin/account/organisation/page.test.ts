import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Settings › Organisation (Connectors 3): found only for an owner of the brand's organisation who
// is an admin of the brand they are in, read live while sharing or the join is on, and its tab
// shows only then.
// Fernhill Group [made up] owns Fernhill Plants (Europe); Priya is its owner, Leo an admin there.
const { getAdminContextWithHome, notFound } = vi.hoisted(() => ({
  getAdminContextWithHome: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/auth/session", () => ({ getAdminContextWithHome }));
vi.mock("next/navigation", () => ({ notFound, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/admin/account/organisation" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const dbs = vi.hoisted(() => ({ map: {} as Record<string, unknown> }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: (id = "(default)") => dbs.map[id],
}));

const { default: OrganisationPage } = await import("./page");
const { default: OrganisationLayout } = await import("./layout");
const { AccountTabs } = await import("@/components/admin/AccountTabs");

const T0 = "2026-11-24T10:00:00.000Z";
const priya = { tenantId: "ten_fernhill", region: "eu", source: "idtoken", userId: "usr_priya", role: "admin" };
const leo = { ...priya, userId: "usr_leo" };

beforeEach(() => {
  const us = new FakeFirestore();
  dbs.map = { "(default)": us, "signups-eu": new FakeFirestore(), "signups-asia": new FakeFirestore() };
  us.seed("tenants", "ten_fernhill", { tenantName: "Fernhill Plants", rootDomain: "fernhill.example", ownerId: "usr_priya", status: "active", region: "eu", allowedOrigins: [], createdAt: T0, updatedAt: T0, organisationId: "org_ten_fernhill" });
  us.seed("organisations", "org_ten_fernhill", { name: "Fernhill Group", plan: "ultra", planSince: T0, brandIds: ["ten_fernhill"], ownerIds: ["usr_priya"], createdBy: "usr_priya", createdAt: T0, updatedAt: T0 });
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("PLANS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
  getAdminContextWithHome.mockResolvedValue({ ctx: priya, homeTenantId: "ten_fernhill", homeRole: "admin" });
});
afterEach(() => vi.unstubAllEnvs());

const open = () => OrganisationPage({ searchParams: Promise.resolve({}) });

describe("Settings › Organisation", () => {
  it("shows Shared connections to an owner who is an admin of the brand they are in", async () => {
    await expect(OrganisationLayout({ children: null })).resolves.toBeTruthy();
    const html = renderToStaticMarkup((await open()) as ReactElement);
    expect(html).toContain("Shared connections");
    expect(html).toContain("Nothing is shared yet.");
  });

  it("is not found with sharing off, for an admin who isn't an owner, or for a member", async () => {
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "false");
    await expect(OrganisationLayout({ children: null })).rejects.toThrow("NEXT_NOT_FOUND");
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
    getAdminContextWithHome.mockResolvedValue({ ctx: leo, homeTenantId: "ten_fernhill", homeRole: "admin" });
    await expect(open()).rejects.toThrow("NEXT_NOT_FOUND");
    getAdminContextWithHome.mockResolvedValue({ ctx: { ...priya, role: "member" }, homeTenantId: "ten_fernhill", homeRole: "member" });
    await expect(open()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows Brands below Shared connections with the join on too", async () => {
    vi.stubEnv("ORGANISATION_JOIN_ENABLED", "true");
    const html = renderToStaticMarkup((await open()) as ReactElement);
    expect(html.indexOf("Shared connections")).toBeGreaterThan(-1);
    expect(html.indexOf("Bring in a brand you run")).toBeGreaterThan(html.indexOf("Shared connections"));
    expect(html).toContain('aria-label="Brands in Fernhill Group"');
  });

  it("with only the join on: Brands alone, for the same owners; with both off, no page", async () => {
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "false");
    vi.stubEnv("ORGANISATION_JOIN_ENABLED", "true");
    await expect(OrganisationLayout({ children: null })).resolves.toBeTruthy();
    const html = renderToStaticMarkup((await open()) as ReactElement);
    expect(html).toContain("Bring in a brand you run");
    expect(html).not.toContain("Shared connections");
    getAdminContextWithHome.mockResolvedValue({ ctx: leo, homeTenantId: "ten_fernhill", homeRole: "admin" });
    await expect(open()).rejects.toThrow("NEXT_NOT_FOUND");
    getAdminContextWithHome.mockResolvedValue({ ctx: priya, homeTenantId: "ten_fernhill", homeRole: "admin" });
    // The join needs plans on.
    vi.stubEnv("PLANS_ENABLED", "false");
    await expect(OrganisationLayout({ children: null })).rejects.toThrow("NEXT_NOT_FOUND");
    vi.stubEnv("PLANS_ENABLED", "true");
    vi.stubEnv("ORGANISATION_JOIN_ENABLED", "false");
    await expect(OrganisationLayout({ children: null })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("has a tab after the others only when the layout works out that it may", () => {
    const tabs = (organisation: boolean) => renderToStaticMarkup(AccountTabs({ dataModel: true, organisation }));
    expect(tabs(true)).toMatch(/Data model<\/a><a href="\/admin\/account\/organisation"[^>]*>Organisation<\/a>/);
    expect(tabs(false)).not.toContain("Organisation");
  });
});
