import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

const { requireAdminContext, getAdminContextWithHome, notFound } = vi.hoisted(() => ({
  requireAdminContext: vi.fn(),
  getAdminContextWithHome: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/auth/session", () => ({ requireAdminContext, getAdminContextWithHome }));
vi.mock("next/navigation", () => ({ notFound }));
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { default: HistoryPage } = await import("./page");

const CTX = { tenantId: "ten_fernhill", region: "eu" as const, userId: "usr_maya", role: "admin" as const, source: "idtoken" as const };
type Props = { canRestore: boolean; lead: string; eraseOwner: boolean };
const props = async () => ((await HistoryPage()) as ReactElement<Props>).props;

describe("Settings › History page", () => {
  beforeEach(() => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_fernhill", { tenantName: "Fernhill Plants", rootDomain: "fernhill.example", status: "active", region: "eu", allowedOrigins: [], billingTier: "pro", ownerId: "usr_maya", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" });
    store.db = db;
    requireAdminContext.mockResolvedValue(CTX);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("isn't there with its switch off", async () => {
    await expect(HistoryPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("names the kinds shown and the brand, and lets only admins restore", async () => {
    vi.stubEnv("SETTINGS_HISTORY_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_LIFECYCLE_ENABLED", "true");
    expect(await props()).toEqual({ canRestore: true, lead: "Changes to journeys and product catalogs for Fernhill Plants. A restore adds a new version; nothing is deleted.", eraseOwner: false });
    requireAdminContext.mockResolvedValue({ ...CTX, role: "member" });
    expect((await props()).canRestore).toBe(false);
  });

  it("offers Erase values only to an owner of the organisation with an admin row, while erasing is on", async () => {
    for (const n of ["SETTINGS_HISTORY_ENABLED", "AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "PLANS_ENABLED"]) vi.stubEnv(n, "true");
    const db = store.db as FakeFirestore;
    const T = "2026-11-01T00:00:00.000Z";
    db.seed("tenants", "ten_fernhill", { tenantName: "Fernhill Plants", rootDomain: "fernhill.example", status: "active", region: "eu", allowedOrigins: [], billingTier: "pro", ownerId: "usr_maya", organisationId: "org_fernhill", createdAt: T, updatedAt: T });
    db.seed("organisations", "org_fernhill", { name: "Fernhill Group", plan: "ultra", planSince: T, brandIds: ["ten_fernhill"], ownerIds: ["usr_maya"], createdBy: "usr_maya", createdAt: T, updatedAt: T });
    db.seed("tenant_users", "ten_fernhill_usr_maya", { tenantId: "ten_fernhill", userId: "usr_maya", role: "admin", joinedAt: T });
    getAdminContextWithHome.mockResolvedValue({ ctx: CTX, homeTenantId: "ten_home", homeRole: "admin" });
    expect((await props()).eraseOwner).toBe(false);
    expect(getAdminContextWithHome).not.toHaveBeenCalled();
    vi.stubEnv("SETTINGS_ERASE_ENABLED", "true");
    expect((await props()).eraseOwner).toBe(true);
    // An admin of the brand who owns nothing: no erase.
    getAdminContextWithHome.mockResolvedValue({ ctx: { ...CTX, userId: "usr_tom" }, homeTenantId: "ten_home", homeRole: "admin" });
    db.seed("tenant_users", "ten_fernhill_usr_tom", { tenantId: "ten_fernhill", userId: "usr_tom", role: "admin", joinedAt: T });
    expect((await props()).eraseOwner).toBe(false);
  });
});
