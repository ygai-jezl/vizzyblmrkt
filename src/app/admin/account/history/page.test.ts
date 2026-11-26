import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

const { requireAdminContext, notFound } = vi.hoisted(() => ({
  requireAdminContext: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/auth/session", () => ({ requireAdminContext }));
vi.mock("next/navigation", () => ({ notFound }));
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { default: HistoryPage } = await import("./page");

const CTX = { tenantId: "ten_fernhill", region: "eu" as const, userId: "usr_maya", role: "admin" as const, source: "idtoken" as const };
type Props = { canRestore: boolean; lead: string };
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
    expect(await props()).toEqual({ canRestore: true, lead: "Changes to journeys and product catalogs for Fernhill Plants. A restore adds a new version; nothing is deleted." });
    requireAdminContext.mockResolvedValue({ ...CTX, role: "member" });
    expect((await props()).canRestore).toBe(false);
  });
});
