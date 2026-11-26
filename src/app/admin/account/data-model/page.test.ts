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

const { default: DataModelPage } = await import("./page");

const CTX = { tenantId: "ten_demo", region: "us" as const, userId: "uid_owner", role: "admin" as const, source: "idtoken" as const };

const SWITCHES = [
  "AUDIENCE_PERSON_LINKS_ENABLED",
  "AUDIENCE_ONE_VIEW_ENABLED",
  "ONTOLOGY_PERSON_IDS_ENABLED",
  "AUDIENCE_FIELDS_ENABLED",
  "AUDIENCE_FIELD_FILTERS_ENABLED",
  "AUDIENCE_VIZZY_FIELDS_ENABLED",
  "AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED",
  "SETTINGS_HISTORY_ENABLED",
  "SETTINGS_ERASE_ENABLED",
  "PLANS_ENABLED",
];

function turnOn(...names: string[]) {
  for (const n of names) process.env[n] = "true";
}

type Props = { canEdit: boolean; filters?: boolean; vizzyText?: boolean; historyTab?: boolean; eraseOwner?: boolean };
async function props(): Promise<Props> {
  return ((await DataModelPage()) as ReactElement<Props>).props;
}

describe("Settings › Data model page", () => {
  beforeEach(() => {
    store.db = new FakeFirestore();
    requireAdminContext.mockResolvedValue(CTX);
  });
  afterEach(() => {
    for (const n of SWITCHES) delete process.env[n];
    vi.clearAllMocks();
  });

  it("isn't there with fields off", async () => {
    turnOn("AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED");
    await expect(DataModelPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("says fields can filter People only while field filters are on", async () => {
    turnOn("AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED");
    expect((await props()).filters).toBe(false);
    turnOn("AUDIENCE_FIELD_FILTERS_ENABLED");
    expect((await props()).filters).toBe(true);
  });

  it("shows what Vizzy reads, and the tick for text fields, only while Vizzy's text fields are on", async () => {
    turnOn("AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED");
    expect((await props()).vizzyText).toBe(false);
    turnOn("AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED");
    // It needs Vizzy's fields.
    expect((await props()).vizzyText).toBe(false);
    turnOn("AUDIENCE_VIZZY_FIELDS_ENABLED");
    expect((await props()).vizzyText).toBe(true);
  });

  it("points the Changes box to Settings › History only while it is on", async () => {
    turnOn("AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED");
    expect((await props()).historyTab).toBe(false);
    turnOn("SETTINGS_HISTORY_ENABLED");
    expect((await props()).historyTab).toBe(true);
  });

  it("offers Erase values only to an owner of the organisation with an admin row, while erasing is on", async () => {
    turnOn("AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "SETTINGS_HISTORY_ENABLED", "PLANS_ENABLED");
    const db = store.db as FakeFirestore;
    const T = "2026-11-01T00:00:00.000Z";
    db.seed("tenants", "ten_demo", { tenantName: "Demo", rootDomain: "demo.example", status: "active", region: "us", allowedOrigins: [], billingTier: "pro", ownerId: "uid_owner", organisationId: "org_demo", createdAt: T, updatedAt: T });
    db.seed("organisations", "org_demo", { name: "Demo Group", plan: "ultra", planSince: T, brandIds: ["ten_demo"], ownerIds: ["uid_owner"], createdBy: "uid_owner", createdAt: T, updatedAt: T });
    db.seed("tenant_users", "ten_demo_uid_owner", { tenantId: "ten_demo", userId: "uid_owner", role: "admin", joinedAt: T });
    getAdminContextWithHome.mockResolvedValue({ ctx: CTX, homeTenantId: "ten_home", homeRole: "admin" });
    expect((await props()).eraseOwner).toBe(false);
    expect(getAdminContextWithHome).not.toHaveBeenCalled();
    turnOn("SETTINGS_ERASE_ENABLED");
    expect((await props()).eraseOwner).toBe(true);
    // An owner who reaches it only as the brand they first signed in with, with no row: no erase.
    getAdminContextWithHome.mockResolvedValue({ ctx: { ...CTX, userId: "uid_other" }, homeTenantId: "ten_demo", homeRole: "admin" });
    db.seed("organisations", "org_demo", { name: "Demo Group", plan: "ultra", planSince: T, brandIds: ["ten_demo"], ownerIds: ["uid_owner", "uid_other"], createdBy: "uid_owner", createdAt: T, updatedAt: T });
    expect((await props()).eraseOwner).toBe(false);
  });

  it("lets admins change the fields and members read them", async () => {
    turnOn(...SWITCHES);
    expect((await props()).canEdit).toBe(true);
    requireAdminContext.mockResolvedValue({ ...CTX, role: "member" });
    expect((await props()).canEdit).toBe(false);
  });
});
